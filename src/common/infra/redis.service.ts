import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';
import { AppConfig } from '../../config/app-config.js';

/**
 * Shared Redis connection (plan §8). `client` is null when REDIS_URL is unset: callers then use their
 * in-process fallback. Connections close on application shutdown, after the queue and event bus
 * have closed theirs in onModuleDestroy.
 *
 * The server may be shared with other apps, and pub/sub ignores the DB index, so every key, channel
 * and BullMQ queue goes under `prefix`. Build names with `key()`, never by hand.
 *
 * ioredis retries a lost connection forever and emits `error` on every attempt; each connection
 * logs once when it goes down and once when it is back, never the URL (it may hold a password).
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  readonly client: Redis | null;
  private readonly duplicates: Redis[] = [];
  private readonly keyPrefix: string;
  private readonly logger = new Logger('Redis');

  constructor(config: AppConfig) {
    const url = config.env.REDIS_URL;
    this.client = url ? this.watch(new Redis(url), 'main') : null;
    this.keyPrefix = config.env.REDIS_PREFIX;
  }

  /** Namespace for this app (`REDIS_PREFIX`), also BullMQ's queue prefix. */
  get prefix(): string {
    return this.keyPrefix;
  }

  /** A namespaced key or channel name: `key('rl', 'otp')` is `<prefix>:rl:otp`. */
  key(...parts: string[]): string {
    return [this.keyPrefix, ...parts].join(':');
  }

  /** A new connection to the same server, for subscribers and BullMQ (which needs blocking connections). */
  duplicate(override?: Partial<RedisOptions>): Redis {
    if (!this.client) throw new Error('REDIS_URL is not set');
    const connection = this.watch(
      this.client.duplicate(override) as Redis,
      `duplicate-${this.duplicates.length + 1}`,
    );
    this.duplicates.push(connection);
    return connection;
  }

  async onApplicationShutdown(): Promise<void> {
    const all = this.client ? [...this.duplicates, this.client] : [];
    await Promise.allSettled(all.map((c) => c.quit()));
  }

  private watch(connection: Redis, name: string): Redis {
    let down = false;
    connection.on('error', (err: NodeJS.ErrnoException) => {
      if (down) return;
      down = true;
      this.logger.error(
        `Connection ${name} unavailable (${err.code ?? err.name}); retrying`,
      );
    });
    connection.on('ready', () => {
      if (!down) return;
      down = false;
      this.logger.log(`Connection ${name} restored`);
    });
    return connection;
  }
}
