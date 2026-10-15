import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  STORAGE_ADAPTER,
  type StorageAdapter,
} from '../../../adapters/storage/storage.adapter.js';
import {
  STT_ADAPTER,
  SttUnavailableError,
  type SttAdapter,
} from '../../../adapters/stt/stt.adapter.js';
import { AppError } from '../../../common/errors/app-error.js';
import {
  EVENT_BUS,
  sessionChannel,
  type EventBus,
  type SessionEvent,
} from '../../../common/events/event-bus.types.js';
import {
  QUEUE_SERVICE,
  type QueueService,
} from '../../../common/queue/queue.types.js';
import type { Attempt, Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { AiCallLogService } from '../../ai/ai-call-log.service.js';
import {
  buildStoredEvidence,
  buildStoredFeedback,
  EvaluatorService,
} from '../../ai/evaluator.service.js';
import { TtsCacheService } from '../../content/tts-cache.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { toDeliveryMetrics } from '../scoring/delivery.js';
import { computeMetrics } from '../scoring/metrics.js';
import {
  toAppliedItems,
  toCandidateAttempt,
} from '../serializers/candidate.serializer.js';
import type {
  AttemptJob,
  Rubric,
  StoredFeedback,
  VoiceMetrics,
  WeightsSnapshot,
  Word,
} from '../types.js';

/** A run that stopped at `transcribing`/`evaluating` this long ago (worker crash) may be taken over. */
export const STALE_RUN_MS = 2 * 60 * 1000;
const CONCURRENCY = 10;

const MIME_BY_EXT: Record<string, string> = {
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  mp4: 'audio/mp4',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

export function mimeTypeForKey(key: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(key)?.[1]?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'audio/webm';
}

/** The candidate can resubmit (or switch to typing); the job itself never retries. */
class PipelineFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PipelineFailure';
  }
}

const elapsed = (start: number) => Math.round(performance.now() - start);

/**
 * The attempt job (spec "AI interview pipeline", plan §6): STT → metrics → evaluate → persist and
 * push `attempt.evaluated` → TTS and push `feedback.audio_ready`. Idempotent per attempt.
 */
@Injectable()
export class AttemptPipelineService implements OnModuleInit {
  private readonly logger = new Logger(AttemptPipelineService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(QUEUE_SERVICE) private readonly queue: QueueService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(STT_ADAPTER) private readonly stt: SttAdapter,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    private readonly evaluator: EvaluatorService,
    private readonly callLog: AiCallLogService,
    private readonly settings: SettingsService,
    private readonly tts: TtsCacheService,
  ) {}

  onModuleInit(): void {
    this.queue.process<AttemptJob, void>(
      'attempt',
      (data) => this.processAttempt(data.attemptId),
      { concurrency: CONCURRENCY },
    );
  }

  /** Never throws: failures are saved on the attempt and pushed as `attempt.failed`. */
  async processAttempt(attemptId: string): Promise<void> {
    const started = performance.now();
    let attempt: Attempt | null = null;
    try {
      attempt = await this.claim(attemptId);
      if (!attempt) return;
      await this.run(attempt);
      this.logger.log(`attempt ${attemptId} step=total ms=${elapsed(started)}`);
    } catch (err) {
      if (!attempt) {
        this.logger.error(
          `attempt ${attemptId} claim failed (${errName(err)})`,
        );
        return;
      }
      const code = failureCode(err);
      if (code === 'internal')
        this.logger.error(
          `attempt ${attemptId} failed unexpectedly (${errName(err)})`,
        );
      else this.logger.warn(`attempt ${attemptId} failed: ${code}`);
      await this.fail(attempt, 'ai_unavailable').catch((e) =>
        this.logger.error(
          `attempt ${attemptId} could not be marked failed (${errName(e)})`,
        ),
      );
    }
  }

  /**
   * Moves a `received` attempt (or a stale in-flight one) into its first working status. Returns null
   * when there is nothing to do: unknown attempt, already done, failed and not resubmitted, or another
   * worker is on it.
   */
  private async claim(attemptId: string): Promise<Attempt | null> {
    const current = await this.prisma.attempt.findUnique({
      where: { id: attemptId },
      select: { mode: true },
    });
    if (!current) return null;
    const staleBefore = new Date(Date.now() - STALE_RUN_MS);
    const { count } = await this.prisma.attempt.updateMany({
      where: {
        id: attemptId,
        OR: [
          { status: 'received' },
          {
            status: { in: ['transcribing', 'evaluating'] },
            updatedAt: { lt: staleBefore },
          },
        ],
      },
      data: {
        status: current.mode === 'voice' ? 'transcribing' : 'evaluating',
      },
    });
    if (count === 0) return null;
    return this.prisma.attempt.findUnique({ where: { id: attemptId } });
  }

