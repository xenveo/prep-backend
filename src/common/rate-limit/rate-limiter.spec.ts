import type { RedisService } from '../infra/redis.service.js';
import { RateLimiter } from './rate-limiter.js';

describe('RateLimiter (in-memory)', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    limiter = new RateLimiter({ client: null } as RedisService);
  });

  afterEach(() => vi.useRealTimers());

  it('allows up to the limit, then blocks with the time left in the window', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(limiter.consume('otp:h1', 5, 3600)).resolves.toEqual({
        allowed: true,
        retryAfterSec: 0,
      });
    }
    await expect(limiter.consume('otp:h1', 5, 3600)).resolves.toEqual({
      allowed: false,
      retryAfterSec: 3600,
    });
    vi.advanceTimersByTime(3599_500);
    await expect(limiter.consume('otp:h1', 5, 3600)).resolves.toEqual({
      allowed: false,
      retryAfterSec: 1,
    });
  });

  it('opens a fresh window once the old one ends', async () => {
    await limiter.consume('k', 1, 60);
    expect((await limiter.consume('k', 1, 60)).allowed).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect((await limiter.consume('k', 1, 60)).allowed).toBe(true);
  });

  it('keeps keys separate and can reset one', async () => {
    await limiter.consume('a', 1, 60);
    expect((await limiter.consume('b', 1, 60)).allowed).toBe(true);
    expect((await limiter.consume('a', 1, 60)).allowed).toBe(false);
    await limiter.reset('a');
    expect((await limiter.consume('a', 1, 60)).allowed).toBe(true);
  });
});
