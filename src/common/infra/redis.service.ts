import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';
import { AppConfig } from '../../config/app-config.js';

/**
 * Shared Redis connection (plan §8). `client` is null when REDIS_URL is unset: callers then use their
 * in-process fallback. Connections close on application shutdown, after the queue and event bus
 * have closed theirs in onModuleDestroy.
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  readonly client: Redis | null;
  private readonly duplicates: Redis[] = [];

  constructor(config: AppConfig) {
    const url = config.env.REDIS_URL;
    this.client = url ? new Redis(url) : null;
  }

  /** A new connection to the same server, for subscribers and BullMQ (which needs blocking connections). */
  duplicate(override?: Partial<RedisOptions>): Redis {
    if (!this.client) throw new Error('REDIS_URL is not set');
    const connection = this.client.duplicate(override) as Redis;
    this.duplicates.push(connection);
    return connection;
  }

  async onApplicationShutdown(): Promise<void> {
    const all = this.client ? [...this.duplicates, this.client] : [];
    await Promise.allSettled(all.map((c) => c.quit()));
  }
}
