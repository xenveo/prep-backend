import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { AttemptsService } from './attempts.service.js';
import type { AttemptStatusView } from './interview.schemas.js';

/** Attempt polling and audio redirects (302 to short-lived signed URLs). */
@Controller()
export class AttemptsController {
  constructor(private readonly attempts: AttemptsService) {}

  @Get('attempts/:attemptId')
  status(
    @CurrentUser() user: AuthUser,
    @Param('attemptId') attemptId: string,
  ): Promise<AttemptStatusView> {
    return this.attempts.status(user.id, attemptId);
  }

  @Get('attempts/:attemptId/audio')
  async answerAudio(
    @CurrentUser() user: AuthUser,
    @Param('attemptId') attemptId: string,
    @Res() res: Response,
  ): Promise<void> {
    res.redirect(302, await this.attempts.answerAudioUrl(user.id, attemptId));
  }

  @Get('attempts/:attemptId/feedback-audio')
  async feedbackAudio(
    @CurrentUser() user: AuthUser,
    @Param('attemptId') attemptId: string,
    @Res() res: Response,
  ): Promise<void> {
    res.redirect(302, await this.attempts.feedbackAudioUrl(user.id, attemptId));
  }

  @Get('questions/:questionId/audio')
  async questionAudio(
    @CurrentUser() user: AuthUser,
    @Param('questionId') questionId: string,
    @Res() res: Response,
  ): Promise<void> {
    res.redirect(
      302,
      await this.attempts.questionAudioUrl(user.id, questionId),
    );
  }
}
