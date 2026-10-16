import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { WorkerHealthServer } from './worker-health.server.js';

@Module({
  controllers: [HealthController],
  providers: [HealthService, WorkerHealthServer],
})
export class HealthModule {}
