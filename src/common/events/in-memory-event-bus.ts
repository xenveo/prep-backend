import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import type { EventBus, Unsubscribe } from './event-bus.types.js';

/**
 * In-process EventBus (dev without Redis, tests). Delivery is asynchronous and payloads go through
 * a JSON round trip, as with Redis pub/sub, so code behaves the same under both.
 */
export class InMemoryEventBus implements EventBus {
  private readonly logger = new Logger('EventBus');
  private readonly emitter = new EventEmitter().setMaxListeners(0);

  publish(channel: string, event: object): Promise<void> {
    const message = JSON.stringify(event);
    queueMicrotask(() => this.emitter.emit(channel, message));
    return Promise.resolve();
  }

  subscribe(
    channel: string,
    handler: (event: any) => void,
  ): Promise<Unsubscribe> {
    const listener = (message: string) => {
      try {
        handler(JSON.parse(message));
      } catch (err) {
        this.logger.error(
          `Event handler failed: channel=${channel} (${err instanceof Error ? err.name : typeof err})`,
        );
      }
    };
    this.emitter.on(channel, listener);
    return Promise.resolve(() => {
      this.emitter.off(channel, listener);
      return Promise.resolve();
    });
  }
}
