import type { PrismaService } from '../../prisma/prisma.service.js';
import { ExecutiveInsightsService } from './executive-insights.service.js';

const at = (s: string) => new Date(s);
const NOW = at('2026-11-02T12:00:00Z');
const role = { id: 'role-1', title: 'Engineering' };
const session = (
  id: string,
  completedAt: string | null,
  over: object = {},
) => ({
  id,
  userId: 'candidate-1',
  jobRoleId: role.id,
  status: 'completed',
  startedAt: at(completedAt ?? '2026-10-10T00:00:00Z'),
  completedAt: completedAt ? at(completedAt) : null,
  score: 60,
  band: 'developing',
  _count: { attempts: 1 },
  ...over,
});
const assignment = (over: object = {}) => ({
  userId: 'candidate-1',
  jobRoleId: role.id,
  assignedAt: at('2026-08-01T00:00:00Z'),
  removedAt: null,
  user: {
    name: 'Candidate',
    email: 'candidate@example.test',
    status: 'active',
    lastActiveAt: at('2026-09-01T00:00:00Z'),
    accessExpiresAt: null,
  },
  ...over,
});
function setup() {
  const prisma = {
    jobRole: { findMany: vi.fn().mockResolvedValue([role]) },
    session: { findMany: vi.fn().mockResolvedValue([]) },
    roleAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    attempt: { findMany: vi.fn().mockResolvedValue([]) },
    evaluationFlag: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const transaction = vi.fn((read: (db: unknown) => unknown) => read(prisma));
  Object.assign(prisma, { $transaction: transaction });
  return {
    prisma,
    service: new ExecutiveInsightsService(prisma as unknown as PrismaService),
  };
}

describe('ExecutiveInsightsService', () => {
  it('returns unknown rates and honest unavailable measures for an empty database', async () => {
    const { service } = setup();
    const report = await service.report({ period: '2026-10' }, NOW);
    expect(report.funnel.activation).toEqual({ num: 0, den: 0, value: null });
    expect(report.quality.completion.value).toBeNull();
    expect(report.quality.flagRate).toBeNull();
    expect(report.quality.resolutionHours).toBeNull();
    expect(report.timeToReady.medianDays).toBeNull();
    expect(report.timeToReady.attainment.value).toBeNull();
    expect(report.unavailable.map((m) => m.metric)).toContain(
      'Feedback delivery success',
    );
    expect(report.meta.cutoff).toBe('2026-11-01T00:00:00.000Z');
  });

  it('uses stored bands, latest pre-cutoff completion and full sixty-day attainment cohorts', async () => {
    const { service, prisma } = setup();
    prisma.session.findMany.mockResolvedValue([
      session('early', '2026-08-01T00:00:00Z', {
        score: 20,
        band: 'not_ready',
      }),
      // A stored ready band is authoritative even if the score threshold subsequently changed.
      session('ready', '2026-10-01T00:00:00Z', {
        score: 80,
        band: 'interview_ready',
      }),
      session('future', '2026-11-01T00:00:00Z', {
        score: 10,
        band: 'not_ready',
      }),
      session('young', '2026-10-15T00:00:00Z', {
        userId: 'young',
        score: 90,
        band: 'interview_ready',
      }),
    ]);
    prisma.roleAssignment.findMany.mockResolvedValue([
      assignment(),
      assignment({ userId: 'unassessed' }),
    ]);
    const report = await service.report({ period: '2026-10' }, NOW);
    expect(report.pipeline[0]).toMatchObject({
      bands: { ready: 2, not_ready: 0 },
      newlyReady: 2,
      unassessed: 1,
    });
    // 61 days: the old pair did not become ready within 60; the young pair is not yet eligible.
    expect(report.timeToReady.attainment).toEqual({ num: 0, den: 1, value: 0 });
    expect(report.timeToReady.medianDays).toBe(30.5);
  });

  it('keeps unfinished sessions separate and freezes flag resolutions at cutoff', async () => {
    const { service, prisma } = setup();
    prisma.session.findMany.mockResolvedValue([
      session('done', '2026-10-11T00:00:00Z'),
      session('unfinished', null, { status: 'in_progress' }),
      session('abandoned', null, { status: 'abandoned' }),
      session('later-completion', '2026-11-02T00:00:00Z', {
        startedAt: at('2026-10-10T00:00:00Z'),
      }),
      session('no-answer', null, {
        status: 'in_progress',
        _count: { attempts: 0 },
      }),
    ]);
    prisma.evaluationFlag.findMany.mockResolvedValue([
      {
        issue: 'too_high',
        createdAt: at('2026-10-10T00:00:00Z'),
        resolvedAt: at('2026-10-11T00:00:00Z'),
      },
      {
        issue: 'transcript_wrong',
        createdAt: at('2026-10-30T00:00:00Z'),
        resolvedAt: at('2026-11-02T00:00:00Z'),
      },
    ]);
    const report = await service.report({ period: '2026-10' }, NOW);
    expect(report.quality.sessions).toEqual({
      started: 4,
      completed: 1,
      abandoned: 1,
      unfinished: 2,
    });
    expect(report.quality.completion.value).toBe(0.25);
    expect(report.quality.resolutionHours).toBe(24);
    expect(report.quality.flags).toMatchObject({
      total: 2,
      unresolved: 1,
      byType: { too_high: 1, transcript: 1 },
    });
    expect(report.quality.flagRate).toBe(200);
  });

  it('never invents historical inactivity and excludes removed, revoked, pending and expired attention cases', async () => {
    const { service, prisma } = setup();
    prisma.roleAssignment.findMany.mockResolvedValue([
      assignment(),
      assignment({ userId: 'removed', removedAt: at('2026-10-01T00:00:00Z') }),
      assignment({
        userId: 'revoked',
        user: { ...assignment().user, status: 'revoked' },
      }),
      assignment({
        userId: 'pending',
        user: { ...assignment().user, status: 'invite_pending' },
      }),
      assignment({
        userId: 'expired',
        user: {
          ...assignment().user,
          accessExpiresAt: at('2026-09-01T00:00:00Z'),
        },
      }),
    ]);
    prisma.session.findMany.mockResolvedValue(
      ['candidate-1', 'removed', 'revoked', 'pending', 'expired'].map(
        (userId) =>
          session(userId, '2026-10-10T00:00:00Z', {
            userId,
            score: 42,
            band: 'not_ready',
          }),
      ),
    );
    const report = await service.report({ period: '2026-10' }, NOW);
    expect(report.attention).toMatchObject({
      total: 1,
      low: 1,
      inactive: 0,
      both: 0,
      historicalInactivityAvailable: false,
    });
    expect(report.attention.cases[0]?.candidateId).toBe('candidate-1');
    const current = await service.report({ period: '2026-11' }, NOW);
    expect(current.attention).toMatchObject({
      total: 1,
      low: 0,
      inactive: 0,
      both: 1,
      historicalInactivityAvailable: true,
    });
  });

  it('uses distinct matured denominators for invitation, practice and same-role repeat windows', async () => {
    const { service, prisma } = setup();
    const now = at('2026-11-02T00:00:00Z');
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 'candidate-1',
        sentAt: at('2026-10-01T00:00:00Z'),
        firstLoginAt: at('2026-10-03T00:00:00Z'),
      },
      {
        id: 'fresh',
        sentAt: at('2026-10-31T00:00:00Z'),
        firstLoginAt: at('2026-11-01T00:00:00Z'),
      },
      {
        id: 'no-login',
        sentAt: at('2026-10-01T00:00:00Z'),
        firstLoginAt: null,
      },
    ]);
    prisma.session.findMany.mockResolvedValue([
      session('first', '2026-10-04T00:00:00Z'),
      session('second', '2026-10-10T00:00:00Z'),
      session('new-role', '2026-10-25T00:00:00Z', { jobRoleId: 'role-2' }),
    ]);
    const report = await service.report({ period: '2026-11' }, now);
    expect(report.funnel).toEqual({
      invited: 3,
      activation: { num: 1, den: 2, value: 0.5 },
      firstPractice: { num: 1, den: 1, value: 1 },
      repeatPractice: { num: 1, den: 1, value: 1 },
    });
  });

  it('derives first-attempt dimensions and hardest questions without fabricating skipped retries', async () => {
    const { service, prisma } = setup();
    prisma.attempt.findMany.mockResolvedValue([
      {
        questionId: 'q1',
        attemptNo: 1,
        score: 40,
        dimensionScores: { content: 40, structure: 20 },
        question: { text: 'Hard question' },
      },
      {
        questionId: 'q1',
        attemptNo: 2,
        score: 70,
        dimensionScores: { content: 90 },
        question: { text: 'Hard question' },
      },
      {
        questionId: 'q2',
        attemptNo: 1,
        score: 60,
        dimensionScores: { content: 80 },
        question: { text: 'Skipped retry' },
      },
    ]);
    const report = await service.report({ period: '2026-10' }, NOW);
    expect(report.dimensions.find((d) => d.id === 'content')?.value).toBe(60);
    expect(
      report.dimensions.find((d) => d.id === 'delivery')?.value,
    ).toBeNull();
    expect(report.hardestQuestions).toEqual([
      {
        id: 'q1',
        question: 'Hard question',
        responses: 1,
        first: 40,
        retry: 70,
      },
      {
        id: 'q2',
        question: 'Skipped retry',
        responses: 1,
        first: 60,
        retry: null,
      },
    ]);
    expect(prisma.session.findMany.mock.calls[0]?.[0].where).toMatchObject({
      isPreview: false,
      user: { role: 'candidate', deletedAt: null },
    });
    expect(
      prisma.attempt.findMany.mock.calls[0]?.[0].where.session,
    ).toMatchObject({
      isPreview: false,
      user: { role: 'candidate', deletedAt: null },
      completedAt: { lt: at('2026-11-01T00:00:00Z') },
    });
  });

  it('keeps historical low-score attention when assignment removal happened after cutoff', async () => {
    const { service, prisma } = setup();
    prisma.session.findMany.mockResolvedValue([
      session('low', '2026-10-15T00:00:00Z', { score: 35, band: 'not_ready' }),
    ]);
    prisma.roleAssignment.findMany.mockResolvedValue([
      assignment({ removedAt: at('2026-11-02T00:00:00Z') }),
    ]);
    const report = await service.report({ period: '2026-10' }, NOW);
    expect(report.attention.total).toBe(1);
    expect(report.attention.cases[0]?.reason).toBe('low');
  });

  it('returns not found for an unavailable role rather than a made-up report', async () => {
    const { service, prisma } = setup();
    prisma.jobRole.findMany.mockResolvedValue([]);
    await expect(
      service.report({ period: '2026-10', roleId: 'missing' }, NOW),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
});
