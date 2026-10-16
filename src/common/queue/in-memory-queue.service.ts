import { randomUUID } from 'node:crypto';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import type { Env } from '../../config/env.js';
import { assertJobId } from './job-id.js';
import {
  JOB_OUTCOME_LIMIT,
  JOB_OUTCOME_TTL_MS,
  PermanentJobError,
} from './queue.types.js';
import type {
  JobHandler,
  JobOptions,
  ProcessOptions,
  QueueJob,
  QueueName,
  QueueService,
} from './queue.types.js';

type Outcome = { ok: true; result: unknown } | { ok: false; error: unknown };

type Job = {
  id: string;
  data: unknown;
  maxAttempts: number;
  backoffMs: number;
  attempt: number;
  state: 'waiting' | 'delayed' | 'running';
  timer: NodeJS.Timeout | null;
  listeners: ((outcome: Outcome) => void)[];
};

type QueueState = {
  handler: JobHandler<any, any> | null;
  concurrency: number;
  running: number;
  ready: Job[];
  /** Every pending job (waiting, delayed or running), for jobId dedupe. */
  jobs: Map<string, Job>;
  outcomes: Map<
    string,
    { job: QueueJob; finishedAt: number; timer: NodeJS.Timeout }
  >;
};

/**
 * In-process QueueService for dev without Redis and for tests (plan §8). Same semantics as the
 * BullMQ implementation within one process: jobId dedupe while pending, delays, retries with
 * exponential backoff (none after a PermanentJobError), a per-queue concurrency limit. The rate
 * limiter is ignored. Jobs added before their processor registers wait for it. Nothing survives a
 * restart.
 */
export class InMemoryQueueService implements QueueService, OnModuleDestroy {
  private readonly logger = new Logger('Queue');
  private readonly queues = new Map<QueueName, QueueState>();
  private idleWaiters: (() => void)[] = [];
  private destroyed = false;

  constructor(private readonly role: Env['PROCESS_ROLE']) {}

  async add<T>(
    queue: QueueName,
    data: T,
    opts: JobOptions = {},
  ): Promise<{ jobId: string }> {
    return { jobId: this.enqueue(queue, data, opts).id };
  }

