import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../common/infra/redis.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/** Liveness: `status` is always 'ok'; `db` and `redis` report the dependencies. */
export type HealthStatus = {
  status: 'ok';
  db: 'ok' | 'error';
  /** 'disabled' when REDIS_URL is unset (in-process queue and pub/sub). */
  redis: 'ok' | 'error' | 'disabled';
};

/** A down Redis queues commands instead of failing them, so PING needs its own deadline. */
export const REDIS_PING_TIMEOUT_MS = 1000;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async check(): Promise<HealthStatus> {
    const [db, redis] = await Promise.all([this.checkDb(), this.checkRedis()]);
    return { status: 'ok', db, redis };
  }

  private async checkDb(): Promise<HealthStatus['db']> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'ok';
    } catch (err) {
      this.logger.warn({ err }, 'Database health check failed');
      return 'error';
    }
  }

  private async checkRedis(): Promise<HealthStatus['redis']> {
    const client = this.redis.client;
    if (!client) return 'disabled';
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.ping(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Redis PING timed out')),
            REDIS_PING_TIMEOUT_MS,
          );
        }),
      ]);
      return 'ok';
    } catch (err) {
      this.logger.warn(
        `Redis health check failed (${err instanceof Error ? err.message : typeof err})`,
      );
      return 'error';
    } finally {
      clearTimeout(timer);
    }
  }
}
