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
});