  async addAndWait<T, R>(
    queue: QueueName,
    data: T,
    timeoutMs: number,
    opts: JobOptions = {},
  ): Promise<{ done: true; result: R } | { done: false; jobId: string }> {
    const job = this.enqueue(queue, data, opts);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve({ done: false, jobId: job.id }),
        timeoutMs,
      );
      job.listeners.push((outcome) => {
        clearTimeout(timer);
        if (outcome.ok) resolve({ done: true, result: outcome.result as R });
        else reject(outcome.error);
      });
    });
  }

  async getJob<T = unknown, R = unknown>(
    queue: QueueName,
    id: string,
  ): Promise<QueueJob<T, R> | null> {
    const state = this.state(queue);
    this.pruneOutcomes(state);
    const pending = state.jobs.get(id);
    if (pending) {
      return {
        data: pending.data as T,
        status: pending.state === 'running' ? 'running' : 'queued',
      };
    }
    return (state.outcomes.get(id)?.job as QueueJob<T, R> | undefined) ?? null;
  }

  process<T, R>(
    queue: QueueName,
    handler: JobHandler<T, R>,
    opts: ProcessOptions = {},
  ): void {
    if (this.role === 'api') return;
    const state = this.state(queue);
    if (state.handler)
      throw new Error(`A processor is already registered for queue ${queue}`);
    state.handler = handler as JobHandler<any, any>;
    state.concurrency = Math.max(1, opts.concurrency ?? 1);
    this.schedulePump(queue);
  }

  removeByPrefix(queue: QueueName, jobIdPrefix: string): Promise<number> {
    const state = this.state(queue);
    let removed = 0;
    for (const job of state.jobs.values()) {
      if (job.state === 'running' || !job.id.startsWith(jobIdPrefix)) continue;
      if (job.timer) clearTimeout(job.timer);
      state.jobs.delete(job.id);
      removed++;
    }
    state.ready = state.ready.filter((j) => state.jobs.has(j.id));
    this.checkIdle();
    return Promise.resolve(removed);
  }

  /** Resolves once every job in a queue with a processor has finished (tests). */
  drain(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    for (const state of this.queues.values()) {
      for (const job of state.jobs.values())
        if (job.timer) clearTimeout(job.timer);
      state.jobs.clear();
      for (const outcome of state.outcomes.values())
        clearTimeout(outcome.timer);
      state.outcomes.clear();
      state.ready = [];
    }
    this.checkIdle();
  }

  private enqueue(queue: QueueName, data: unknown, opts: JobOptions): Job {
    assertJobId(opts.jobId);
    const state = this.state(queue);
    const id = opts.jobId ?? randomUUID();
    const existing = state.jobs.get(id);
    if (existing) return existing;
    // Preserve pending-only dedupe: a new job with this id replaces the previous outcome.
    this.removeOutcome(state, id);
    this.pruneOutcomes(state);

    const job: Job = {
      id,
      data,
      maxAttempts: Math.max(1, opts.attempts ?? 1),
      backoffMs: opts.backoffMs ?? 1000,
      attempt: 0,
      state: 'waiting',
      timer: null,
      listeners: [],
    };
    if (this.destroyed) return job;
    state.jobs.set(id, job);
    if (opts.delayMs && opts.delayMs > 0) this.delay(queue, job, opts.delayMs);
    else this.makeReady(queue, job);
    return job;
  }

  private delay(queue: QueueName, job: Job, ms: number): void {
    job.state = 'delayed';
    job.timer = setTimeout(() => {
      job.timer = null;
      this.makeReady(queue, job);
    }, ms);
  }

  private makeReady(queue: QueueName, job: Job): void {
    job.state = 'waiting';
    this.state(queue).ready.push(job);
    this.schedulePump(queue);
  }

  /** Handlers always start on a later tick, never inside `add`. */
  private schedulePump(queue: QueueName): void {
    queueMicrotask(() => this.pump(queue));
  }

  private pump(queue: QueueName): void {
    const state = this.state(queue);
    while (
      state.handler &&
      state.running < state.concurrency &&
      state.ready.length > 0
    ) {
      void this.run(queue, state, state.ready.shift()!);
    }
  }

  private async run(
    queue: QueueName,
    state: QueueState,
    job: Job,
  ): Promise<void> {
    job.state = 'running';
    job.attempt++;
    state.running++;
    let outcome: Outcome | null;
    try {
      outcome = {
        ok: true,
        result: await state.handler!(job.data, {
          jobId: job.id,
          attempt: job.attempt,
        }),
      };
    } catch (error) {
      const name = error instanceof Error ? error.name : typeof error;
      this.logger.warn(
        `Job failed: queue=${queue} jobId=${job.id} attempt=${job.attempt}/${job.maxAttempts} (${name})`,
      );
      const retry =
        job.attempt < job.maxAttempts && !(error instanceof PermanentJobError);
      outcome = retry ? null : { ok: false, error };
    }
    state.running--;

    if (this.destroyed) return this.checkIdle();
    if (outcome) {
      state.jobs.delete(job.id);
      if (queue === 'ai-draft') {
        const timer = setTimeout(
          () => state.outcomes.delete(job.id),
          JOB_OUTCOME_TTL_MS,
        );
        timer.unref();
        state.outcomes.set(job.id, {
          job: outcome.ok
            ? { data: job.data, status: 'done', result: outcome.result }
            : { data: job.data, status: 'failed' },
          finishedAt: Date.now(),
          timer,
        });
        this.pruneOutcomes(state);
      }
      for (const listener of job.listeners) listener(outcome);
      job.listeners = [];
    } else {
      this.delay(queue, job, job.backoffMs * 2 ** (job.attempt - 1));
    }
    this.schedulePump(queue);
    this.checkIdle();
  }

  private state(queue: QueueName): QueueState {
    let state = this.queues.get(queue);
    if (!state) {
      state = {
        handler: null,
        concurrency: 1,
        running: 0,
        ready: [],
        jobs: new Map(),
        outcomes: new Map(),
      };
      this.queues.set(queue, state);
    }
    return state;
  }

  /** Retain the latest 100 completed and 100 failed AI drafts, for at most 24 hours. */
  private pruneOutcomes(state: QueueState): void {
    const counts = { done: 0, failed: 0 };
    for (const [id, outcome] of [...state.outcomes].reverse()) {
      const status = outcome.job.status as 'done' | 'failed';
      if (
        outcome.finishedAt + JOB_OUTCOME_TTL_MS <= Date.now() ||
        ++counts[status] > JOB_OUTCOME_LIMIT
      )
        this.removeOutcome(state, id);
    }
  }

  private removeOutcome(state: QueueState, id: string): void {
    const outcome = state.outcomes.get(id);
    if (outcome) clearTimeout(outcome.timer);
    state.outcomes.delete(id);
  }

  private isIdle(): boolean {
    for (const state of this.queues.values()) {
      if (state.handler && (state.jobs.size > 0 || state.running > 0))
        return false;
    }
    return true;
  }

  private checkIdle(): void {
    if (this.idleWaiters.length === 0 || !this.isIdle()) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
