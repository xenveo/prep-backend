import type { AuthUser } from '../../common/auth/auth.types.js';
import { AppError, notFound } from '../../common/errors/app-error.js';
import type { AppConfig } from '../../config/app-config.js';
import type { EmailService } from '../../jobs/email/email.service.js';
import type { ActivityService } from '../activity/activity.service.js';
import { InterviewerService } from '../ai/interviewer.service.js';
import type { PromptService } from '../ai/prompt.service.js';
import type { SummariserService } from '../ai/summariser.service.js';
import type { ContentQueryService } from '../content/content-query.service.js';
import type { TtsCacheService } from '../content/tts-cache.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { DEFAULT_WORKSPACE_SETTINGS } from '../settings/settings.schema.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { AssignmentsService } from '../users/assignments.service.js';
import type { UsersService } from '../users/users.service.js';
import {
  attempt,
  feedback,
  loadedSession,
  qid,
  ROLE_ID,
  SESSION_ID,
  USER_ID,
} from './fixtures.test-spec.js';
import { SessionsService } from './sessions.service.js';

const user: AuthUser = {
  id: USER_ID,
  email: 'c@example.test',
  name: 'Asha Rao',
  role: 'candidate',
  status: 'active',
  accessExpiresAt: null,
  authSessionId: 'as1',
};

const role = {
  id: ROLE_ID,
  slug: 'store-manager',
  title: 'Store Manager',
  status: 'approved',
  settings: { requireAllCards: true, questionsPerSession: 2 },
};

const body = {
  mode: 'typed' as const,
  consent: { recording: true as const, text: 'I agree', version: 'v1' },
};

function setup() {
  const prisma = {
    session: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    sessionQuestion: { update: vi.fn() },
    jobRole: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  };
  const tx = {
    session: {
      aggregate: vi.fn().mockResolvedValue({ _max: { number: 2 } }),
      create: vi.fn().mockResolvedValue({ id: SESSION_ID }),
      findUniqueOrThrow: vi.fn(),
    },
    consent: { create: vi.fn() },
  };
  prisma.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function' ? arg(tx) : Promise.all(arg as unknown[]),
  );
  const assignments = {
    findCandidateRole: vi.fn().mockResolvedValue({
      assignment: { maxAttempts: null },
      role,
    }),
    getStats: vi.fn().mockResolvedValue({ sessionsUsed: 1 }),
    attemptsLeft: vi.fn().mockReturnValue(3),
  };
  const content = {
    approvedCardCount: vi.fn().mockResolvedValue(4),
    viewedApprovedCardCount: vi.fn().mockResolvedValue(4),
    listApprovedQuestions: vi
      .fn()
      .mockResolvedValue(
        [1, 2, 3].map((n) => ({ id: qid(n), card: { position: n } })),
      ),
  };
  const tts = {
    getOrCreate: vi.fn().mockResolvedValue({ key: 'tts/x.mp3', durationS: 5 }),
    signedUrl: vi.fn().mockResolvedValue('https://signed/tts/x.mp3'),
  };
  const prompts = {
    snapshotVersions: vi
      .fn()
      .mockResolvedValue({ interviewer: 1, evaluator: 2, summariser: 1 }),
  };
  const summariser = { summarise: vi.fn() };
  const activity = { record: vi.fn() };
  const settings = {
    get: vi.fn().mockResolvedValue(DEFAULT_WORKSPACE_SETTINGS),
  };
  const users = {
    findCandidate: vi
      .fn()
      .mockResolvedValue({ id: USER_ID, email: user.email, name: user.name }),
  };
  const email = { send: vi.fn().mockResolvedValue(undefined) };
  const config = { env: { APP_CANDIDATE_ORIGIN: 'https://app.test' } };
  const service = new SessionsService(
    prisma as unknown as PrismaService,
    assignments as unknown as AssignmentsService,
    content as unknown as ContentQueryService,
    tts as unknown as TtsCacheService,
    prompts as unknown as PromptService,
    new InterviewerService(),
    summariser as unknown as SummariserService,
    activity as unknown as ActivityService,
    settings as unknown as SettingsService,
    users as unknown as UsersService,
    email as unknown as EmailService,
    config as unknown as AppConfig,
  );
  return {
    service,
    prisma,
    tx,
    assignments,
    content,
    tts,
    summariser,
    activity,
    settings,
    users,
    email,
  };
}

