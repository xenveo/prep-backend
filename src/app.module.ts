import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AdaptersModule } from './adapters/adapters.module.js';
import { CommonModule } from './common/common.module.js';
import { InfraModule } from './common/infra/infra.module.js';
import { LoggingModule } from './common/logging/logging.module.js';
import { ConfigModule } from './config/config.module.js';
import { EmailModule } from './jobs/email/email.module.js';
import { RecoveryModule } from './jobs/recovery/recovery.module.js';
import { ActivityModule } from './modules/activity/activity.module.js';
import { AiModule } from './modules/ai/ai.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ContentModule } from './modules/content/content.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { InterviewModule } from './modules/interview/interview.module.js';
import { PipelineModule } from './modules/interview/pipeline/pipeline.module.js';
import { PrivacyModule } from './modules/privacy/privacy.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    ScheduleModule.forRoot(),
    PrismaModule,
    InfraModule,
    AdaptersModule,
    EmailModule,
    CommonModule,
    ActivityModule,
    SettingsModule,
    AiModule,
    HealthModule,
    AuthModule,
    UsersModule,
    ContentModule,
    PipelineModule,
    InterviewModule,
    ReportsModule,
    PrivacyModule,
    RecoveryModule,
  ],
})
export class AppModule {}
