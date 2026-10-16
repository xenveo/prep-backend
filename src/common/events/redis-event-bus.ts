import { Logger, OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { RedisService } from '../infra/redis.service.js';
import type { EventBus, Unsubscribe } from './event-bus.types.js';

type Handler = (event: any) => void;

/**
 * Redis pub/sub EventBus: publishes on the shared client, listens on one dedicated subscriber
 * connection. Callers use bare channel names (`session:<id>`); on the wire each is namespaced with
 * the app's Redis prefix, because pub/sub is server-wide and ignores the DB index.
 */
export class RedisEventBus implements EventBus, OnModuleDestroy {
  private readonly logger = new Logger('EventBus');
  private readonly handlers = new Map<string, Set<Handler>>();
  private subscriber: Redis | null = null;

  constructor(private readonly redis: RedisService) {}

  async publish(channel: string, event: object): Promise<void> {
    await this.redis.client!.publish(
      this.redis.key(channel),
      JSON.stringify(event),
    );
  }

  async subscribe(channel: string, handler: Handler): Promise<Unsubscribe> {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      await this.connection().subscribe(this.redis.key(channel));
    }
    set.add(handler);
    return async () => {
      const current = this.handlers.get(channel);
      if (!current?.delete(handler) || current.size > 0) return;
      this.handlers.delete(channel);
      await this.subscriber?.unsubscribe(this.redis.key(channel));
    };
  }

  onModuleDestroy(): void {
    this.handlers.clear();
  }

  private connection(): Redis {
    if (!this.subscriber) {
      this.subscriber = this.redis.duplicate();
      const wirePrefix = this.redis.key('');
      this.subscriber.on('message', (wireChannel: string, message: string) => {
        if (wireChannel.startsWith(wirePrefix))
          this.dispatch(wireChannel.slice(wirePrefix.length), message);
      });
    }
    return this.subscriber;
  }

  private dispatch(channel: string, message: string): void {
    const set = this.handlers.get(channel);
    if (!set) return;
    let event: unknown;
    try {
      event = JSON.parse(message);
    } catch {
      this.logger.warn(`Dropped a malformed event: channel=${channel}`);
      return;
    }
    for (const handler of set) {
      try {
        handler(event);
      } catch (err) {
        this.logger.error(
          `Event handler failed: channel=${channel} (${err instanceof Error ? err.name : typeof err})`,
        );
      }
    }
  }
}