  private async run(attempt: Attempt): Promise<void> {
    const { id: attemptId, sessionId, questionId } = attempt;
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        status: true,
        weightsSnapshot: true,
        role: { select: { title: true } },
      },
    });
    const sq = await this.prisma.sessionQuestion.findUnique({
      where: { sessionId_questionId: { sessionId, questionId } },
      select: {
        position: true,
        question: { select: { text: true, rubric: true } },
      },
    });
    if (!session || !sq || session.status !== 'in_progress') {
      await this.prisma.attempt.update({
        where: { id: attemptId },
        data: { status: 'failed', error: 'session_closed' },
      });
      this.logger.warn(`attempt ${attemptId} skipped: session not in progress`);
      return;
    }

    // 1–2. STT and voice metrics.
    let transcript = attempt.transcript ?? '';
    let metrics: VoiceMetrics | null = null;
    if (attempt.mode === 'voice') {
      const stt = await this.transcribe(attempt);
      transcript = stt.text;
      const t = performance.now();
      metrics = computeMetrics(stt.words, stt.durationS);
      await this.prisma.attempt.update({
        where: { id: attemptId },
        data: {
          transcript: stt.text,
          words: stt.words as unknown as Prisma.InputJsonValue,
          durationS: metrics.durationS,
          wpm: metrics.wpm,
          fillerCount: metrics.fillerCount,
          pauseCount: metrics.pauseCount,
          longestPauseS: metrics.longestPauseS,
          status: 'evaluating',
        },
      });
      this.logger.log(`attempt ${attemptId} step=metrics ms=${elapsed(t)}`);
      await this.publish(sessionId, {
        type: 'attempt.transcribed',
        attemptId,
        questionId,
        attemptNo: attempt.attemptNo,
        transcript: stt.text,
      });
    }
    const delivery = toDeliveryMetrics(
      metrics,
      (await this.settings.get()).deliveryTargets,
    );

    // 3. Evaluate.
    const attemptNo = attempt.attemptNo === 2 ? 2 : 1;
    const previousImprovementPoints =
      attemptNo === 2 ? await this.previousPoints(sessionId, questionId) : [];
    const weights = session.weightsSnapshot as unknown as WeightsSnapshot;
    let t = performance.now();
    const result = await this.evaluator.evaluate({
      roleTitle: session.role.title,
      question: sq.question.text,
      rubric: sq.question.rubric as unknown as Rubric,
      transcript,
      mode: attempt.mode,
      delivery: metrics,
      attemptNo,
      previousImprovementPoints,
      dimensionWeights: weights.dimensionWeights,
      sessionId,
      attemptId,
    });
    this.logger.log(`attempt ${attemptId} step=evaluate ms=${elapsed(t)}`);

    // 4. Persist and push.
    t = performance.now();
    const feedback = buildStoredFeedback(result.output, delivery);
    const followUp = attemptNo === 1 ? result.output.follow_up : null;
    const writes: Prisma.PrismaPromise<unknown>[] = [
      this.prisma.attempt.update({
        where: { id: attemptId },
        data: {
          status: 'done',
          error: null,
          dimensionScores: result.dimensionScores,
          score: result.score,
          learningScore: result.learningScore,
          feedback: feedback as unknown as Prisma.InputJsonObject,
          evidence: buildStoredEvidence(
            result.output,
          ) as unknown as Prisma.InputJsonArray,
          feedbackText: feedback.spokenSummary,
        },
      }),
    ];
    if (followUp)
      writes.push(
        this.prisma.sessionQuestion.update({
          where: { sessionId_position: { sessionId, position: sq.position } },
          data: { followUpText: followUp },
        }),
      );
    if (attemptNo === 2)
      writes.push(
        this.prisma.session.updateMany({
          where: { id: sessionId, currentQuestion: { lte: sq.position } },
          data: { currentQuestion: sq.position + 1 },
        }),
      );
    const [done] = (await this.prisma.$transaction(writes)) as [Attempt];
    await this.publish(sessionId, {
      type: 'attempt.evaluated',
      attemptId,
      questionId,
      attemptNo,
      attempt: toCandidateAttempt(done),
      applied: attemptNo === 2 ? toAppliedItems(feedback.applied) : [],
      followUp,
    });
    this.logger.log(`attempt ${attemptId} step=persist ms=${elapsed(t)}`);

    // 5. TTS, after the push (not in the 8 s budget). Text feedback is already delivered.
    await this.speak(done, feedback);
  }

  private async transcribe(
    attempt: Attempt,
  ): Promise<{ text: string; words: Word[]; durationS: number }> {
    const { id: attemptId, sessionId, audioKey } = attempt;
    if (!audioKey) throw new PipelineFailure('audio_missing');
    const t = performance.now();
    let audio: Buffer;
    try {
      audio = await this.storage.get(audioKey);
    } catch {
      throw new PipelineFailure('audio_missing');
    }
    try {
      const res = await this.stt.transcribe(audio, {
        mimeType: mimeTypeForKey(audioKey),
        language: 'en',
      });
      await this.callLog.log({
        sessionId,
        attemptId,
        kind: 'stt',
        provider: res.provider,
        model: res.model,
        audioSeconds: res.durationS,
        latencyMs: res.latencyMs || elapsed(t),
        costUsd: res.costUsd,
        status: 'ok',
      });
      this.logger.log(`attempt ${attemptId} step=stt ms=${elapsed(t)}`);
      return { text: res.text, words: res.words, durationS: res.durationS };
    } catch (err) {
      await this.callLog.log({
        sessionId,
        attemptId,
        kind: 'stt',
        provider: this.stt.provider,
        latencyMs: elapsed(t),
        status: 'error',
        error: errName(err),
      });
      throw err;
    }
  }

  private async previousPoints(
    sessionId: string,
    questionId: string,
  ): Promise<string[]> {
    const first = await this.prisma.attempt.findUnique({
      where: {
        sessionId_questionId_attemptNo: { sessionId, questionId, attemptNo: 1 },
      },
      select: { feedback: true },
    });
    const feedback = first?.feedback as StoredFeedback | null | undefined;
    return feedback?.improvementPoints ?? [];
  }

  private async speak(
    attempt: Attempt,
    feedback: StoredFeedback,
  ): Promise<void> {
    const t = performance.now();
    try {
      const audio = await this.tts.getOrCreate(feedback.spokenSummary, {
        sessionId: attempt.sessionId,
        attemptId: attempt.id,
      });
      await this.prisma.attempt.update({
        where: { id: attempt.id },
        data: {
          feedbackAudioKey: audio.key,
          feedback: {
            ...feedback,
            audioSeconds: Math.round(audio.durationS),
          } as unknown as Prisma.InputJsonObject,
        },
      });
      await this.publish(attempt.sessionId, {
        type: 'feedback.audio_ready',
        attemptId: attempt.id,
        url: `/api/attempts/${attempt.id}/feedback-audio`,
      });
      this.logger.log(`attempt ${attempt.id} step=tts ms=${elapsed(t)}`);
    } catch (err) {
      this.logger.warn(
        `attempt ${attempt.id} step=tts failed after ${elapsed(t)} ms (${errName(err)}); text feedback stands`,
      );
    }
  }

  private async fail(attempt: Attempt, code: 'ai_unavailable'): Promise<void> {
    await this.prisma.attempt.update({
      where: { id: attempt.id },
      data: { status: 'failed', error: code },
    });
    await this.publish(attempt.sessionId, {
      type: 'attempt.failed',
      attemptId: attempt.id,
      code,
      retryable: true,
      textModeOffered: attempt.mode === 'voice',
    });
  }

  private async publish(sessionId: string, event: SessionEvent): Promise<void> {
    try {
      await this.events.publish(sessionChannel(sessionId), event);
    } catch (err) {
      // The state is in Postgres; the client can poll GET /attempts/:id (NFR-03).
      this.logger.warn(
        `publish ${event.type} failed for session ${sessionId} (${errName(err)})`,
      );
    }
  }
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** Log label for a failure. Every failure is reported to the client as `ai_unavailable` (FR-INT-09). */
function failureCode(err: unknown): string {
  if (err instanceof PipelineFailure) return err.code;
  if (err instanceof SttUnavailableError) return 'stt_unavailable';
  if (err instanceof AppError) return err.code;
  return 'internal';
}
