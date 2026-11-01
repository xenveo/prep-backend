import type { SessionStatus, Band } from '../src/generated/prisma/client.js';
import { DEFAULT_ROLE_SETTINGS } from '../src/modules/interview/types.js';
import type { ExecutiveInsights } from '../src/modules/reports/executive.types.js';
import {
  cleanupUsers,
  createTestApp,
  loginAs,
  runId,
  type TestApp,
} from './helpers/e2e.js';

const RUN = runId('executive-insights');
const at = (date: string) => new Date(`${date}T12:00:00Z`);
const PERIOD = '2001-10';

describe('Executive supporting insights (database)', () => {
  let t: TestApp;
  let cookie: string;
  let adminId: string;
  let roleId: string;
  let questionId: string;
  let candidateId: string;

  async function candidate(label: string, erased = false) {
    const u = await t.prisma.user.create({
      data: {
        email: `${RUN}-${label}@example.test`,
        name: `${RUN} ${label}`,
        role: 'candidate',
        status: 'active',
        firstLoginAt: at('2001-09-03'),
        lastActiveAt: at('2001-09-03'),
        deletedAt: erased ? at('2001-10-01') : null,
      },
    });
    await t.prisma.roleAssignment.create({
      data: { userId: u.id, jobRoleId: roleId, assignedAt: at('2001-08-01') },
    });
    return u.id;
  }
  async function invite(userId: string, label: string, sent: string) {
    await t.prisma.invite.create({
      data: {
        userId,
        email: `${RUN}-${label}@example.test`,
        invitedBy: adminId,
        tokenHash: `${RUN}-${label}-${sent}`,
        sentAt: at(sent),
        expiresAt: at('2001-12-01'),
      },
    });
  }
  async function session(
    userId: string,
    number: number,
    started: string,
    completed: string | null,
    score: number | null,
    band: Band | null,
    status: SessionStatus = 'completed',
    preview = false,
    answer = true,
  ) {
    const s = await t.prisma.session.create({
      data: {
        userId,
        jobRoleId: roleId,
        number,
        mode: 'typed',
        status,
        isPreview: preview,
        startedAt: at(started),
        completedAt: completed ? at(completed) : null,
        score,
        band,
        weightsSnapshot: {
          sessionWeights: DEFAULT_ROLE_SETTINGS.sessionWeights,
          dimensionWeights: DEFAULT_ROLE_SETTINGS.dimensionWeights,
        },
        promptVersions: {},
      },
    });
    if (answer)
      await t.prisma.attempt.create({
        data: {
          sessionId: s.id,
          questionId,
          attemptNo: 1,
          mode: 'typed',
          status: 'done',
          score: 42,
          idempotencyKey: `${RUN}-${userId}-${number}`,
          submittedAt: at(started),
          dimensionScores: {
            content: 42,
            structure: 35,
            delivery: 60,
            relevance: 70,
          },
        },
      });
    return s.id;
  }
  beforeAll(async () => {
    t = await createTestApp();
    const admin = await loginAs(t.prisma, {
      email: `${RUN}-admin@example.test`,
      role: 'admin',
    });
    cookie = admin.cookie;
    adminId = admin.user.id;
    const role = await t.prisma.jobRole.create({
      data: {
        slug: RUN,
        title: RUN,
        seniority: 'mid',
        keySkills: [],
        status: 'approved',
        settings: DEFAULT_ROLE_SETTINGS,
        createdAt: at('2000-01-01'),
      },
    });
    roleId = role.id;
    questionId = (
      await t.prisma.question.create({
        data: {
          jobRoleId: roleId,
          text: `${RUN} real question`,
          category: 'behavioural',
          difficulty: 'medium',
          rubric: {},
          status: 'approved',
        },
      })
    ).id;
    candidateId = await candidate('main');
    await invite(candidateId, 'main', '2001-09-01');
    await invite(candidateId, 'resend', '2001-09-15');
    await session(candidateId, 1, '2001-09-04', '2001-09-04', 40, 'not_ready');
    // Stored band intentionally differs from the numeric threshold; history must use the stored band.
    const ready = await session(
      candidateId,
      2,
      '2001-10-04',
      '2001-10-04',
      80,
      'interview_ready',
    );
    await session(candidateId, 3, '2001-10-30', '2001-11-01', 10, 'not_ready');
    await session(
      candidateId,
      4,
      '2001-10-10',
      null,
      null,
      null,
      'in_progress',
    );
    await session(candidateId, 5, '2001-10-10', null, null, null, 'abandoned');
    // A candidate can have only one in-progress session per role. Use a separate
    // unassigned person to check that an unopened-answer session is not counted.
    const noAnswer = await t.prisma.user.create({
      data: {
        email: `${RUN}-no-answer@example.test`,
        role: 'candidate',
        status: 'active',
      },
    });
    await session(
      noAnswer.id,
      1,
      '2001-10-10',
      null,
      null,
      null,
      'in_progress',
      false,
      false,
    );
    const preview = await candidate('preview');
    const previewSession = await session(
      preview,
      1,
      '2001-10-05',
      '2001-10-05',
      100,
      'interview_ready',
      'completed',
      true,
    );
    const erased = await candidate('erased', true);
    const erasedSession = await session(
      erased,
      1,
      '2001-10-05',
      '2001-10-05',
      100,
      'interview_ready',
    );
    const old = await candidate('old-invite');
    await t.prisma.user.update({
      where: { id: old },
      data: { firstLoginAt: at('2001-08-02') },
    });
    await invite(old, 'old-first', '2001-08-01');
    await invite(old, 'old-resend', '2001-09-01');
    await session(old, 1, '2001-08-03', '2001-08-03', 50, 'developing');
    await session(old, 2, '2001-10-15', '2001-10-15', 90, 'interview_ready');
    for (const [sessionId, issue, resolvedAt] of [
      [ready, 'too_high', at('2001-10-06')],
      [ready, 'transcript_wrong', at('2001-11-02')],
      [previewSession, 'too_low', null],
      [erasedSession, 'too_low', null],
    ] as const)
      await t.prisma.evaluationFlag.create({
        data: {
          sessionId,
          questionNumber: 1,
          dimension: 'overall',
          issue,
          createdBy: adminId,
          createdAt: at('2001-10-05'),
          status: resolvedAt ? 'resolved' : 'open',
          resolvedAt,
        },
      });
  });
  afterAll(async () => {
    if (t?.prisma) {
      await cleanupUsers(t.prisma, RUN);
      if (roleId) await t.prisma.jobRole.deleteMany({ where: { id: roleId } });
    }
    await t?.close();
  });
  const report = async () =>
    (
      await t
        .http()
        .get('/api/admin/reports/executive/insights')
        .query({ period: PERIOD, roleId })
        .set('Cookie', cookie)
        .expect(200)
    ).body as ExecutiveInsights;

  it('uses real stored bands and excludes future, preview and erased assessments', async () => {
    const result = await report();
    expect(result.pipeline).toHaveLength(1);
    expect(result.pipeline[0]).toMatchObject({
      bands: { ready: 2, nearly: 0, developing: 0, not_ready: 0 },
      unassessed: 1,
      newlyReady: 2,
    });
    expect(result.timeToReady).toMatchObject({
      medianDays: 51.5,
      attainment: { num: 0, den: 1, value: 0 },
    });
    expect(result.meta.cutoff).toBe('2001-11-01T00:00:00.000Z');
    expect(result.attention.historicalInactivityAvailable).toBe(false);
  });
  it('deduplicates first invitation before selecting the cohort and keeps funnel observation units separate', async () => {
    const result = await report();
    expect(result.funnel).toEqual({
      invited: 1,
      activation: { num: 1, den: 1, value: 1 },
      firstPractice: { num: 1, den: 1, value: 1 },
      repeatPractice: { num: 0, den: 1, value: 0 },
    });
  });
  it('does not relabel unfinished sessions as abandoned or resolve flags after historical cutoff', async () => {
    const result = await report();
    expect(result.quality.sessions).toEqual({
      started: 5,
      completed: 2,
      abandoned: 1,
      unfinished: 2,
    });
    expect(result.quality.completion).toEqual({ num: 2, den: 5, value: 0.4 });
    expect(result.quality.flags).toMatchObject({
      total: 2,
      unresolved: 1,
      byType: { too_high: 1, too_low: 0, transcript: 1 },
    });
    expect(result.quality.resolutionHours).toBe(24);
    expect(result.quality.flagRate).toBe(100);
    expect(result.hardestQuestions[0]).toMatchObject({
      id: questionId,
      responses: 2,
      first: 42,
      retry: null,
    });
  });
  it('uses the existing authorization and query validation boundary', async () => {
    await t
      .http()
      .get('/api/admin/reports/executive/insights')
      .query({ period: PERIOD, roleId })
      .expect(401);
    await t
      .http()
      .get('/api/admin/reports/executive/insights')
      .query({ period: '2001-99', roleId })
      .set('Cookie', cookie)
      .expect(400);
    const candidateLogin = await loginAs(t.prisma, {
      email: `${RUN}-candidate-login@example.test`,
    });
    await t
      .http()
      .get('/api/admin/reports/executive/insights')
      .query({ period: PERIOD, roleId })
      .set('Cookie', candidateLogin.cookie)
      .expect(404);
  });
});
