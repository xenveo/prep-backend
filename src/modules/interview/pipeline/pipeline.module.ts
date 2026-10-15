import { Module } from '@nestjs/common';
import { AiModule } from '../../ai/ai.module.js';
import { ContentModule } from '../../content/content.module.js';
import { AttemptPipelineService } from './attempt-pipeline.service.js';
import { SessionGateway } from './session.gateway.js';

/** The attempt job processor and the interview WebSocket (plan §6, M5). */
@Module({
  imports: [AiModule, ContentModule],
  providers: [AttemptPipelineService, SessionGateway],
  exports: [AttemptPipelineService],
})
export class PipelineModule {}
