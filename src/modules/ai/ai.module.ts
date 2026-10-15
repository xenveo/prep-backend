import { Module } from '@nestjs/common';
import { AiCallLogService } from './ai-call-log.service.js';
import { DrafterService } from './drafter.service.js';
import { EvaluatorService } from './evaluator.service.js';
import { InterviewerService } from './interviewer.service.js';
import { PromptService } from './prompt.service.js';
import { SummariserService } from './summariser.service.js';

// LLM_ADAPTER comes from the global AdaptersModule; PrismaService from the global PrismaModule.
const services = [
  PromptService,
  AiCallLogService,
  EvaluatorService,
  SummariserService,
  InterviewerService,
  DrafterService,
];

@Module({ providers: services, exports: services })
export class AiModule {}
