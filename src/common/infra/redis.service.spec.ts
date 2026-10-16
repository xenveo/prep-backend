import { Logger } from '@nestjs/common';
import { loadConfig } from '../../config/app-config.js';
import { RedisService } from './redis.service.js';

describe('RedisService', () => {
  const config = (env: Record<string, string>) =>
    loadConfig({
      DATABASE_URL: 'postgresql://x',
      AUTH_SECRET: 'a'.repeat(32),
      ...env,
    });

  it('builds keys under REDIS_PREFIX, which defaults to preppilot', () => {
    const redis = new RedisService(config({}));
    expect(redis.prefix).toBe('preppilot');
    expect(redis.key('rl', 'otp', 'h1')).toBe('preppilot:rl:otp:h1');
    expect(redis.key('session:s1')).toBe('preppilot:session:s1');
  });

  it('honours a custom prefix and opens no connection without REDIS_URL', () => {
    const redis = new RedisService(config({ REDIS_PREFIX: 'pp-staging' }));
    expect(redis.client).toBeNull();
    expect(redis.key('recovery', 'lock')).toBe('pp-staging:recovery:lock');
  });

  it('logs a lost connection once, not on every retry, and its recovery once', () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const log = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const redis = new RedisService(
      config({ REDIS_URL: 'redis://127.0.0.1:1', REDIS_PREFIX: 'pp-test' }),
    );
    const sub = redis.duplicate({ lazyConnect: true });
    try {
      const refused = Object.assign(new Error('refused'), {
        code: 'ECONNREFUSED',
      });
      for (const conn of [redis.client!, sub]) {
        conn.emit('error', refused);
        conn.emit('error', refused);
        conn.emit('ready');
        conn.emit('ready');
      }
      expect(error).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledWith(
        'Connection main unavailable (ECONNREFUSED); retrying',
      );
      expect(log).toHaveBeenCalledTimes(2);
    } finally {
      redis.client!.disconnect();
      sub.disconnect();
      vi.restoreAllMocks();
    }
  });
});
