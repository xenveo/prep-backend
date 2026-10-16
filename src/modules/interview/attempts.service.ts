import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  STORAGE_ADAPTER,
  type StorageAdapter,
} from '../../adapters/storage/storage.adapter.js';
import { AppError, conflict, notFound } from '../../common/errors/app-error.js';
import {
  QUEUE_SERVICE,
  type QueueService,
} from '../../common/queue/queue.types.js';
import { type Attempt, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TtsCacheService } from '../content/tts-cache.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { AssignmentsService } from '../users/assignments.service.js';
import {
  AUDIO_EXTENSIONS,
  type AttemptStatusView,
  type SubmitAttemptBody,
  uploadedVoiceMetrics,
} from './interview.schemas.js';
import {
  toAppliedItems,
  toCandidateAttempt,
} from './serializers/candidate.serializer.js';
import { questionStates } from './session-state.js';
import { isUuid, SessionsService } from './sessions.service.js';
import type { AttemptJob, StoredFeedback } from './types.js';

export type UploadedAudio = { buffer: Buffer; mimetype: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Columns the pipeline fills; cleared when a failed attempt is resubmitted. */
const RESULT_RESET = {
  status: 'received',
  transcript: null,
  words: Prisma.DbNull,
  audioKey: null,
  audioExpiresAt: null,
  durationS: null,
  wpm: null,
  fillerCount: null,
  pauseCount: null,
  longestPauseS: null,
  speakingS: null,
  dimensionScores: Prisma.DbNull,
  score: null,
  learningScore: null,
  feedback: Prisma.DbNull,
  feedbackText: null,
  feedbackAudioKey: null,
  evidence: Prisma.DbNull,
  error: null,
} satisfies Prisma.AttemptUpdateInput;

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/** BullMQ job id: no ':'; the `attempt-<sessionId>` prefix lets erasure cancel a session's jobs. */
export const attemptJobId = (
  a: Pick<Attempt, 'id' | 'sessionId' | 'submittedAt'>,
) => `attempt-${a.sessionId}-${a.id}-${a.submittedAt.getTime().toString(36)}`;

/** Attempt submission, polling and audio links (spec "Candidate API", plan §6 upload). */
@Injectable()
export class AttemptsService {
  private readonly logger = new Logger(AttemptsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly assignments: AssignmentsService,
    private readonly settings: SettingsService,
    private readonly tts: TtsCacheService,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    @Inject(QUEUE_SERVICE) private readonly queue: QueueService,
  ) {}

  /**
   * POST /sessions/:id/questions/:questionId/attempts → 202 {attemptId}. Replaying an idempotency
   * key returns the same attempt; a failed attempt may be resubmitted with a new key.
   */
  async submit(
    userId: string,
    sessionId: string,
    questionId: string,
    idempotencyKey: string,
    body: SubmitAttemptBody,
    audio: UploadedAudio | undefined,
  ): Promise<{ attemptId: string }> {
    const session = await this.sessions.loadOwned(userId, sessionId);
    const replay = session.attempts.find(
      (a) => a.idempotencyKey === idempotencyKey,
    );
    if (replay) return this.replayed(replay, questionId, body.attemptNo);
    if (session.status !== 'in_progress') {
      throw conflict('This session is not in progress');
    }
    const state = questionStates(session).find(
      (s) => s.sq.questionId === questionId,
    );
    if (!state) throw notFound('Question not found');

    let existing: Attempt | null;
    if (body.attemptNo === 1) {
      existing = state.first;
    } else {
      if (state.first?.status !== 'done') {
        throw conflict('The first try is not finished yet');
      }
      if (state.sq.retrySkipped) throw conflict('The second try was skipped');
      existing = state.second;
    }
    if (existing && existing.status !== 'failed') {
      throw conflict('This try was already submitted');
    }

    const ext = body.mode === 'voice' ? audioExtension(audio) : null;
    const attemptId = existing?.id ?? randomUUID();
    const submittedAt = new Date();
    let audioKey: string | null = null;
    let audioExpiresAt: Date | null = null;
    if (ext && audio) {
      audioKey = `audio/${sessionId}/${attemptId}.${ext}`;
      const { audioRetentionDays } = await this.settings.get();
      audioExpiresAt = new Date(
        submittedAt.getTime() + audioRetentionDays * DAY_MS,
      );
      await this.storage.put(audioKey, audio.buffer, audio.mimetype);
    }
    const data = {
      mode: body.mode,
      idempotencyKey,
      transcript: body.mode === 'typed' ? (body.text ?? '') : null,
      audioKey,
      audioExpiresAt,
      durationS: body.durationSec,
      ...uploadedVoiceMetrics(body),
      submittedAt,
    };

    let attempt: Attempt;
    try {
      attempt = existing
        ? await this.resubmit(existing, data)
        : await this.prisma.attempt.create({
            data: {
              id: attemptId,
              sessionId,
              questionId,
              attemptNo: body.attemptNo,
              ...data,
            },
          });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // A concurrent request with the same key (or for the same try) got there first.
      const winner = await this.prisma.attempt.findFirst({
        where: { sessionId, idempotencyKey },
      });
      if (winner) return this.replayed(winner, questionId, body.attemptNo);
      throw conflict('This try was already submitted');
    }

    await this.queue.add<AttemptJob>(
      'attempt',
      { attemptId: attempt.id },
      { jobId: attemptJobId(attempt), attempts: 1 },
    );
    return { attemptId: attempt.id };
  }

  /** GET /attempts/:attemptId (WebSocket polling fallback). */
  async status(userId: string, attemptId: string): Promise<AttemptStatusView> {
    const attempt = await this.loadOwned(userId, attemptId);
    switch (attempt.status) {
      case 'received':
      case 'transcribing':
        return { status: 'transcribing' };
      case 'evaluating':
        return { status: 'evaluating' };
      case 'failed':
        return { status: 'failed', code: attempt.error ?? 'ai_unavailable' };
      case 'done': {
        const feedback = attempt.feedback as StoredFeedback | null;
        const view: AttemptStatusView = {
          status: 'done',
          attempt: toCandidateAttempt(attempt),
          applied: toAppliedItems(feedback?.applied ?? []),
        };
        if (feedback?.followUp) view.followUp = feedback.followUp;
        return view;
      }
    }
  }

  /** GET /attempts/:attemptId/audio → signed URL; 410 once the recording has expired or was deleted. */
  async answerAudioUrl(userId: string, attemptId: string): Promise<string> {
    const attempt = await this.loadOwned(userId, attemptId);
    if (attempt.mode === 'typed')
      throw notFound('No recording for this answer');
    if (
      !attempt.audioKey ||
      (attempt.audioExpiresAt && attempt.audioExpiresAt <= new Date())
    ) {
      throw new AppError('gone', 410, 'This recording has been deleted');
    }
    return this.storage.signedUrl(attempt.audioKey);
  }

  /** GET /attempts/:attemptId/feedback-audio → signed URL; 404 until the spoken feedback exists. */
  async feedbackAudioUrl(userId: string, attemptId: string): Promise<string> {
    const attempt = await this.loadOwned(userId, attemptId);
    if (!attempt.feedbackAudioKey) throw notFound('Feedback audio not ready');
    return this.storage.signedUrl(attempt.feedbackAudioKey);
  }

  /**
   * GET /questions/:questionId/audio (FR-INT-03). The question must be in one of the user's sessions
   * or in an approved role assigned to them. The TTS key is cached on the question.
   */
  async questionAudioUrl(userId: string, questionId: string): Promise<string> {
    if (!isUuid(questionId)) throw notFound('Question not found');
    const question = await this.prisma.question.findUnique({
      where: { id: questionId },
      select: {
        id: true,
        text: true,
        audioKey: true,
        jobRoleId: true,
        status: true,
      },
    });
    if (!question) throw notFound('Question not found');
    const inSession = await this.prisma.sessionQuestion.findFirst({
      where: { questionId, session: { userId } },
      select: { sessionId: true },
    });
    if (!inSession) {
      if (question.status !== 'approved') throw notFound('Question not found');
      await this.assignments.findCandidateRole(userId, question.jobRoleId);
    }
    let key = question.audioKey;
    if (!key) {
      key = (await this.tts.getOrCreate(question.text)).key;
      await this.prisma.question.update({
        where: { id: question.id },
        data: { audioKey: key },
      });
    }
    return this.tts.signedUrl(key);
  }

  private async loadOwned(userId: string, attemptId: string): Promise<Attempt> {
    if (!isUuid(attemptId)) throw notFound('Attempt not found');
    const attempt = await this.prisma.attempt.findFirst({
      where: { id: attemptId, session: { userId } },
    });
    if (!attempt) throw notFound('Attempt not found');
    return attempt;
  }

  private resubmit(
    existing: Attempt,
    data: Prisma.AttemptUpdateInput,
  ): Promise<Attempt> {
    if (existing.audioKey && existing.audioKey !== data.audioKey) {
      this.storage
        .delete(existing.audioKey)
        .catch((e: Error) =>
          this.logger.warn(
            `could not delete old audio for attempt ${existing.id}: ${e.name}`,
          ),
        );
    }
    return this.prisma.attempt.update({
      where: { id: existing.id },
      data: { ...RESULT_RESET, ...data },
    });
  }

  private replayed(
    attempt: Attempt,
    questionId: string,
    attemptNo: number,
  ): { attemptId: string } {
    if (attempt.questionId !== questionId || attempt.attemptNo !== attemptNo) {
      throw conflict('This Idempotency-Key was used for a different answer');
    }
    return { attemptId: attempt.id };
  }
}

function audioExtension(audio: UploadedAudio | undefined): string {
  if (!audio || audio.buffer.length === 0) {
    throw new AppError(
      'validation_failed',
      400,
      'audio is required for a voice answer',
    );
  }
  const type = audio.mimetype.split(';')[0].trim().toLowerCase();
  const ext = AUDIO_EXTENSIONS[type];
  if (!ext) {
    throw new AppError(
      'validation_failed',
      400,
      'audio must be webm, ogg, mp4 or mpeg',
    );
  }
  return ext;
}
