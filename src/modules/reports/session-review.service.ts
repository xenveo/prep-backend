import { Inject, Injectable } from '@nestjs/common';
import {
  STORAGE_ADAPTER,
  type StorageAdapter,
} from '../../adapters/storage/storage.adapter.js';
import { notFound } from '../../common/errors/app-error.js';
import { toAdminBand } from '../../common/mapping/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  DEFAULT_ROLE_SETTINGS,
  type WeightsSnapshot,
} from '../interview/types.js';
import {
  sessionFormulaText,
  toReviewQuestion,
  toTry,
} from './session-review.mapper.js';
import type { ReviewQuestion, SessionReview } from './reports.types.js';

/** Admin review of one completed session: every question, both tries, transcripts (FR-REP-02). */
@Injectable()
export class SessionReviewService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
  ) {}

  async review(
    candidateId: string,
    sessionId: string,
    now = new Date(),
  ): Promise<SessionReview> {
    const session = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        userId: candidateId,
        isPreview: false,
        status: 'completed',
        score: { not: null },
        user: { role: 'candidate' },
      },
      include: {
        user: { select: { name: true, email: true } },
        role: { select: { title: true } },
        questions: {
          orderBy: { position: 'asc' },
          include: {
            question: { select: { text: true, category: true } },
          },
        },
        attempts: { orderBy: { attemptNo: 'asc' } },
      },
    });
    if (!session) throw notFound('Session not found');

    const previous = await this.prisma.session.findFirst({
      where: {
        userId: candidateId,
        jobRoleId: session.jobRoleId,
        isPreview: false,
        status: 'completed',
        score: { not: null },
        number: { lt: session.number },
      },
      orderBy: { number: 'desc' },
      select: { score: true },
    });

    const tryOf = async (a: (typeof session.attempts)[number]) =>
      toTry(
        a,
        a.audioKey && a.audioExpiresAt && a.audioExpiresAt > now
          ? await this.storage.signedUrl(a.audioKey)
          : null,
      );

    const questions: ReviewQuestion[] = [];
    for (const sq of session.questions) {
      const mine = session.attempts.filter(
        (a) => a.questionId === sq.questionId && a.score !== null,
      );
      const first = mine.find((a) => a.attemptNo === 1);
      if (!first) continue;
      const second = mine.find((a) => a.attemptNo === 2);
      questions.push(
        toReviewQuestion({
          position: sq.position,
          text: sq.question.text,
          category: sq.question.category,
          retrySkipped: sq.retrySkipped,
          first: await tryOf(first),
          second: second ? await tryOf(second) : null,
        }),
      );
    }

    const snapshot = session.weightsSnapshot as Partial<WeightsSnapshot> | null;
    const weights =
      snapshot?.sessionWeights ?? DEFAULT_ROLE_SETTINGS.sessionWeights;
    const score = session.score!;
    return {
      sessionId: session.id,
      candidateId,
      candidateName: session.user.name?.trim() || session.user.email,
      roleId: session.jobRoleId,
      roleTitle: session.role.title,
      sessionNumber: session.number,
      date: (session.completedAt ?? session.startedAt).toISOString(),
      durationMin: Math.round((session.durationS ?? 0) / 60),
      score,
      band: toAdminBand(session.band!),
      changeVsPrevious: previous?.score != null ? score - previous.score : null,
      firstTryAvg: session.firstTryAvg,
      secondTryAvg: session.retryAvg,
      learningScore: session.learningAvg,
      hasDetail: true,
      questions,
      weights,
      formulaText: sessionFormulaText(score, weights),
    };
  }
}
