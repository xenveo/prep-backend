import { UnrecoverableError } from 'bullmq';
import type { RedisService } from '../infra/redis.service.js';
import { BullMqQueueService } from './bullmq-queue.service.js';
import {
  JOB_OUTCOME_LIMIT,
  JOB_OUTCOME_TTL_MS,
  PermanentJobError,
} from './queue.types.js';

type Processor = (job: {
  id: string;
  data: unknown;
  attemptsMade: number;
}) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  getJob: vi.fn(),
  add: vi.fn(),
  queues: [] as { name: string; opts: { prefix?: string } }[],
  events: [] as { name: string; opts: { prefix?: string } }[],
  workers: [] as {
    name: string;
    processor: Processor;
    opts: Record<string, unknown>;
  }[],
}));
vi.mock('bullmq', () => ({
  Queue: class {
    getJob = mocks.getJob;
    add = mocks.add;
    on = vi.fn();
    constructor(name: string, opts: { prefix?: string }) {
      mocks.queues.push({ name, opts });
    }
  },
  QueueEvents: class {
    waitUntilReady = () => Promise.resolve();
    on = vi.fn();
    constructor(name: string, opts: { prefix?: string }) {
      mocks.events.push({ name, opts });
    }
  },
  Worker: class {
    on = vi.fn();
    constructor(
      name: string,
      processor: Processor,
      opts: Record<string, unknown>,
    ) {
      mocks.workers.push({ name, processor, opts });
    }
  },
  UnrecoverableError: class extends Error {
    name = 'UnrecoverableError';
  },
}));

const redis = {
  client: {},
  prefix: 'preppilot',
  duplicate: () => ({}),
} as unknown as RedisService;

describe('BullMqQueueService job status', () => {
  const now = new Date('2026-10-15T10:00:00Z');
  const data = { adminId: 'admin-1' };
  let service: BullMqQueueService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.clearAllMocks();
    service = new BullMqQueueService(redis, 'api');
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ['waiting', 'queued'],
    ['delayed', 'queued'],
    ['prioritized', 'queued'],
    ['waiting-children', 'queued'],
    ['active', 'running'],
  ])('maps Redis %s to %s', async (state, status) => {
    mocks.getJob.mockResolvedValue({
      data,
      getState: vi.fn().mockResolvedValue(state),
    });
    await expect(service.getJob('ai-draft', '42')).resolves.toEqual({
      data,
      status,
    });
    expect(mocks.getJob).toHaveBeenCalledWith('42');
  });

  it('returns exact completed results, with owner data available only to the caller', async () => {
    const result = [{ id: 'card-1' }];
    mocks.getJob.mockResolvedValue({
      data,
      returnvalue: result,
      finishedOn: now.getTime(),
      getState: vi.fn().mockResolvedValue('completed'),
    });
    await expect(service.getJob('ai-draft', '42')).resolves.toEqual({
      data,
      status: 'done',
      result,
    });
  });

  it('returns terminal failures without provider errors', async () => {
    mocks.getJob.mockResolvedValue({
      data,
      failedReason: 'private provider response',
      finishedOn: now.getTime(),
      getState: vi.fn().mockResolvedValue('failed'),
    });
    await expect(service.getJob('ai-draft', '42')).resolves.toEqual({
      data,
      status: 'failed',
    });
  });

  it.each(['completed', 'failed'])(
    'reloads a job that turns %s after the initial snapshot',
    async (status) => {
      const result = [{ id: 'card-1' }];
      mocks.getJob
        .mockResolvedValueOnce({
          data,
          // Snapshot was active; state lookup now observes the worker's completed transition.
          getState: vi.fn().mockResolvedValue(status),
        })
        .mockResolvedValueOnce({
          data,
          returnvalue: result,
          finishedOn: now.getTime(),
        });
      await expect(service.getJob('ai-draft', '42')).resolves.toEqual(
        status === 'completed'
          ? { data, status: 'done', result }
          : { data, status: 'failed' },
      );
      expect(mocks.getJob).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['completed', 'failed'])(
    'hides expired %s jobs even before lazy Redis cleanup',
    async (state) => {
      mocks.getJob.mockResolvedValue({
        data,
        returnvalue: [],
        finishedOn: now.getTime(),
        getState: vi.fn().mockResolvedValue(state),
      });
      vi.advanceTimersByTime(JOB_OUTCOME_TTL_MS - 1);
      expect(await service.getJob('ai-draft', '42')).not.toBeNull();
      vi.advanceTimersByTime(1);
      await expect(service.getJob('ai-draft', '42')).resolves.toBeNull();
    },
  );

  it('returns null for a missing job or one removed during lookup', async () => {
    mocks.getJob.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      getState: vi.fn().mockResolvedValue('unknown'),
    });
    await expect(service.getJob('ai-draft', '42')).resolves.toBeNull();
    await expect(service.getJob('ai-draft', '42')).resolves.toBeNull();
  });

  it('configures both count and age retention for completed and failed jobs', async () => {
    mocks.add.mockResolvedValue({ id: '42' });
    await expect(service.add('ai-draft', data)).resolves.toEqual({
      jobId: '42',
    });
    const retention = {
      age: JOB_OUTCOME_TTL_MS / 1000,
      count: JOB_OUTCOME_LIMIT,
    };
    expect(mocks.add).toHaveBeenCalledWith(
      'ai-draft',
      data,
      expect.objectContaining({
        removeOnComplete: retention,
        removeOnFail: retention,
      }),
    );
  });

  it('keeps other finished jobs for 24 h (completed) and 7 days (failed)', async () => {
    mocks.add.mockResolvedValue({ id: '42' });
    await service.add('email', { emailId: 'e1' });
    expect(mocks.add).toHaveBeenCalledWith(
      'email',
      { emailId: 'e1' },
      expect.objectContaining({
        removeOnComplete: { age: 24 * 3600 },
        removeOnFail: { age: 7 * 24 * 3600 },
      }),
    );
  });
});