async function errorOf(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a rejection');
}

describe('SessionsService.start', () => {
  it('403 access_expired', async () => {
    const { service } = setup();
    const e = await errorOf(
      service.start(
        { ...user, accessExpiresAt: new Date(Date.now() - 1000) },
        'store-manager',
        body,
        null,
      ),
    );
    expect([e.status, e.code]).toEqual([403, 'access_expired']);
  });

  it('409 session_in_progress with the resumable session', async () => {
    const { service, prisma, assignments } = setup();
    assignments.attemptsLeft.mockReturnValue(0);
    prisma.session.findFirst.mockResolvedValue(
      loadedSession(2, [attempt(1, 1)], {}, [1]),
    );
    const e = await errorOf(service.start(user, 'store-manager', body, null));
    expect([e.status, e.code]).toEqual([409, 'session_in_progress']);
    expect(e.extra?.session).toMatchObject({
      id: SESSION_ID,
      number: 1,
      currentQuestion: 2,
      intro: { audioUrl: 'https://signed/tts/x.mp3' },
    });
  });

  it('403 attempt_limit', async () => {
    const { service, prisma, assignments } = setup();
    prisma.session.findFirst.mockResolvedValue(null);
    assignments.attemptsLeft.mockReturnValue(0);
    const e = await errorOf(service.start(user, 'store-manager', body, null));
    expect([e.status, e.code]).toEqual([403, 'attempt_limit']);
  });

  it('403 cards_not_viewed', async () => {
    const { service, prisma, content } = setup();
    prisma.session.findFirst.mockResolvedValue(null);
    content.viewedApprovedCardCount.mockResolvedValue(3);
    const e = await errorOf(service.start(user, 'store-manager', body, null));
    expect([e.status, e.code]).toEqual([403, 'cards_not_viewed']);
  });

  it('creates the session, questions, snapshots and consent in one transaction', async () => {
    const { service, prisma, tx } = setup();
    prisma.session.findFirst.mockResolvedValue(null);
    tx.session.findUniqueOrThrow.mockResolvedValue(
      loadedSession(2, [], { number: 3 }),
    );
    const started = await service.start(user, 'store-manager', body, '1.2.3.4');
    const data = tx.session.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      userId: USER_ID,
      jobRoleId: ROLE_ID,
      number: 3,
      mode: 'typed',
      isPreview: false,
      promptVersions: { interviewer: 1, evaluator: 2, summariser: 1 },
      weightsSnapshot: {
        sessionWeights: { firstTry: 20, secondTry: 55, learning: 25 },
      },
      questions: {
        create: [
          { questionId: qid(1), position: 1 },
          { questionId: qid(2), position: 2 },
        ],
      },
    });
    expect(tx.consent.create.mock.calls[0][0].data).toEqual({
      sessionId: SESSION_ID,
      userId: USER_ID,
      kind: 'recording',
      textVersion: 'v1',
      ip: '1.2.3.4',
    });
    expect(started).toMatchObject({
      id: SESSION_ID,
      number: 3,
      currentQuestion: 1,
      intro: { audioUrl: 'https://signed/tts/x.mp3' },
    });
    expect(started.intro.text).toContain('Store Manager');
  });

  it('starts without intro audio when TTS fails', async () => {
    const { service, prisma, tx, tts } = setup();
    prisma.session.findFirst.mockResolvedValue(null);
    tx.session.findUniqueOrThrow.mockResolvedValue(loadedSession(2, []));
    tts.getOrCreate.mockRejectedValue(new Error('tts down'));
    const started = await service.start(user, 'store-manager', body, null);
    expect(started.intro.audioUrl).toBeNull();
  });
});

type Ctx = ReturnType<typeof setup>;

