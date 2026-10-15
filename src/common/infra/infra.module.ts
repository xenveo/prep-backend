import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';
import { AuditService } from '../audit/audit.service.js';
import { EVENT_BUS } from '../events/event-bus.types.js';
import { InMemoryEventBus } from '../events/in-memory-event-bus.js';
import { RedisEventBus } from '../events/redis-event-bus.js';
import { BullMqQueueService } from '../queue/bullmq-queue.service.js';
import { InMemoryQueueService } from '../queue/in-memory-queue.service.js';
import { QUEUE_SERVICE } from '../queue/queue.types.js';
import { RateLimiter } from '../rate-limit/rate-limiter.js';
import { RedisService } from './redis.service.js';

/**
 * Shared infrastructure (plan §8): Redis, job queue, pub/sub, rate limits and the audit writer.
 * With REDIS_URL set everything is Redis-backed; without it, in-process (single instance only).
 */
@Global()
@Module({
  providers: [
    RedisService,
    {
      provide: QUEUE_SERVICE,
      inject: [AppConfig, RedisService],
      useFactory: (config: AppConfig, redis: RedisService) =>
        redis.client
          ? new BullMqQueueService(redis, config.env.PROCESS_ROLE)
          : new InMemoryQueueService(config.env.PROCESS_ROLE),
    },
    {
      provide: EVENT_BUS,
      inject: [RedisService],
      useFactory: (redis: RedisService) =>
        redis.client ? new RedisEventBus(redis) : new InMemoryEventBus(),
    },
    RateLimiter,
    AuditService,
  ],
  exports: [RedisService, QUEUE_SERVICE, EVENT_BUS, RateLimiter, AuditService],
})
export class InfraModule {}
