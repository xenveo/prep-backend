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

describe('RateLimiter (Redis)', () => {
  const evalScript = vi.fn();
  const del = vi.fn().mockResolvedValue(1);
  const limiter = new RateLimiter({
    client: { eval: evalScript, del },
    key: (...parts: string[]) => ['preppilot', ...parts].join(':'),
  } as unknown as RedisService);

  it('keeps windows under <prefix>:rl:<key> and reads count and TTL back', async () => {
    evalScript.mockResolvedValueOnce([1, 60]).mockResolvedValueOnce([2, 42]);
    await expect(limiter.consume('otp:h1', 1, 60)).resolves.toEqual({
      allowed: true,
      retryAfterSec: 0,
    });
    await expect(limiter.consume('otp:h1', 1, 60)).resolves.toEqual({
      allowed: false,
      retryAfterSec: 42,
    });
    await limiter.reset('otp:h1');
    expect(evalScript).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'preppilot:rl:otp:h1',
      60,
    );
    expect(del).toHaveBeenCalledWith('preppilot:rl:otp:h1');
  });
});
