import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { AppConfig } from '../../config/app-config.js';

/** AI drafting and test evaluation: AI_ADMIN_CALLS_PER_HOUR per admin, to cap cost (plan §5). */
@Injectable()
export class AiQuotaService {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly config: AppConfig,
  ) {}

  /** Throws 429 `rate_limited` once the admin's hourly allowance is used. */
  async consume(adminId: string): Promise<void> {
    const { allowed, retryAfterSec } = await this.limiter.consume(
      `ai-admin-${adminId}`,
      this.config.env.AI_ADMIN_CALLS_PER_HOUR,
      3600,
    );
    if (!allowed)
      throw new AppError(
        'rate_limited',
        429,
        'Too many AI requests. Try again later.',
        { retryAfterSec },
      );
  }
}