describe('BullMqQueueService Redis namespacing and workers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queues.length = 0;
    mocks.events.length = 0;
    mocks.workers.length = 0;
    mocks.add.mockResolvedValue({
      id: 'j1',
      waitUntilFinished: () => new Promise(() => undefined),
    });
  });

  it('puts every Queue, QueueEvents and Worker under the app prefix', async () => {
    const service = new BullMqQueueService(redis, 'all');
    await service.add('export', { exportJobId: 'x' });
    await service.addAndWait('ai-draft', {}, 1);
    service.process('attempt', () => Promise.resolve());
    const all = [...mocks.queues, ...mocks.events, ...mocks.workers];
    expect(all.map((c) => c.name).sort()).toEqual([
      'ai-draft',
      'ai-draft',
      'attempt',
      'export',
    ]);
    for (const c of all) expect(c.opts.prefix).toBe('preppilot');
  });

  it('passes the limiter to the worker in BullMQ form', () => {
    const service = new BullMqQueueService(redis, 'worker');
    service.process('email', () => Promise.resolve(), {
      concurrency: 3,
      limiter: { max: 2, durationMs: 1000 },
    });
    service.process('export', () => Promise.resolve());
    expect(mocks.workers[0].opts).toMatchObject({
      concurrency: 3,
      limiter: { max: 2, duration: 1000 },
    });
    expect(mocks.workers[1].opts.limiter).toBeUndefined();
  });

  it('turns a PermanentJobError into an UnrecoverableError and passes other errors through', async () => {
    const service = new BullMqQueueService(redis, 'worker');
    const transient = new Error('try again');
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new PermanentJobError('rejected recipient'))
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce('ok');
    service.process('email', handler);
    const run = mocks.workers[0].processor;
    const job = { id: 'email-1', data: { emailId: 'e1' }, attemptsMade: 0 };

    const permanent = await run(job).catch((e: unknown) => e);
    expect(permanent).toBeInstanceOf(UnrecoverableError);
    expect((permanent as Error).message).toBe('rejected recipient');
    await expect(run(job)).rejects.toBe(transient);
    await expect(run({ ...job, attemptsMade: 2 })).resolves.toBe('ok');
    expect(handler).toHaveBeenLastCalledWith(
      { emailId: 'e1' },
      { jobId: 'email-1', attempt: 3 },
    );
  });

  it('starts no worker in the api role', () => {
    new BullMqQueueService(redis, 'api').process('email', () =>
      Promise.resolve(),
    );
    expect(mocks.workers).toEqual([]);
  });
});
