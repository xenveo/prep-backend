import { InMemoryQueueService } from './in-memory-queue.service.js';
import { Logger } from '@nestjs/common';
import {
  JOB_OUTCOME_LIMIT,
  JOB_OUTCOME_TTL_MS,
  PermanentJobError,
} from './queue.types.js';

const tick = () => new Promise((r) => setImmediate(r));

describe('InMemoryQueueService', () => {
  let queue: InMemoryQueueService;

  beforeEach(() => {
    queue = new InMemoryQueueService('all');
  });

  afterEach(() => {
    queue.onModuleDestroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs a job asynchronously, never inside add', async () => {
    const seen: unknown[] = [];
    queue.process('email', async (data) => {
      seen.push(data);
    });
    const added = queue.add('email', { to: 'x' });
    expect(seen).toEqual([]);
    await added;
    await queue.drain();
    expect(seen).toEqual([{ to: 'x' }]);
  });

  it('holds jobs added before the processor registers', async () => {
    const seen: string[] = [];
    await queue.add('email', 'a');
    await tick();
    queue.process('email', async (d: string) => {
      seen.push(d);
    });
    await queue.drain();
    expect(seen).toEqual(['a']);
  });

  it('retries with exponential backoff and reports the attempt number', async () => {
    vi.useFakeTimers();
    const attempts: number[] = [];
    queue.process('attempt', async (_d, meta) => {
      attempts.push(meta.attempt);
      if (meta.attempt < 3) throw new Error('boom');
      return 'ok';
    });
    const done = queue.addAndWait('attempt', {}, 60_000, {
      attempts: 3,
      backoffMs: 100,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toEqual([1]);
    await vi.advanceTimersByTimeAsync(99);
    expect(attempts).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(199);
    expect(attempts).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toEqual([1, 2, 3]);
    await expect(done).resolves.toEqual({ done: true, result: 'ok' });
  });

  it('rejects addAndWait once all attempts fail', async () => {
    queue.process('attempt', async () => {
      throw new Error('nope');
    });
    await expect(
      queue.addAndWait('attempt', {}, 1000, { attempts: 2, backoffMs: 1 }),
    ).rejects.toThrow('nope');
  });

  it('does not retry a PermanentJobError', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let runs = 0;
    queue.process('email', async () => {
      runs++;
      throw new PermanentJobError('rejected recipient');
    });
    await expect(
      queue.addAndWait('email', {}, 1000, { attempts: 3, backoffMs: 1 }),
    ).rejects.toBeInstanceOf(PermanentJobError);
    await queue.drain();
    expect(runs).toBe(1);
  });

  it('ignores the rate limiter in-process', async () => {
    let runs = 0;
    queue.process(
      'email',
      async () => {
        runs++;
      },
      { limiter: { max: 1, durationMs: 60_000 } },
    );
    await Promise.all([queue.add('email', 1), queue.add('email', 2)]);
    await queue.drain();
    expect(runs).toBe(2);
  });

  it('dedupes by jobId while the job is pending', async () => {
    let runs = 0;
    queue.process('email', async () => {
      runs++;
    });
    const a = await queue.add('email', 1, { jobId: 'invite-u1' });
    const b = await queue.add('email', 2, { jobId: 'invite-u1' });
    expect(a).toEqual(b);
    await queue.drain();
    expect(runs).toBe(1);
    await queue.add('email', 3, { jobId: 'invite-u1' });
    await queue.drain();
    expect(runs).toBe(2);
  });

  it('rejects job ids BullMQ would reject', async () => {
    await expect(queue.add('email', 1, { jobId: 'user:1' })).rejects.toThrow(
      /':'/,
    );
    await expect(queue.add('email', 1, { jobId: '42' })).rejects.toThrow(
      /integer/,
    );
  });

  it('delays jobs', async () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    queue.process('purge', async (d: number) => {
      seen.push(d);
    });
    await queue.add('purge', 1, { delayMs: 500 });
    await vi.advanceTimersByTimeAsync(499);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual([1]);
  });

  it('respects the concurrency limit', async () => {
    let running = 0;
    let peak = 0;
    queue.process(
      'tts-pregen',
      async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
      },
      { concurrency: 2 },
    );
    await Promise.all([1, 2, 3, 4, 5].map((n) => queue.add('tts-pregen', n)));
    await queue.drain();
    expect(peak).toBe(2);
  });

  it('addAndWait returns the result, or the jobId on timeout while the job keeps running', async () => {
    queue.process('ai-draft', async (d: number) => {
      await new Promise((r) => setTimeout(r, d));
      return d * 2;
    });
    await expect(queue.addAndWait('ai-draft', 1, 1000)).resolves.toEqual({
      done: true,
      result: 2,
    });
    const slow = await queue.addAndWait('ai-draft', 50, 5, {
      jobId: 'draft-1',
    });
    expect(slow).toEqual({ done: false, jobId: 'draft-1' });
    let finished = false;
    void queue.drain().then(() => (finished = true));
    await new Promise((r) => setTimeout(r, 80));
    expect(finished).toBe(true);
  });

  it('removeByPrefix drops waiting and delayed jobs only', async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    let release!: () => void;
    queue.process('attempt', async (d: string) => {
      seen.push(d);
      if (d === 'running') await new Promise<void>((r) => (release = r));
    });
    await queue.add('attempt', 'running', { jobId: 'u1-running' });
    await vi.advanceTimersByTimeAsync(0);
    await queue.add('attempt', 'waiting', { jobId: 'u1-waiting' });
    await queue.add('attempt', 'delayed', {
      jobId: 'u1-delayed',
      delayMs: 100,
    });
    await queue.add('attempt', 'other', { jobId: 'u2-waiting' });

    await expect(queue.removeByPrefix('attempt', 'u1-')).resolves.toBe(2);
    release();
    await vi.advanceTimersByTimeAsync(200);
    await queue.drain();
    expect(seen).toEqual(['running', 'other']);
  });

  it('drain resolves immediately when idle and ignores queues without a processor', async () => {
    await queue.add('export', 1);
    await expect(queue.drain()).resolves.toBeUndefined();
  });

  it('process is a no-op in the api role', async () => {
    const api = new InMemoryQueueService('api');
    const handler = vi.fn(async () => undefined);
    api.process('email', handler);
    await api.add('email', 1);
    await tick();
    expect(handler).not.toHaveBeenCalled();
    api.onModuleDestroy();
  });

  it('refuses a second processor for the same queue', () => {
    queue.process('email', async () => undefined);
    expect(() => queue.process('email', async () => undefined)).toThrow();
  });

  it('exposes queued, running, and completed jobs without removing results on drain', async () => {
    const data = { adminId: 'admin-1' };
    const { jobId } = await queue.add('ai-draft', data);
    await expect(queue.getJob('ai-draft', jobId)).resolves.toEqual({
      status: 'queued',
      data,
    });
    let finish!: (result: unknown[]) => void;
    queue.process(
      'ai-draft',
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await tick();
    await expect(queue.getJob('ai-draft', jobId)).resolves.toEqual({
      status: 'running',
      data,
    });
    const result = [{ id: 'card-1' }];
    finish(result);
    await queue.drain();
    await expect(queue.getJob('ai-draft', jobId)).resolves.toEqual({
      status: 'done',
      data,
      result,
    });
    await expect(queue.getJob('ai-draft', 'unknown')).resolves.toBeNull();
  });

  it('shows retries as queued and retains final failures without error messages', async () => {
    vi.useFakeTimers();
    const data = { adminId: 'admin-1' };
    queue.process('ai-draft', async () => {
      throw new Error('private provider details');
    });
    const { jobId } = await queue.add('ai-draft', data, {
      attempts: 2,
      backoffMs: 100,
    });
    await vi.advanceTimersByTimeAsync(0);
    await expect(queue.getJob('ai-draft', jobId)).resolves.toEqual({
      status: 'queued',
      data,
    });
    await vi.advanceTimersByTimeAsync(100);
    await queue.drain();
    await expect(queue.getJob('ai-draft', jobId)).resolves.toEqual({
      status: 'failed',
      data,
    });
  });

  it('expires completed and failed outcomes after 24 hours', async () => {
    vi.useFakeTimers();
    queue.process('ai-draft', async (fail: boolean) => {
      if (fail) throw new Error('unavailable');
      return [];
    });
    const completed = await queue.add('ai-draft', false);
    const failed = await queue.add('ai-draft', true);
    await vi.advanceTimersByTimeAsync(0);
    await queue.drain();
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(JOB_OUTCOME_TTL_MS - 1);
    expect((await queue.getJob('ai-draft', completed.jobId))?.status).toBe(
      'done',
    );
    expect((await queue.getJob('ai-draft', failed.jobId))?.status).toBe(
      'failed',
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
    await expect(queue.getJob('ai-draft', completed.jobId)).resolves.toBeNull();
    await expect(queue.getJob('ai-draft', failed.jobId)).resolves.toBeNull();
  });

  it.each([false, true])(
    'bounds retained outcomes per terminal status (failure=%s)',
    async (fail) => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      queue.process('ai-draft', async () => {
        if (fail) throw new Error('unavailable');
        return [];
      });
      for (let index = 0; index <= JOB_OUTCOME_LIMIT; index++) {
        await queue.add('ai-draft', {}, { jobId: `draft-${index}` });
      }
      await queue.drain();
      await expect(queue.getJob('ai-draft', 'draft-0')).resolves.toBeNull();
      expect(
        (await queue.getJob('ai-draft', `draft-${JOB_OUTCOME_LIMIT}`))?.status,
      ).toBe(fail ? 'failed' : 'done');
    },
  );

  it.each(['email', 'attempt', 'export'] as const)(
    'does not retain terminal %s payloads',
    async (name) => {
      queue.process(name, async () => ({ privateResult: 'personal data' }));
      const { jobId } = await queue.add(name, {
        privateInput: 'personal data',
      });
      await queue.drain();
      await expect(queue.getJob(name, jobId)).resolves.toBeNull();
    },
  );

  it('removes completed outcomes on shutdown', async () => {
    queue.process('ai-draft', async () => []);
    const { jobId } = await queue.add('ai-draft', {});
    await queue.drain();
    queue.onModuleDestroy();
    await expect(queue.getJob('ai-draft', jobId)).resolves.toBeNull();
  });
});
