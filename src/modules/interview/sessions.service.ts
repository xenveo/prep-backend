import { randomInt } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { AppError, conflict, notFound } from '../../common/errors/app-error.js';
import {
  type Band,
  type JobRole,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { InterviewerService } from '../ai/interviewer.service.js';
import { PromptService } from '../ai/prompt.service.js';
import { SummariserService } from '../ai/summariser.service.js';
import { ContentQueryService } from '../content/content-query.service.js';
import { TtsCacheService } from '../content/tts-cache.service.js';
import { AssignmentsService } from '../users/assignments.service.js';
import type {
  StartSessionBody,
  StartedSession,
  SessionView,
} from './interview.schemas.js';
import {
  BAND_MESSAGES,
  learningScore,
  sessionScore,
  skillsAverage,
} from './scoring/score.js';
import {
  toInterviewQuestion,
  toQuestionResult,
  toSessionReport,
} from './serializers/candidate.serializer.js';
import {
  currentQuestionOf,
  type LoadedSession,
  questionStates,
  SESSION_INCLUDE,
  toInProgressView,
} from './session-state.js';
import {
  DEFAULT_ROLE_SETTINGS,
  type DimensionScores,
  type RoleSettings,
  type StoredFeedback,
  type WeightsSnapshot,
} from './types.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

export const roleSettings = (
  role: Pick<JobRole, 'settings'>,
): RoleSettings => ({
  ...DEFAULT_ROLE_SETTINGS,
  ...(role.settings as Partial<RoleSettings> | null),
});

/** Admin-style band labels used in activity texts ("Completed session 3 · 78 Nearly ready"). */
const BAND_LABELS: Record<Band, string> = {
  not_ready: 'Not ready',
  developing: 'Developing',
  nearly_ready: 'Nearly ready',
  interview_ready: 'Interview ready',
};

const sessionInProgress = (session: StartedSession) =>
  new AppError(
    'session_in_progress',
    409,
    'A session is already in progress for this role',
    { session },
  );

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/**
 * Interview sessions (spec "Candidate API", plan §6): start, resume, skip-retry, complete, abandon.
 * A session is visible only to its owner; anything else is 404.
 */
@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly assignments: AssignmentsService,
    private readonly content: ContentQueryService,
    private readonly tts: TtsCacheService,
    private readonly prompts: PromptService,
    private readonly interviewer: InterviewerService,
    private readonly summariser: SummariserService,
    private readonly activity: ActivityService,
  ) {}

  /** POST /roles/:roleId/sessions. 403 when blocked, 409 with the session when one is in progress. */
  async start(
    user: AuthUser,
    roleRef: string,
    body: StartSessionBody,
    ip: string | null,
  ): Promise<StartedSession> {
    const { assignment, role } = await this.assignments.findCandidateRole(
      user.id,
      roleRef,
    );
    if (user.accessExpiresAt && user.accessExpiresAt <= new Date()) {
      throw new AppError('access_expired', 403, 'Your access has expired');
    }
    await this.throwIfInProgress(user, role);

    const stats = await this.assignments.getStats(user.id, role.id);
    const left = this.assignments.attemptsLeft(assignment, role, stats);
    if (left !== null && left <= 0) {
      throw new AppError(
        'attempt_limit',
        403,
        'You have used all your practice sessions for this role',
      );
    }
    if (roleSettings(role).requireAllCards) {
      const [total, viewed] = await Promise.all([
        this.content.approvedCardCount(role.id),
        this.content.viewedApprovedCardCount(user.id, role.id),
      ]);
      if (viewed < total) {
        throw new AppError(
          'cards_not_viewed',
          403,
          'Study every flash card before starting an interview',
        );
      }
    }
    return this.create(user, role, body, ip, false);
  }

  /** POST /admin/roles/:id/preview-session (FR-ROLE-07): no assignment, limit or card checks. */
  async startPreview(
    user: AuthUser,
    roleId: string,
    body: StartSessionBody,
    ip: string | null,
  ): Promise<{ session: StartedSession; role: JobRole }> {
    if (!isUuid(roleId)) throw notFound('Role not found');
    const role = await this.prisma.jobRole.findUnique({
      where: { id: roleId },
    });
    if (!role || role.status === 'archived') throw notFound('Role not found');
    await this.throwIfInProgress(user, role);
    return { session: await this.create(user, role, body, ip, true), role };
  }

  /** GET /sessions/:id: resume state while in progress, the report once completed. */
  async get(userId: string, sessionId: string): Promise<SessionView> {
    const session = await this.loadOwned(userId, sessionId);
    if (session.status === 'completed') return this.report(session);
    if (session.status !== 'in_progress') throw notFound('Session not found');
    return toInProgressView(session);
  }

  /** POST /sessions/:id/questions/:questionId/skip-retry (FR-RETRY-05). */
  async skipRetry(
    userId: string,
    sessionId: string,
    questionId: string,
  ): Promise<void> {
    const session = await this.loadInProgress(userId, sessionId);
    const states = questionStates(session);
    const state = states.find((s) => s.sq.questionId === questionId);
    if (!state) throw notFound('Question not found');
    if (state.first?.status !== 'done') {
      throw conflict('The first try is not finished yet');
    }
    if (state.second) throw conflict('The second try was already submitted');
    if (state.sq.retrySkipped) return;
    state.sq.retrySkipped = true;
    state.done = true;
    await this.prisma.$transaction([
      this.prisma.sessionQuestion.update({
        where: {
          sessionId_position: { sessionId, position: state.sq.position },
        },
        data: { retrySkipped: true },
      }),
      this.prisma.session.update({
        where: { id: sessionId },
        data: { currentQuestion: currentQuestionOf(states) },
      }),
    ]);
  }

  /** POST /sessions/:id/complete. Idempotent: a completed session returns its report. */
  async complete(userId: string, sessionId: string): Promise<SessionView> {
    const session = await this.loadOwned(userId, sessionId);
    if (session.status === 'completed') return this.report(session);
    if (session.status !== 'in_progress') {
      throw conflict('This session can no longer be completed');
    }
    const states = questionStates(session);
    if (states.length === 0 || states.some((s) => !s.done)) {
      throw conflict('Answer every question before finishing');
    }

    const weights = session.weightsSnapshot as WeightsSnapshot;
    const perQuestion = states.map((s) => {
      const first = s.first!;
      const second = s.sq.retrySkipped ? null : s.second;
      const secondFeedback = second?.feedback as StoredFeedback | null;
      return {
        first: first.score ?? 0,
        second: second ? (second.score ?? 0) : null,
        learning: second
          ? (second.learningScore ??
            learningScore(secondFeedback?.applied ?? []))
          : null,
      };
    });
    const totals = sessionScore(perQuestion, weights.sessionWeights);
    const skills = skillsAverage(
      states.flatMap((s) =>
        [s.first, s.sq.retrySkipped ? null : s.second]
          .filter((a) => a?.dimensionScores)
          .map((a) => a!.dimensionScores as DimensionScores),
      ),
    );

    const summary = await this.summariser.summarise({
      sessionId,
      roleTitle: session.role.title,
      questions: states.map((s, i) => {
        const first = s.first!.feedback as StoredFeedback | null;
        const second = s.sq.retrySkipped
          ? null
          : (s.second?.feedback as StoredFeedback | null);
        return {
          position: s.sq.position,
          text: s.sq.question.text,
          firstScore: perQuestion[i].first,
          secondScore: perQuestion[i].second,
          improvementPoints: first?.improvementPoints ?? [],
          worked: (second ?? first)?.worked ?? [],
        };
      }),
    });
    const cardFor = new Map(
      states.map((s) => [s.sq.position, s.sq.question.card?.position ?? 0]),
    );
    const toPoint = (p: { text: string; questionPosition: number }) => ({
      text: p.text,
      cardId: cardFor.get(p.questionPosition) ?? 0,
    });

    const completedAt = new Date();
    const updated = await this.prisma.session.updateMany({
      where: { id: sessionId, status: 'in_progress' },
      data: {
        status: 'completed',
        completedAt,
        durationS: Math.max(
          0,
          Math.round(
            (completedAt.getTime() - session.startedAt.getTime()) / 1000,
          ),
        ),
        currentQuestion: states.length + 1,
        firstTryAvg: totals.firstTryAvg,
        retryAvg: totals.retryAvg,
        learningAvg: totals.learningAvg,
        score: totals.score,
        band: totals.band,
        bandMessage: BAND_MESSAGES[totals.band],
        skills,
        strengths: summary.strengths.map(toPoint),
        focusAreas: summary.focusAreas.map(toPoint),
      },
    });
    const fresh = await this.loadOwned(userId, sessionId);
    if (fresh.status !== 'completed') {
      throw conflict('This session can no longer be completed');
    }
    if (updated.count === 1 && !fresh.isPreview) {
      const baseline = fresh.number === 1 ? ' (baseline)' : '';
      await this.activity.record(
        userId,
        `Completed session ${fresh.number} · ${totals.score} ${BAND_LABELS[totals.band]}${baseline}`,
        completedAt,
      );
    }
    return this.report(fresh);
  }

  /** POST /sessions/:id/abandon. */
  async abandon(userId: string, sessionId: string): Promise<void> {
    const session = await this.loadOwned(userId, sessionId);
    if (session.status === 'abandoned') return;
    if (session.status !== 'in_progress') {
      throw conflict('Only a session in progress can be abandoned');
    }
    await this.prisma.session.updateMany({
      where: { id: sessionId, status: 'in_progress' },
      data: { status: 'abandoned' },
    });
  }

  /** The owner's session with questions and attempts. 404 for anyone else. */
  async loadOwned(userId: string, sessionId: string): Promise<LoadedSession> {
    if (!isUuid(sessionId)) throw notFound('Session not found');
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, userId },
      include: SESSION_INCLUDE,
    });
    if (!session) throw notFound('Session not found');
    return session;
  }

  async loadInProgress(
    userId: string,
    sessionId: string,
  ): Promise<LoadedSession> {
    const session = await this.loadOwned(userId, sessionId);
    if (session.status !== 'in_progress') {
      throw conflict('This session is not in progress');
    }
    return session;
  }

  report(session: LoadedSession) {
    const results = questionStates(session).map((s) =>
      toQuestionResult(s.sq, s.first!, s.sq.retrySkipped ? null : s.second),
    );
    return toSessionReport(session, results, session.role.slug);
  }

  private async throwIfInProgress(
    user: AuthUser,
    role: Pick<JobRole, 'id' | 'title'>,
  ): Promise<void> {
    const existing = await this.prisma.session.findFirst({
      where: { userId: user.id, jobRoleId: role.id, status: 'in_progress' },
      include: SESSION_INCLUDE,
    });
    if (existing) {
      throw sessionInProgress(await this.startedView(user, existing));
    }
  }

  private async create(
    user: AuthUser,
    role: JobRole,
    body: StartSessionBody,
    ip: string | null,
    isPreview: boolean,
  ): Promise<StartedSession> {
    const settings = roleSettings(role);
    const pool = await this.content.listApprovedQuestions(role.id);
    if (pool.length === 0) {
      throw conflict('This role has no interview questions yet');
    }
    const ordered = settings.questionOrder === 'random' ? shuffle(pool) : pool;
    const picked = ordered.slice(0, settings.questionsPerSession);
    const weightsSnapshot: WeightsSnapshot = {
      sessionWeights: settings.sessionWeights,
      dimensionWeights: settings.dimensionWeights,
    };
    const promptVersions = await this.prompts.snapshotVersions();

    let session: LoadedSession;
    try {
      session = await this.prisma.$transaction(async (tx) => {
        const last = await tx.session.aggregate({
          where: { userId: user.id, jobRoleId: role.id },
          _max: { number: true },
        });
        const created = await tx.session.create({
          data: {
            userId: user.id,
            jobRoleId: role.id,
            number: (last._max.number ?? 0) + 1,
            mode: body.mode,
            isPreview,
            weightsSnapshot,
            promptVersions,
            questions: {
              create: picked.map((q, i) => ({
                questionId: q.id,
                position: i + 1,
              })),
            },
          },
        });
        await tx.consent.create({
          data: {
            sessionId: created.id,
            userId: user.id,
            kind: 'recording',
            textVersion: body.consent.version,
            ip,
          },
        });
        return tx.session.findUniqueOrThrow({
          where: { id: created.id },
          include: SESSION_INCLUDE,
        });
      });
    } catch (e) {
      // A concurrent start won the partial unique index (or the session number): resume that one.
      if (isUniqueViolation(e)) await this.throwIfInProgress(user, role);
      throw e;
    }
    return this.startedView(user, session);
  }

  /** The 201 body of a start, also used for the 409 resume body. Never fails on TTS. */
  private async startedView(
    user: Pick<AuthUser, 'name'>,
    session: LoadedSession,
  ): Promise<StartedSession> {
    const text = this.interviewer.intro({
      roleTitle: session.role.title,
      candidateName: user.name ?? '',
      questionCount: session.questions.length,
    });
    let audioUrl: string | null = null;
    try {
      const { key } = await this.tts.getOrCreate(text, {
        sessionId: session.id,
      });
      audioUrl = await this.tts.signedUrl(key);
    } catch (e) {
      this.logger.warn(
        `intro audio unavailable for session ${session.id}: ${(e as Error).name}`,
      );
    }
    return {
      id: session.id,
      number: session.number,
      questions: session.questions.map(toInterviewQuestion),
      intro: { text, audioUrl },
      currentQuestion: currentQuestionOf(questionStates(session)),
    };
  }
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
