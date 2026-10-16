import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { loadConfig } from '../../config/app-config.js';
import {
  CLOSE_TIMEOUT_MS,
  closeWithin,
  ERROR_LOG_INTERVAL_MS,
  RedisService,
  SHARED_CLIENT_OPTIONS,
} from './redis.service.js';

const mocks = vi.hoisted(() => ({
  connections: [] as {
    status: string;
    options: Record<string, unknown>;
    quit: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock('ioredis', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class Redis extends Emitter {
    status = 'connecting';
    quit = vi.fn(() => Promise.resolve('OK'));
    disconnect = vi.fn();
    options: Record<string, unknown>;
    constructor(_url?: string, options: Record<string, unknown> = {}) {
      super();
      this.options = options;
      mocks.connections.push(this);
    }
    duplicate(override: Record<string, unknown> = {}) {
      return new Redis(undefined, { ...this.options, ...override });
    }
  }
  return { Redis };
});

const config = (env: Record<string, string>) =>
  loadConfig({
    DATABASE_URL: 'postgresql://x',
    AUTH_SECRET: 'a'.repeat(32),
    ...env,
  });
const refused = Object.assign(new Error('connect ECONNREFUSED'), {
  code: 'ECONNREFUSED',
});

describe('RedisService', () => {
  beforeEach(() => {
    mocks.connections.length = 0;
  });

  it('builds keys under REDIS_PREFIX, which defaults to preppilot', () => {
    const redis = new RedisService(config({}));
    expect(redis.prefix).toBe('preppilot');
    expect(redis.key('rl', 'otp', 'h1')).toBe('preppilot:rl:otp:h1');
    expect(redis.key('session:s1')).toBe('preppilot:session:s1');
  });

  it('honours a custom prefix and opens no connection without REDIS_URL', async () => {
    const redis = new RedisService(config({ REDIS_PREFIX: 'pp-staging' }));
    expect(redis.client).toBeNull();
    expect(redis.key('recovery', 'lock')).toBe('pp-staging:recovery:lock');
    await expect(redis.onModuleInit()).resolves.toBeUndefined();
  });

  describe('with REDIS_URL', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      vi.useFakeTimers();
      warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      vi.useRealTimers();
      warn.mockRestore();
    });

    const service = (env: Record<string, string> = {}) =>
      new RedisService(
        config({ REDIS_URL: 'redis://user:secret@redis:6379/2', ...env }),
      );

    it('fails shared-client commands fast in an outage; duplicates queue them, BullMQ overrides win', () => {
      const redis = service();
      redis.duplicate();
      redis.duplicate({ maxRetriesPerRequest: null });
      const [shared, subscriber, blocking] = mocks.connections;
      expect(shared.options).toEqual(SHARED_CLIENT_OPTIONS);
      expect(SHARED_CLIENT_OPTIONS).toEqual({
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
      });
      expect(subscriber.options).toEqual({
        maxRetriesPerRequest: 2,
        enableOfflineQueue: true,
      });
      expect(blocking.options).toEqual({
        maxRetriesPerRequest: null,
        enableOfflineQueue: true,
      });
    });

    it('gives consumers WORKER_DRAIN_MS to close while Redis is up, CLOSE_TIMEOUT_MS when down', () => {
      const redis = service({ WORKER_DRAIN_MS: '20000' });
      expect(redis.closeBudgetMs()).toBe(CLOSE_TIMEOUT_MS);
      mocks.connections[0].status = 'ready';
      expect(redis.closeBudgetMs()).toBe(20000);
      mocks.connections[0].status = 'reconnecting';
      expect(redis.closeBudgetMs()).toBe(CLOSE_TIMEOUT_MS);
    });

    it('logs each error code once per window across all connections, never the URL', () => {
      const redis = service();
      const dup = redis.duplicate() as unknown as EventEmitter;
      const client = redis.client as unknown as EventEmitter;

      client.emit('error', refused);
      dup.emit('error', refused);
      client.emit('error', refused);
      expect(warn).toHaveBeenCalledTimes(1);

      client.emit(
        'error',
        Object.assign(new Error('x'), { code: 'ENOTFOUND' }),
      );
      expect(warn).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(ERROR_LOG_INTERVAL_MS - 1);
      dup.emit('error', refused);
      expect(warn).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1);
      dup.emit('error', refused);
      expect(warn).toHaveBeenCalledTimes(3);

      const lines = warn.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(lines[0]).toContain('ECONNREFUSED');
      for (const line of lines) expect(line).not.toMatch(/secret|redis:\/\//);
    });

    it('starts once the client is ready within REDIS_CONNECT_TIMEOUT_MS', async () => {
      const redis = service({ REDIS_CONNECT_TIMEOUT_MS: '5000' });
      const init = redis.onModuleInit();
      vi.advanceTimersByTime(4999);
      (redis.client as unknown as EventEmitter).emit('ready');
      await expect(init).resolves.toBeUndefined();
    });

    it('fails startup after REDIS_CONNECT_TIMEOUT_MS and drops its connections', async () => {
      const redis = service({ REDIS_CONNECT_TIMEOUT_MS: '5000' });
      redis.duplicate();
      (redis.client as unknown as EventEmitter).emit('error', refused);
      const init = redis.onModuleInit();
      vi.advanceTimersByTime(5000);
      await expect(init).rejects.toThrow(
        'Redis not reachable within 5000 ms (ECONNREFUSED)',
      );
      for (const c of mocks.connections)
        expect(c.disconnect).toHaveBeenCalled();
    });

    it('quits live connections on shutdown and drops the rest without waiting', async () => {
      const redis = service();
      redis.duplicate();
      const [client, dup] = mocks.connections;
      client.status = 'ready';
      dup.status = 'reconnecting';
      await redis.onApplicationShutdown();
      expect(client.quit).toHaveBeenCalled();
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(dup.quit).not.toHaveBeenCalled();
      expect(dup.disconnect).toHaveBeenCalled();
    });

    it('drops a live connection whose QUIT hangs after CLOSE_TIMEOUT_MS', async () => {
      const redis = service();
      const [client] = mocks.connections;
      client.status = 'ready';
      client.quit.mockReturnValue(new Promise(() => undefined));
      const done = redis.onApplicationShutdown();
      await vi.advanceTimersByTimeAsync(CLOSE_TIMEOUT_MS);
      await done;
      expect(client.disconnect).toHaveBeenCalled();
    });
  });
});

describe('closeWithin', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not force a close that finishes in time', async () => {
    const force = vi.fn();
    await closeWithin(() => Promise.resolve(), force, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(force).not.toHaveBeenCalled();
  });

  it('forces a close that hangs past the deadline, without waiting on the force', async () => {
    const force = vi.fn(() => new Promise(() => undefined));
    const done = closeWithin(() => new Promise(() => undefined), force, 100);
    await vi.advanceTimersByTimeAsync(99);
    expect(force).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toBeUndefined();
    expect(force).toHaveBeenCalledTimes(1);
  });

  it('forces a close that fails, and swallows a failing force', async () => {
    const force = vi.fn(() => {
      throw new Error('already closed');
    });
    await closeWithin(() => Promise.reject(new Error('closed')), force, 100);
    await vi.advanceTimersByTimeAsync(0);
    expect(force).toHaveBeenCalledTimes(1);
  });
});
