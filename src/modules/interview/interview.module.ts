import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { ContentModule } from '../content/content.module.js';
import { UsersModule } from '../users/users.module.js';
import { AttemptsController } from './attempts.controller.js';
import { AttemptsService } from './attempts.service.js';
import { DashboardService } from './dashboard.service.js';
import { RolesController } from './roles.controller.js';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';

// PrismaService, QUEUE_SERVICE, AuditService, ActivityService and STORAGE_ADAPTER are global;
// so is SettingsModule (SettingsService).
@Module({
  imports: [UsersModule, AiModule, ContentModule],
  controllers: [RolesController, SessionsController, AttemptsController],
  providers: [SessionsService, AttemptsService, DashboardService],
  exports: [SessionsService],
})
export class InterviewModule {}
