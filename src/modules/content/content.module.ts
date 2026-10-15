import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { UsersModule } from '../users/users.module.js';
import { AdminContentController } from './admin-content.controller.js';
import { AiDraftProcessor } from './ai-draft.processor.js';
import { AiJobsController } from './ai-jobs.controller.js';
import { AiQuotaService } from './ai-quota.service.js';
import { CandidateCardsController } from './candidate-cards.controller.js';
import { CandidateCardsService } from './candidate-cards.service.js';
import { CardsService } from './cards.service.js';
import { ContentQueryService } from './content-query.service.js';
import { QuestionsService } from './questions.service.js';
import { RolesService } from './roles.service.js';
import { TtsCacheService } from './tts-cache.service.js';
import { TtsPregenProcessor } from './tts-pregen.processor.js';

/** Job roles, flash cards and question banks (plan M2, M4, M7). */
@Module({
  imports: [AiModule, UsersModule],
  controllers: [
    AdminContentController,
    AiJobsController,
    CandidateCardsController,
  ],
  providers: [
    RolesService,
    CardsService,
    QuestionsService,
    AiQuotaService,
    AiDraftProcessor,
    TtsCacheService,
    TtsPregenProcessor,
    ContentQueryService,
    CandidateCardsService,
  ],
  exports: [ContentQueryService, TtsCacheService],
})
export class ContentModule {}