/** One answered question (60, retry skipped: session score 58), ready to complete. `count` 0 = another request completed it first. */
function completable(
  ctx: Ctx,
  opts: { count?: number; isPreview?: boolean } = {},
): Ctx {
  const inProgress = loadedSession(1, [attempt(1, 1, { score: 60 })], {}, [1]);
  ctx.prisma.session.findFirst
    .mockResolvedValueOnce(inProgress)
    .mockImplementationOnce(async () => ({
      ...inProgress,
      ...ctx.prisma.session.updateMany.mock.calls[0][0].data,
      isPreview: opts.isPreview ?? false,
    }));
  ctx.prisma.session.updateMany.mockResolvedValue({ count: opts.count ?? 1 });
  ctx.summariser.summarise.mockResolvedValue({
    strengths: [],
    focusAreas: [],
    source: 'llm',
  });
  return ctx;
}

function emailOn(ctx: Ctx) {
  ctx.settings.get.mockResolvedValue({
    ...DEFAULT_WORKSPACE_SETTINGS,
    sessionCompleteEmail: true,
  });
}

describe('SessionsService.complete', () => {
  it('scores with the snapshot weights, counting a skipped retry as A2 = A1 and L = 50', async () => {
    const { service, prisma, summariser, activity } = setup();
    // Q1: 40 then 80 (applied 1 + partly 0.5 → learning 75). Q2: 60, retry skipped.
    // A1 = 50, A2 = 70, L = (75 + 50) / 2 = 62.5 → 0.2·50 + 0.55·70 + 0.25·62.5 = 64.125 → 64 (developing).
    const attempts = [
      attempt(1, 1, { score: 40 }),
      attempt(1, 2, {
        score: 80,
        feedback: feedback({
          applied: [
            { point: 'Result', status: 'applied', evidence: 'x' },
            { point: 'Owner', status: 'partly', evidence: 'y' },
          ],
        }),
      }),
      attempt(2, 1, { score: 60 }),
    ];
    const inProgress = loadedSession(2, attempts, {}, [2]);
    prisma.session.findFirst
      .mockResolvedValueOnce(inProgress)
      .mockImplementationOnce(async () => ({
        ...inProgress,
        ...prisma.session.updateMany.mock.calls[0][0].data,
      }));
    prisma.session.updateMany.mockResolvedValue({ count: 1 });
    summariser.summarise.mockResolvedValue({
      strengths: [{ text: 'Owned it', questionPosition: 1 }],
      focusAreas: [{ text: 'Add results', questionPosition: 2 }],
      source: 'llm',
    });

    const report = await service.complete(USER_ID, SESSION_ID);

    const data = prisma.session.updateMany.mock.calls[0][0].data;
    expect(data).toMatchObject({
      status: 'completed',
      firstTryAvg: 50,
      retryAvg: 70,
      learningAvg: 62.5,
      score: 64,
      band: 'developing',
      bandMessage: 'Review flash cards and retake',
      skills: { content: 60, structure: 60, delivery: 60, relevance: 60 },
      strengths: [{ text: 'Owned it', cardId: 3 }],
      focusAreas: [{ text: 'Add results', cardId: 4 }],
    });
    expect(summariser.summarise.mock.calls[0][0].questions[1]).toMatchObject({
      position: 2,
      firstScore: 60,
      secondScore: null,
    });
    expect(report).toMatchObject({
      roleId: 'store-manager',
      score: 64,
      band: 'developing',
    });
    expect('results' in report && report.results[1].second).toBeNull();
    expect(activity.record).toHaveBeenCalledWith(
      USER_ID,
      'Completed session 1 · 64 Developing (baseline)',
      expect.any(Date),
    );
  });

  it('does not email results while the workspace setting is off', async () => {
    const { service, email, users } = completable(setup());
    await service.complete(USER_ID, SESSION_ID);
    expect(users.findCandidate).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('emails the candidate a results link once when the setting is on', async () => {
    const ctx = completable(setup());
    emailOn(ctx);
    await ctx.service.complete(USER_ID, SESSION_ID);
    expect(ctx.users.findCandidate).toHaveBeenCalledWith(USER_ID);
    expect(ctx.email.send).toHaveBeenCalledTimes(1);
    expect(ctx.email.send).toHaveBeenCalledWith({
      template: 'session-complete',
      to: 'c@example.test',
      vars: {
        name: 'Asha Rao',
        roleTitle: 'Store Manager',
        score: 58,
        link: `https://app.test/roles/store-manager/results/${SESSION_ID}`,
      },
    });
  });

  it('a retried complete that lost the race (or found it done) sends nothing', async () => {
    const raced = completable(setup(), { count: 0 });
    emailOn(raced);
    await raced.service.complete(USER_ID, SESSION_ID);
    expect(raced.email.send).not.toHaveBeenCalled();

    const done = setup();
    emailOn(done);
    done.prisma.session.findFirst.mockResolvedValue(
      loadedSession(
        1,
        [attempt(1, 1)],
        {
          status: 'completed',
          completedAt: new Date(),
          score: 70,
          band: 'nearly_ready',
        },
        [1],
      ),
    );
    await done.service.complete(USER_ID, SESSION_ID);
    expect(done.email.send).not.toHaveBeenCalled();
  });

  it('never emails for a preview session', async () => {
    const ctx = completable(setup(), { isPreview: true });
    emailOn(ctx);
    await ctx.service.complete(USER_ID, SESSION_ID);
    expect(ctx.email.send).not.toHaveBeenCalled();
  });

  it('completes even when the candidate is gone or enqueueing fails', async () => {
    const gone = completable(setup());
    emailOn(gone);
    gone.users.findCandidate.mockRejectedValue(notFound('Candidate not found'));
    await expect(
      gone.service.complete(USER_ID, SESSION_ID),
    ).resolves.toMatchObject({ score: 58 });
    expect(gone.email.send).not.toHaveBeenCalled();

    const failing = completable(setup());
    emailOn(failing);
    failing.email.send.mockRejectedValue(new Error('redis down'));
    await expect(
      failing.service.complete(USER_ID, SESSION_ID),
    ).resolves.toMatchObject({ score: 58 });
  });

  it('409 when a question is not done', async () => {
    const { service, prisma } = setup();
    prisma.session.findFirst.mockResolvedValue(
      loadedSession(2, [attempt(1, 1)]),
    );
    const e = await errorOf(service.complete(USER_ID, SESSION_ID));
    expect([e.status, e.code]).toEqual([409, 'conflict']);
  });

  it('returns the report again for a completed session', async () => {
    const { service, prisma, summariser } = setup();
    prisma.session.findFirst.mockResolvedValue(
      loadedSession(
        1,
        [attempt(1, 1)],
        {
          status: 'completed',
          completedAt: new Date(),
          score: 70,
          band: 'nearly_ready',
        },
        [1],
      ),
    );
    const report = await service.complete(USER_ID, SESSION_ID);
    expect(report).toMatchObject({ score: 70, band: 'nearly-ready' });
    expect(summariser.summarise).not.toHaveBeenCalled();
  });

  it('404 for a session that is not the user’s (or not a uuid)', async () => {
    const { service, prisma } = setup();
    prisma.session.findFirst.mockResolvedValue(null);
    expect((await errorOf(service.get(USER_ID, SESSION_ID))).status).toBe(404);
    expect((await errorOf(service.get(USER_ID, 'nope'))).status).toBe(404);
  });
});

describe('SessionsService.skipRetry', () => {
  it('requires attempt 1 done', async () => {
    const { service, prisma } = setup();
    prisma.session.findFirst.mockResolvedValue(
      loadedSession(2, [attempt(1, 1, { status: 'evaluating' })]),
    );
    const e = await errorOf(service.skipRetry(USER_ID, SESSION_ID, qid(1)));
    expect(e.status).toBe(409);
  });

  it('rejects when attempt 2 exists', async () => {
    const { service, prisma } = setup();
    prisma.session.findFirst.mockResolvedValue(
      loadedSession(2, [attempt(1, 1), attempt(1, 2, { status: 'received' })]),
    );
    const e = await errorOf(service.skipRetry(USER_ID, SESSION_ID, qid(1)));
    expect(e.status).toBe(409);
  });

  it('marks the retry skipped and advances currentQuestion', async () => {
    const { service, prisma } = setup();
    prisma.session.findFirst.mockResolvedValue(
      loadedSession(2, [attempt(1, 1)]),
    );
    await service.skipRetry(USER_ID, SESSION_ID, qid(1));
    expect(prisma.sessionQuestion.update).toHaveBeenCalledWith({
      where: { sessionId_position: { sessionId: SESSION_ID, position: 1 } },
      data: { retrySkipped: true },
    });
    expect(prisma.session.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: { currentQuestion: 2 },
    });
  });
});
