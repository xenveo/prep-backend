import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue, QueueEvents, Worker, type JobsOptions } from 'bullmq';
import type { Env } from '../../config/env.js';
import type { RedisService } from '../infra/redis.service.js';
import { assertJobId } from './job-id.js';
import { JOB_OUTCOME_LIMIT, JOB_OUTCOME_TTL_MS } from './queue.types.js';
import type {
  JobHandler,
  JobOptions,
  QueueJob,
  QueueName,
  QueueService,
} from './queue.types.js';

/** Redis-backed QueueService (plan §8). Workers only start where PROCESS_ROLE is `worker` or `all`. */
export class BullMqQueueService implements QueueService, OnModuleDestroy {
  private readonly logger = new Logger('Queue');
  private readonly queues = new Map<QueueName, Queue>();
  private readonly events = new Map<QueueName, QueueEvents>();
  private readonly workers = new Map<QueueName, Worker>();

  constructor(
    private readonly redis: RedisService,
    private readonly role: Env['PROCESS_ROLE'],
  ) {}

  async add<T>(
    queue: QueueName,
    data: T,
    opts: JobOptions = {},
  ): Promise<{ jobId: string }> {
    const job = await this.queue(queue).add(
      queue,
      data,
      this.jobOptions(queue, opts),
    );
    return { jobId: job.id! };
  }

  async addAndWait<T, R>(
    queue: QueueName,
    data: T,
    timeoutMs: number,
    opts: JobOptions = {},
  ): Promise<{ done: true; result: R } | { done: false; jobId: string }> {
    const events = this.queueEvents(queue);
    await events.waitUntilReady();
    const job = await this.queue(queue).add(
      queue,
      data,
      this.jobOptions(queue, opts),
    );
    const jobId = job.id!;

    // The ttl outlives our own timer so the race below always resolves through it; the late
    // rejection that follows is swallowed.
    const finished = job
      .waitUntilFinished(events, timeoutMs + 1000)
      .then((result) => ({ done: true as const, result: result as R }));
    finished.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<{ done: false; jobId: string }>((resolve) => {
      timer = setTimeout(() => resolve({ done: false, jobId }), timeoutMs);
    });
    try {
      return await Promise.race([finished, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  async getJob<T = unknown, R = unknown>(
    queue: QueueName,
    id: string,
  ): Promise<QueueJob<T, R> | null> {
    const job = await this.queue(queue).getJob(id);
    if (!job) return null;
    const status = await job.getState();
    if (status === 'unknown') return null;
    // BullMQ age cleanup runs lazily on completion. Enforce expiry on reads too.
    if (status === 'completed' || status === 'failed') {
      // getState reads Redis after getJob hydrated its snapshot. A worker may have finished
      // between those calls, so reload terminal fields before returning status/results.
      const terminal = await this.queue(queue).getJob(id);
      if (
        !terminal ||
        terminal.finishedOn === undefined ||
        terminal.finishedOn + JOB_OUTCOME_TTL_MS <= Date.now()
      )
        return null;
      return status === 'completed'
        ? {
            data: terminal.data as T,
            status: 'done',
            result: terminal.returnvalue as R,
          }
        : { data: terminal.data as T, status: 'failed' };
    }
    return {
      data: job.data as T,
      status: status === 'active' ? 'running' : 'queued',
    };
  }

  process<T, R>(
    queue: QueueName,
    handler: JobHandler<T, R>,
    opts: { concurrency?: number } = {},
  ): void {
    if (this.role === 'api') return;
    if (this.workers.has(queue))
      throw new Error(`A processor is already registered for queue ${queue}`);
    const worker = new Worker(
      queue,
      (job) =>
        handler(job.data as T, {
          jobId: job.id!,
          attempt: job.attemptsMade + 1,
        }),
      {
        connection: this.redis.duplicate({ maxRetriesPerRequest: null }),
        concurrency: Math.max(1, opts.concurrency ?? 1),
      },
    );
    worker.on('failed', (job, err) => {
      this.logger.warn(
        `Job failed: queue=${queue} jobId=${job?.id ?? '?'} attempt=${job?.attemptsMade ?? '?'} (${err.name})`,
      );
    });
    worker.on('error', (err) =>
      this.logger.error(`Worker error: queue=${queue} (${err.name})`),
    );
    this.workers.set(queue, worker);
  }

  async removeByPrefix(queue: QueueName, jobIdPrefix: string): Promise<number> {
    const jobs = await this.queue(queue).getJobs([
      'waiting',
      'delayed',
      'prioritized',
    ]);
    let removed = 0;
    for (const job of jobs) {
      if (!job.id?.startsWith(jobIdPrefix)) continue;
      try {
        await job.remove();
        removed++;
      } catch {
        // Picked up by a worker meanwhile (locked): it runs to completion.
      }
    }
    return removed;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.workers.values()].map((w) => w.close()));
    await Promise.allSettled(
      [...this.events.values(), ...this.queues.values()].map((c) => c.close()),
    );
  }

  private jobOptions(queue: QueueName, opts: JobOptions): JobsOptions {
    assertJobId(opts.jobId);
    return {
      jobId: opts.jobId,
      delay: opts.delayMs,
      attempts: Math.max(1, opts.attempts ?? 1),
      backoff: { type: 'exponential', delay: opts.backoffMs ?? 1000 },
      removeOnComplete:
        queue === 'ai-draft'
          ? { age: JOB_OUTCOME_TTL_MS / 1000, count: JOB_OUTCOME_LIMIT }
          : { count: 100 },
      removeOnFail:
        queue === 'ai-draft'
          ? { age: JOB_OUTCOME_TTL_MS / 1000, count: JOB_OUTCOME_LIMIT }
          : { age: 24 * 3600 },
    };
  }

  private queue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.redis.client! });
      this.queues.set(name, queue);
    }
    return queue;
  }

  private queueEvents(name: QueueName): QueueEvents {
    let events = this.events.get(name);
    if (!events) {
      events = new QueueEvents(name, {
        connection: this.redis.duplicate({ maxRetriesPerRequest: null }),
      });
      this.events.set(name, events);
    }
    return events;
  }
}
