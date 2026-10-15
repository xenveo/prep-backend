import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { ZodPipe } from '../../common/validation/zod.pipe.js';
import { AttemptsService, type UploadedAudio } from './attempts.service.js';
import { DashboardService } from './dashboard.service.js';
import {
  type HistoryItem,
  type HistoryQuery,
  historyQuerySchema,
  idempotencyKeySchema,
  MAX_AUDIO_BYTES,
  type SessionView,
  type SubmitAttemptBody,
  submitAttemptSchema,
} from './interview.schemas.js';
import { SessionsService } from './sessions.service.js';

/** Interview room and results (spec "Candidate API"). Sessions are visible only to their owner. */
@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly attempts: AttemptsService,
    private readonly dashboard: DashboardService,
  ) {}

  @Get()
  history(
    @CurrentUser() user: AuthUser,
    @Query(new ZodPipe(historyQuerySchema)) query: HistoryQuery,
  ): Promise<HistoryItem[]> {
    return this.dashboard.history(user.id, query.roleId);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<SessionView> {
    return this.sessions.get(user.id, id);
  }

  @Post(':id/questions/:questionId/attempts')
  @HttpCode(202)
  @UseInterceptors(
    FileInterceptor('audio', {
      limits: { fileSize: MAX_AUDIO_BYTES, files: 1 },
    }),
  )
  submitAttempt(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('questionId') questionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodPipe(submitAttemptSchema)) body: SubmitAttemptBody,
    @UploadedFile() audio: UploadedAudio | undefined,
  ): Promise<{ attemptId: string }> {
    return this.attempts.submit(
      user.id,
      id,
      questionId,
      new ZodPipe(idempotencyKeySchema).transform(idempotencyKey),
      body,
      audio,
    );
  }

  @Post(':id/questions/:questionId/skip-retry')
  @HttpCode(204)
  skipRetry(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('questionId') questionId: string,
  ): Promise<void> {
    return this.sessions.skipRetry(user.id, id, questionId);
  }

  @Post(':id/complete')
  @HttpCode(200)
  complete(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<SessionView> {
    return this.sessions.complete(user.id, id);
  }

  @Post(':id/abandon')
  @HttpCode(204)
  abandon(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<void> {
    return this.sessions.abandon(user.id, id);
  }
}
