import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  STORAGE_ADAPTER,
  type StorageAdapter,
} from '../../adapters/storage/storage.adapter.js';
import { RedisService } from '../../common/infra/redis.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

type Check = 'ok' | 'error';
/** 'disabled' when REDIS_URL is unset (in-process queue and pub/sub). */
type RedisCheck = Check | 'disabled';

/** Liveness: `status` is always 'ok'; `db` and `redis` report the dependencies. */
export type HealthStatus = { status: 'ok'; db: Check; redis: RedisCheck };

/** Readiness: 'ready' only when every dependency is reachable; served as 200, otherwise 503. */
export type ReadyStatus = {
  status: 'ready' | 'not_ready';
  db: Check;
  redis: RedisCheck;
  storage: Check;
};

/** Per-dependency deadline. A down Redis queues commands instead of failing them, and a down DB or S3 can hang. */
export const CHECK_TIMEOUT_MS = 1000;

/** Never written: a missing object is a reachable bucket, so `exists()` answers false without error. */
export const STORAGE_PROBE_KEY = 'health/ready-probe';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
  ) {}

  async check(): Promise<HealthStatus> {
    const [db, redis] = await Promise.all([this.checkDb(), this.checkRedis()]);
    return { status: 'ok', db, redis };
  }

  async ready(): Promise<ReadyStatus> {
    const [db, redis, storage] = await Promise.all([
      this.checkDb(),
      this.checkRedis(),
      this.checkStorage(),
    ]);
    const ok = db === 'ok' && redis !== 'error' && storage === 'ok';
    return { status: ok ? 'ready' : 'not_ready', db, redis, storage };
  }

  private checkDb(): Promise<Check> {
    return this.probe('Database', () => this.prisma.$queryRaw`SELECT 1`);
  }

  private async checkRedis(): Promise<RedisCheck> {
    const client = this.redis.client;
    return client ? this.probe('Redis', () => client.ping()) : 'disabled';
  }

  private checkStorage(): Promise<Check> {
    return this.probe('Storage', () => this.storage.exists(STORAGE_PROBE_KEY));
  }

  /** Runs `fn` under CHECK_TIMEOUT_MS. Logs the dependency name and error message only, never URLs or credentials. */
  private async probe(
    name: string,
    fn: () => Promise<unknown>,
  ): Promise<Check> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('timed out')),
            CHECK_TIMEOUT_MS,
          );
        }),
      ]);
      return 'ok';
    } catch (err) {
      const reason = err instanceof Error ? err.message : typeof err;
      this.logger.warn(`${name} health check failed (${reason})`);
      return 'error';
    } finally {
      clearTimeout(timer);
    }
  }
}
