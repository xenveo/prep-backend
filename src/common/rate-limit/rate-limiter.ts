import { Injectable } from '@nestjs/common';
import { RedisService } from '../infra/redis.service.js';

export type RateLimitResult = { allowed: boolean; retryAfterSec: number };

const SWEEP_AT = 10_000;

/** INCR, start the window on the first hit (or if the key somehow lost its TTL), return count and TTL. */
const CONSUME_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if n == 1 or ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {n, ttl}
`;

/**
 * Fixed-window rate limiter (plan §5 "Rate limits"). Redis when configured, so limits hold across
 * instances (stored as `<prefix>:rl:<key>`); otherwise an in-process map. Keys are opaque: callers
 * hash anything personal (emails).
 */
@Injectable()
export class RateLimiter {
  private readonly windows = new Map<
    string,
    { count: number; resetAt: number }
  >();

  constructor(private readonly redis: RedisService) {}

  async consume(
    key: string,
    limit: number,
    windowSec: number,
  ): Promise<RateLimitResult> {
    const client = this.redis.client;
    if (client) {
      const [count, ttl] = (await client.eval(
        CONSUME_SCRIPT,
        1,
        this.redis.key('rl', key),
        windowSec,
      )) as [number, number];
      return count <= limit
        ? { allowed: true, retryAfterSec: 0 }
        : { allowed: false, retryAfterSec: Math.max(1, ttl) };
    }
    return this.consumeInMemory(key, limit, windowSec);
  }

  async reset(key: string): Promise<void> {
    if (this.redis.client)
      await this.redis.client.del(this.redis.key('rl', key));
    else this.windows.delete(key);
  }

  private consumeInMemory(
    key: string,
    limit: number,
    windowSec: number,
  ): RateLimitResult {
    const now = Date.now();
    if (this.windows.size >= SWEEP_AT) {
      for (const [k, w] of this.windows)
        if (w.resetAt <= now) this.windows.delete(k);
    }
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + windowSec * 1000 };
      this.windows.set(key, window);
    }
    window.count++;
    if (window.count <= limit) return { allowed: true, retryAfterSec: 0 };
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
    };
  }
}
