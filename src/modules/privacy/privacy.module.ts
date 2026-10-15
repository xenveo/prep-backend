import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { ErasureService } from './erasure.service.js';
import { ExportService } from './export.service.js';
import { PrivacyAdminController } from './privacy-admin.controller.js';
import { PrivacyController } from './privacy.controller.js';
import { PrivacyProcessor } from './privacy.processor.js';
import { PrivacyService } from './privacy.service.js';
import { RetentionService } from './retention.service.js';

/** Exports, privacy requests, retention purge and two-stage erasure (NFR-06, plan §8, §13). */
@Module({
  imports: [UsersModule],
  controllers: [PrivacyController, PrivacyAdminController],
  providers: [
    PrivacyService,
    ExportService,
    ErasureService,
    RetentionService,
    PrivacyProcessor,
  ],
  exports: [ErasureService],
})
export class PrivacyModule {}
