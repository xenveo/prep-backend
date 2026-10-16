import { Global, Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { ContentModule } from '../content/content.module.js';
import { AiConfigController } from './ai-config.controller.js';
import { AiConfigService } from './ai-config.service.js';
import { AiUsageController } from './ai-usage.controller.js';
import { AiUsageService } from './ai-usage.service.js';
import { AuditQueryService } from './audit-query.service.js';
import { AuditController } from './audit.controller.js';
import { SettingsAdminService } from './settings-admin.service.js';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';

@Global()
@Module({
  imports: [AiModule, ContentModule],
  controllers: [
    SettingsController,
    AuditController,
    AiConfigController,
    AiUsageController,
  ],
  providers: [
    SettingsService,
    SettingsAdminService,
    AuditQueryService,
    AiConfigService,
    AiUsageService,
  ],
  exports: [SettingsService],
})
export class SettingsModule {}
