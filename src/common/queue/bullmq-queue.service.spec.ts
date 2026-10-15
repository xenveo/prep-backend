import type { RedisService } from '../infra/redis.service.js';
import { BullMqQueueService } from './bullmq-queue.service.js';
import { JOB_OUTCOME_LIMIT, JOB_OUTCOME_TTL_MS } from './queue.types.js';

const mocks = vi.hoisted(() => ({ getJob: vi.fn(), add: vi.fn() }));
vi.mock('bullmq', () => ({
  Queue: class {
    getJob = mocks.getJob;
    add = mocks.add;
  },
  QueueEvents: class {},
  Worker: class {},
}));

describe('BullMqQueueService job status', () => {
  const now = new Date('2026-10-15T10:00:00Z');
  const data = { adminId: 'admin-1' };
  let service: BullMqQueueService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.clearAllMocks();
    service = new BullMqQueueService({ client: {} } as RedisService, 'api');
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

  it('preserves existing retention for queues other than AI drafting', async () => {
    mocks.add.mockResolvedValue({ id: '42' });
    await service.add('email', { to: 'private' });
    expect(mocks.add).toHaveBeenCalledWith(
      'email',
      { to: 'private' },
      expect.objectContaining({
        removeOnComplete: { count: 100 },
        removeOnFail: { age: 24 * 3600 },
      }),
    );
  });
});
