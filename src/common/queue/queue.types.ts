// Job queue contract (plan §8). Backed by BullMQ when REDIS_URL is set, otherwise by an
// in-process runner (dev and tests). Producers and processors depend only on this file.

export const QUEUE_SERVICE = Symbol('QUEUE_SERVICE');

export type QueueName =
  | 'attempt'
  | 'tts-pregen'
  | 'email'
  | 'ai-draft'
  | 'purge'
  | 'export'
  | 'erasure-hide'
  | 'erasure-purge'
  | 'retention-update';

export type JobOptions = {
  /** Deduplicates: a second add with the same id while the first exists is a no-op. */
  jobId?: string;
  delayMs?: number;
  /** Total tries including the first. Default 1. */
  attempts?: number;
  /** Exponential backoff base. Default 1000. */
  backoffMs?: number;
};

export type ProcessOptions = {
  concurrency?: number;
  /** At most `max` jobs per `durationMs` across all workers (BullMQ limiter); in-process runs ignore it. */
  limiter?: { max: number; durationMs: number };
};

/**
 * Thrown by a handler for a failure that retrying can't fix (e.g. a recipient the mail provider
 * rejects). The job fails at once instead of using its remaining attempts.
 */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export type JobHandler<T = unknown, R = unknown> = (
  data: T,
  meta: { jobId: string; attempt: number },
) => Promise<R>;

/** AI draft terminal status expires after 24 h, or earlier at 100 outcomes per status. */
export const JOB_OUTCOME_TTL_MS = 24 * 60 * 60 * 1000;
export const JOB_OUTCOME_LIMIT = 100;

export type QueueJob<T = unknown, R = unknown> =
  | { data: T; status: 'queued' | 'running' | 'failed' }
  | { data: T; status: 'done'; result: R };

export interface QueueService {
  add<T>(
    queue: QueueName,
    data: T,
    opts?: JobOptions,
  ): Promise<{ jobId: string }>;
  /** Internal lookup; authorize access before exposing data. Only ai-draft guarantees terminal retention. */
  getJob<T = unknown, R = unknown>(
    queue: QueueName,
    id: string,
  ): Promise<QueueJob<T, R> | null>;
  /**
   * Adds a job and waits up to `timeoutMs` for its result. Resolves `{done: false}` on timeout;
   * the job keeps running. Used by AI drafting (plan §7: wait 15 s, else 202).
   */
  addAndWait<T, R>(
    queue: QueueName,
    data: T,
    timeoutMs: number,
    opts?: JobOptions,
  ): Promise<{ done: true; result: R } | { done: false; jobId: string }>;
  /** Registers the processor for a queue. One per queue. Call from onModuleInit. */
  process<T, R>(
    queue: QueueName,
    handler: JobHandler<T, R>,
    opts?: ProcessOptions,
  ): void;
  /** Removes waiting or delayed jobs whose id starts with the prefix (erasure cancels a user's jobs). */
  removeByPrefix(queue: QueueName, jobIdPrefix: string): Promise<number>;
}
