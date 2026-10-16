// Admin read models (FR-REP-01..05): candidate list/detail/CSV, session review, flags, reports.
// Seeds its own role and candidates under a RUN prefix; preview sessions and erased users must
// never show up.
import { DEFAULT_ROLE_SETTINGS } from '../src/modules/interview/types.js';
import type { Band } from '../src/generated/prisma/client.js';
import {
  cleanupUsers,
  createTestApp,
  loginAs,
  runId,
  type TestApp,
} from './helpers/e2e.js';

const RUN = runId('reports');
const DAY = 864e5;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const emailFor = (label: string) => `${RUN}-${label}@example.test`;

type Skills = [number, number, number, number];
type QSpec = {
  q: 0 | 1;
  first: number;
  /** null = retry skipped */
  second: number | null;
  learning?: number;
  audio?: 'live' | 'expired';
};

describe('Reports and admin read models (e2e)', () => {
  let t: TestApp;
  let adminCookie: string;
  let adminId: string;
  let candidateCookie: string;
  let candidateLoginId: string;
  let roleId: string;
  let draftRoleId: string;
  const questionIds: string[] = [];
  const ids: Record<string, string> = {};
  const sessions: Record<string, string> = {};

  const bandOf = (score: number): Band =>
    score >= 85
      ? 'interview_ready'
      : score >= 70
        ? 'nearly_ready'
        : score >= 50
          ? 'developing'
          : 'not_ready';

  async function candidate(
    label: string,
    data: {
      name: string;
      status?: 'active' | 'invite_pending';
      lastActiveDaysAgo?: number;
      invitedDaysAgo: number;
      deleted?: boolean;
    },
  ) {
    const user = await t.prisma.user.create({
      data: {
        email: emailFor(label),
        name: data.name,
        role: 'candidate',
        status: data.status ?? 'active',
        firstLoginAt: data.status === 'invite_pending' ? null : ago(60),
        lastActiveAt:
          data.lastActiveDaysAgo === undefined
            ? null
            : ago(data.lastActiveDaysAgo),
        deletedAt: data.deleted ? ago(1) : null,
      },
    });
    await t.prisma.invite.create({
      data: {
        email: user.email,
        userId: user.id,
        invitedBy: adminId,
        tokenHash: `${RUN}-${label}`,
        sentAt: ago(data.invitedDaysAgo),
        expiresAt: ago(data.invitedDaysAgo - 7),
      },
    });
    await t.prisma.roleAssignment.create({
      data: { userId: user.id, jobRoleId: roleId, assignedAt: ago(90) },
    });
    ids[label] = user.id;
    return user.id;
  }

  async function session(
    key: string,
    userId: string,
    s: {
      number: number;
      score: number;
      completedDaysAgo: number;
      skills: Skills;
      questions: QSpec[];
      preview?: boolean;
    },
  ) {
    const [content, structure, delivery, relevance] = s.skills;
    const row = await t.prisma.session.create({
      data: {
        userId,
        jobRoleId: roleId,
        number: s.number,
        status: 'completed',
        mode: 'voice',
        isPreview: s.preview ?? false,
        startedAt: ago(s.completedDaysAgo),
        completedAt: ago(s.completedDaysAgo),
        durationS: 1440,
        firstTryAvg: 55,
        retryAvg: 62.5,
        learningAvg: 50,
        score: s.score,
        band: bandOf(s.score),
        skills: { content, structure, delivery, relevance },
        weightsSnapshot: {
          sessionWeights: DEFAULT_ROLE_SETTINGS.sessionWeights,
          dimensionWeights: DEFAULT_ROLE_SETTINGS.dimensionWeights,
        },
        promptVersions: {},
      },
    });
    sessions[key] = row.id;
    for (const [i, qs] of s.questions.entries()) {
      const questionId = questionIds[qs.q];
      await t.prisma.sessionQuestion.create({
        data: {
          sessionId: row.id,
          questionId,
          position: i + 1,
          retrySkipped: qs.second === null,
        },
      });
      const tries: [1 | 2, number][] = [[1, qs.first]];
      if (qs.second !== null) tries.push([2, qs.second]);
      for (const [attemptNo, score] of tries) {
        await t.prisma.attempt.create({
          data: {
            sessionId: row.id,
            questionId,
            attemptNo,
            mode: 'voice',
            status: 'done',
            idempotencyKey: `${key}-${i}-${attemptNo}`,
            transcript: `Answer ${attemptNo}`,
            durationS: 98,
            wpm: 140,
            fillerCount: 2,
            pauseCount: 4,
            longestPauseS: 1.6,
            dimensionScores: {
              content: score,
              structure: score,
              delivery: score,
              relevance: score,
            },
            score,
            learningScore: attemptNo === 2 ? (qs.learning ?? 0) : null,
            audioKey: qs.audio
              ? `audio/${row.id}/${i}-${attemptNo}.webm`
              : null,
            audioExpiresAt:
              qs.audio === undefined
                ? null
                : attemptNo === 1 && qs.audio === 'live'
                  ? new Date(Date.now() + 10 * DAY)
                  : ago(1),
            feedback: {
              worked: ['Clear.', 'Specific.'],
              improve: ['Add a result.'],
              opener: '',
              focus: [],
              improvementPoints: [],
              deliveryNotes: '',
              spokenSummary: '',
              followUp: null,
              applied:
                attemptNo === 2
                  ? [
                      {
                        point: 'Add a result',
                        status: 'partly',
                        evidence: 'Mentioned it',
                      },
                    ]
                  : [],
              highlights: [
                { quote: 'Answer', kind: 'match', note: 'On topic' },
              ],
              delivery: [],
              audioSeconds: 20,
            },
          },
        });
      }
    }
    return row.id;
  }

  beforeAll(async () => {
    t = await createTestApp();
    const admin = await loginAs(t.prisma, {
      email: emailFor('admin'),
      role: 'admin',
      name: 'Arjun Admin',
    });
    adminCookie = admin.cookie;
    adminId = admin.user.id;
    // Not under the RUN prefix, so it stays out of the `search=RUN` lists.
    const loggedIn = await loginAs(t.prisma, {
      email: `rpt-login-${Date.now().toString(36)}@example.test`,
    });
    candidateCookie = loggedIn.cookie;
    candidateLoginId = loggedIn.user.id;

    const role = await t.prisma.jobRole.create({
      data: {
        slug: `${RUN}-csa`,
        title: `${RUN} Support Associate`,
        seniority: 'entry',
        keySkills: [],
        status: 'approved',
        settings: DEFAULT_ROLE_SETTINGS,
      },
    });
    roleId = role.id;
    draftRoleId = (
      await t.prisma.jobRole.create({
        data: {
          slug: `${RUN}-draft`,
          title: `${RUN} Draft`,
          seniority: 'entry',
          keySkills: [],
          status: 'draft',
          settings: DEFAULT_ROLE_SETTINGS,
        },
      })
    ).id;
    for (const text of ['Handle an upset customer', 'Explain a refund']) {
      const q = await t.prisma.question.create({
        data: {
          jobRoleId: roleId,
          text: `${RUN} ${text}`,
          category: 'behavioural',
          difficulty: 'medium',
          rubric: { keyPoints: [], redFlags: [], expectedStructure: 'star' },
        },
      });
      questionIds.push(q.id);
    }

    const alpha = await candidate('alpha', {
      name: 'Alpha Rao',
      lastActiveDaysAgo: 1,
      invitedDaysAgo: 40,
    });
    const bravo = await candidate('bravo', {
      name: 'Bravo Iyer',
      lastActiveDaysAgo: 20,
      invitedDaysAgo: 10,
    });
    await candidate('charlie', {
      name: 'Charlie Nair',
      status: 'invite_pending',
      invitedDaysAgo: 2,
    });
    const erased = await candidate('erased', {
      name: 'Erased Person',
      lastActiveDaysAgo: 1,
      invitedDaysAgo: 5,
      deleted: true,
    });
    const delta = await candidate('delta', {
      name: 'Delta Shah',
      lastActiveDaysAgo: 2,
      invitedDaysAgo: 60,
    });

    await session('a1', alpha, {
      number: 1,
      score: 45,
      completedDaysAgo: 20,
      skills: [40, 30, 50, 60],
      questions: [
        { q: 0, first: 40, second: 50, learning: 50 },
        { q: 1, first: 20, second: 30, learning: 100 },
      ],
    });
    await session('a2', alpha, {
      number: 2,
      score: 72,
      completedDaysAgo: 5,
      skills: [70, 60, 80, 80],
      questions: [
        { q: 0, first: 70, second: null },
        { q: 1, first: 60, second: 75, learning: 50, audio: 'live' },
      ],
    });
    await session('preview', alpha, {
      number: 99,
      score: 5,
      completedDaysAgo: 1,
      skills: [0, 0, 0, 0],
      questions: [{ q: 0, first: 5, second: 5 }],
      preview: true,
    });
    await session('b1', bravo, {
      number: 1,
      score: 60,
      completedDaysAgo: 25,
      skills: [60, 50, 70, 60],
      questions: [{ q: 0, first: 60, second: 64, learning: 100 }],
    });
    await session('d1', delta, {
      number: 1,
      score: 30,
      completedDaysAgo: 50,
      skills: [0, 0, 0, 0],
      questions: [{ q: 0, first: 0, second: 0 }],
    });
    await session('d2', delta, {
      number: 2,
      score: 30,
      completedDaysAgo: 2,
      skills: [30, 20, 40, 30],
      questions: [{ q: 0, first: 30, second: 34, learning: 0 }],
    });
    await session('e1', erased, {
      number: 1,
      score: 99,
      completedDaysAgo: 3,
      skills: [99, 99, 99, 99],
      questions: [{ q: 0, first: 99, second: 99 }],
    });
  });

  afterAll(async () => {
    if (t) {
      await cleanupUsers(t.prisma, RUN);
      await t.prisma.unfiltered.user.deleteMany({
        where: { id: candidateLoginId },
      });
      await t.prisma.jobRole.deleteMany({
        where: { slug: { startsWith: RUN } },
      });
      await t.prisma.auditLog.deleteMany({ where: { actorId: adminId } });
      await t.close();
    }
  });

  const get = (url: string, cookie = adminCookie) =>
    t.http().get(url).set('Cookie', cookie);

  describe('GET /api/admin/candidates', () => {
    const list = (query: string) =>
      get(`/api/admin/candidates?search=${RUN}${query}`);
    const names = (body: { rows: { name: string }[] }) =>
      body.rows.map((r) => r.name);

    it('lists candidates with derived columns; previews and erased users are excluded', async () => {
      const res = await list('&sort=score&dir=desc');
      expect(res.status).toBe(200);
      expect(names(res.body)).toEqual([
        'Alpha Rao',
        'Bravo Iyer',
        'Delta Shah',
        'Charlie Nair',
      ]);
      expect(res.body.total).toBe(4);
      expect(res.body.totalUnfiltered).toBeGreaterThanOrEqual(4);
      const [alpha, bravo, delta, charlie] = res.body.rows;
      expect(alpha).toMatchObject({
        email: emailFor('alpha'),
        status: 'active',
        roles: [{ id: roleId, status: 'approved' }],
        sessions: 2,
        latestScore: 72,
        band: 'nearly',
        change: 27,
        lastActiveLabel: 'Yesterday',
      });
      expect(alpha.lastActiveNote).toBeUndefined();
      expect(bravo).toMatchObject({
        sessions: 1,
        latestScore: 60,
        change: null,
      });
      expect(delta).toMatchObject({
        sessions: 2,
        band: 'not_ready',
        change: 0,
      });
      expect(charlie).toMatchObject({
        status: 'invite_pending',
        sessions: 0,
        latestScore: null,
        band: null,
        lastActiveAt: null,
        lastActiveLabel: 'Not yet',
        lastActiveNote: 'Invite sent 2 days ago',
      });
    });

    it('defaults to last active, newest first, with never-active last', async () => {
      const res = await list('');
      expect(names(res.body)).toEqual([
        'Alpha Rao',
        'Delta Shah',
        'Bravo Iyer',
        'Charlie Nair',
      ]);
    });

    it('applies filters', async () => {
      expect(names((await list('&bands=not_ready')).body)).toEqual([
        'Delta Shah',
      ]);
      expect(
        names(
          (await list('&bands[]=nearly&bands[]=developing&sort=name')).body,
        ),
      ).toEqual(['Alpha Rao', 'Bravo Iyer']);
      expect(names((await list('&noChangeInSessions=2')).body)).toEqual([
        'Delta Shah',
      ]);
      expect(
        names((await list('&lastActiveWithinDays=3&sort=name&dir=asc')).body),
      ).toEqual(['Alpha Rao', 'Delta Shah']);
      expect(names((await list('&statuses=invite_pending')).body)).toEqual([
        'Charlie Nair',
      ]);
      expect((await list(`&roleIds=${roleId}`)).body.total).toBe(4);
      expect((await list(`&roleIds=${draftRoleId}`)).body.total).toBe(0);
      const ci = await get(
        `/api/admin/candidates?search=${encodeURIComponent('ALPHA RAO')}`,
      );
      expect(names(ci.body)).toContain('Alpha Rao');
    });

    it('rejects bad query params and non-admins', async () => {
      expect((await list('&sort=email')).status).toBe(400);
      expect((await get('/api/admin/candidates', candidateCookie)).status).toBe(
        404,
      );
    });
  });

  describe('GET /api/admin/candidates/export.csv', () => {
    it('exports the chosen candidates with the UI columns', async () => {
      const res = await get(
        `/api/admin/candidates/export.csv?ids=${ids.delta}&ids=${ids.alpha}&ids=${ids.erased}`,
      );
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="candidates.csv"',
      );
      const lines = res.text.split('\r\n');
      expect(lines[0]).toBe(
        'Name,Email,Status,Roles,Sessions,Latest score,Band,Change since baseline,Last active',
      );
      expect(lines).toHaveLength(4);
      expect(lines[1]).toMatch(
        new RegExp(
          `^Alpha Rao,${emailFor('alpha')},active,${RUN} Support Associate,2,72,Nearly ready,27,\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$`,
        ),
      );
      expect(lines[2]).toMatch(
        /^Delta Shah,.*,active,.*,2,30,Not ready yet,0,/,
      );
      expect(lines[3]).toBe('');
    });
  });

  describe('GET /api/admin/candidates/:id', () => {
    it('returns assignments, sessions, progress and invite details', async () => {
      const res = await get(`/api/admin/candidates/${ids.alpha}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: ids.alpha,
        name: 'Alpha Rao',
        status: 'active',
        invitedBy: adminId,
        invitedByName: 'Arjun Admin',
        accessUntil: null,
        assignments: [
          {
            roleId,
            roleStatus: 'approved',
            maxSessions: 5,
            sessionsUsed: 2,
            baselineScore: 45,
            latestScore: 72,
            latestBand: 'nearly',
            changeSinceBaseline: 27,
          },
        ],
      });
      expect(res.body.sessions.map((s: { id: string }) => s.id)).toEqual([
        sessions.a2,
        sessions.a1,
      ]);
      expect(res.body.sessions[0]).toMatchObject({
        number: 2,
        score: 72,
        band: 'nearly',
        durationMin: 24,
      });
      expect(res.body).not.toHaveProperty('changeSinceFirst');
      const roleTitle = `${RUN} Support Associate`;
      expect(res.body.progress).toEqual([
        expect.objectContaining({
          roleId,
          roleTitle,
          label: 'Session 1',
          score: 45,
        }),
        expect.objectContaining({
          roleId,
          roleTitle,
          label: 'Session 2',
          score: 72,
        }),
      ]);
      expect(Array.isArray(res.body.activity)).toBe(true);
    });

    it('404s for erased users, admins and malformed ids', async () => {
      expect((await get(`/api/admin/candidates/${ids.erased}`)).status).toBe(
        404,
      );
      expect((await get(`/api/admin/candidates/${adminId}`)).status).toBe(404);
      const bad = await get('/api/admin/candidates/nope');
      expect(bad.status).toBe(404);
      expect(bad.body.error.code).toBe('not_found');
    });
  });

  describe('GET /api/admin/candidates/:cid/sessions/:sid', () => {
    it('returns every question with tries, signed audio and the formula', async () => {
      const res = await get(
        `/api/admin/candidates/${ids.alpha}/sessions/${sessions.a2}`,
      );
      expect(res.status).toBe(200);
      const body = res.body;
      expect(body).toMatchObject({
        sessionId: sessions.a2,
        candidateName: 'Alpha Rao',
        sessionNumber: 2,
        score: 72,
        band: 'nearly',
        changeVsPrevious: 27,
        firstTryAvg: 55,
        secondTryAvg: 62.5,
        learningScore: 50,
        hasDetail: true,
        weights: { firstTry: 20, secondTry: 55, learning: 25 },
        formulaText: '20% first try + 55% second try + 25% learning = 72',
      });
      const [q1, q2] = body.questions;
      expect(q1).toMatchObject({
        n: 1,
        firstScore: 70,
        secondScore: null,
        retrySkipped: true,
      });
      expect(q1.tries).toHaveLength(1);
      expect(q2).toMatchObject({ n: 2, firstScore: 60, secondScore: 75 });
      const [first, second] = q2.tries;
      expect(first).toMatchObject({
        attempt: 1,
        mode: 'voice',
        band: 'developing',
        audioSeconds: 98,
        audioLabel: '1:38',
        highlights: [{ text: 'Answer', kind: 'match', note: 'On topic' }],
        worked: 'Clear. Specific.',
        delivery: {
          wpm: 140,
          paceLabel: 'steady',
          fillerWords: 2,
          longestPauseSec: 1.6,
        },
      });
      expect(first.audioUrl).toMatch(/\/api\/storage\/local\/audio\//);
      expect(second.audioUrl).toBeNull();
      expect(second.appliedFromFeedback).toEqual([
        { text: 'Add a result', state: 'partial', detail: 'Mentioned it' },
      ]);
    });

    it('404s for previews, other candidates and erased users', async () => {
      expect(
        (
          await get(
            `/api/admin/candidates/${ids.alpha}/sessions/${sessions.preview}`,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await get(
            `/api/admin/candidates/${ids.bravo}/sessions/${sessions.a2}`,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await get(
            `/api/admin/candidates/${ids.erased}/sessions/${sessions.e1}`,
          )
        ).status,
      ).toBe(404);
    });
  });

  describe('flags', () => {
    let flagId: string;

    it('submits a flag, stores the question id and audits it; scores are unchanged', async () => {
      const res = await t
        .http()
        .post(`/api/admin/sessions/${sessions.a2}/flags`)
        .set('Cookie', adminCookie)
        .send({
          sessionId: sessions.a2,
          questionNumber: 2,
          dimension: 'delivery',
          issue: 'too_low',
          note: '  Pace was fine ',
        });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        sessionId: sessions.a2,
        title: 'Session 2 · Q2 · Delivery',
        questionNumber: 2,
        dimension: 'delivery',
        issue: 'too_low',
        note: 'Pace was fine',
        createdBy: adminId,
        createdByName: 'Arjun Admin',
        status: 'open',
      });
      flagId = res.body.id;
      const stored = await t.prisma.evaluationFlag.findUniqueOrThrow({
        where: { id: flagId },
      });
      expect(stored.questionId).toBe(questionIds[1]);
      const audit = await t.prisma.auditLog.findFirst({
        where: { actorId: adminId, action: 'Flagged an evaluation' },
      });
      expect(audit).toMatchObject({
        entity: 'session',
        entityId: sessions.a2,
        itemLabel: 'Alpha Rao · session 2 · question 2',
      });
      const session = await t.prisma.session.findUniqueOrThrow({
        where: { id: sessions.a2 },
      });
      expect(session.score).toBe(72);
    });

    it('lists flags newest first', async () => {
      const res = await get(`/api/admin/sessions/${sessions.a2}/flags`);
      expect(res.status).toBe(200);
      expect(res.body.map((f: { id: string }) => f.id)).toEqual([flagId]);
    });

    it('resolves a flag once and audits it', async () => {
      const patch = () =>
        t
          .http()
          .patch(`/api/admin/flags/${flagId}`)
          .set('Cookie', adminCookie)
          .send({ status: 'resolved', resolution: 'Rubric updated' });
      const res = await patch();
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'resolved',
        resolution: 'Rubric updated',
      });
      const stored = await t.prisma.evaluationFlag.findUniqueOrThrow({
        where: { id: flagId },
      });
      expect(stored.resolvedBy).toBe(adminId);
      expect(stored.resolvedAt).not.toBeNull();
      expect(
        await t.prisma.auditLog.count({
          where: { actorId: adminId, action: 'Resolved an evaluation flag' },
        }),
      ).toBe(1);
      expect((await patch()).status).toBe(409);
    });

    it('validates input and hides previews', async () => {
      const post = (sid: string, body: object) =>
        t
          .http()
          .post(`/api/admin/sessions/${sid}/flags`)
          .set('Cookie', adminCookie)
          .send(body);
      const ok = { questionNumber: 1, dimension: 'overall', issue: 'too_high' };
      expect(
        (await post(sessions.a2, { ...ok, questionNumber: 9 })).status,
      ).toBe(400);
      expect(
        (await post(sessions.a2, { ...ok, dimension: 'tone' })).status,
      ).toBe(400);
      expect(
        (await post(sessions.a2, { ...ok, sessionId: sessions.a1 })).status,
      ).toBe(400);
      expect((await post(sessions.preview, ok)).status).toBe(404);
      expect(
        (await get(`/api/admin/sessions/${sessions.e1}/flags`)).status,
      ).toBe(404);
    });
  });

  describe('GET /api/admin/reports', () => {
    it('computes the default (completion date, last 30 days) report', async () => {
      const res = await get(`/api/admin/reports?roleId=${roleId}`);
      expect(res.status).toBe(200);
      const r = res.body;
      expect(r.range.label).toMatch(/^Last 30 days · /);
      expect(r).toMatchObject({
        roleId,
        hasData: true,
        stats: {
          invited: 4,
          active: 3,
          completedSession: 3,
          avgBaseline: 45,
          avgLatest: 54,
          change: 9,
        },
        bandsBaseline: { ready: 0, nearly: 0, developing: 1, not_ready: 2 },
        bandsLatest: { ready: 0, nearly: 1, developing: 1, not_ready: 1 },
        dimensionAverages: {
          content: 50,
          structure: 40,
          delivery: 60,
          relevance: 58,
        },
        weakest: { id: 'structure', label: 'Structure', value: 40 },
        weakestNote:
          'Structure is the weakest area. Consider a flash card on STAR.',
        illustrative: [],
      });
      expect(r.hardestQuestions).toEqual([
        {
          questionId: questionIds[0],
          question: `${RUN} Handle an upset customer`,
          timesAsked: 4,
          avgFirst: 50,
          avgSecond: 55,
          avgLearning: 38,
        },
      ]);
      expect(r.needsAttention).toEqual([
        expect.objectContaining({
          candidateId: ids.delta,
          why: 'Not ready yet, no change over 2 sessions',
          sessions: 2,
          latestScore: 30,
          lastActiveLabel: '2 days ago',
        }),
        expect.objectContaining({
          candidateId: ids.bravo,
          why: 'No activity for 20 days',
          latestScore: 60,
        }),
      ]);
    });

    it('filters a cohort by invite date', async () => {
      const from = new Date(Date.now() - 15 * DAY).toISOString().slice(0, 10);
      const res = await get(
        `/api/admin/reports?roleId=${roleId}&dateBasis=invited&from=${from}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.stats).toEqual({
        invited: 2,
        active: 1,
        completedSession: 1,
        avgBaseline: 60,
        avgLatest: 60,
        change: null,
      });
      expect(res.body.range.label).toMatch(/^Custom range · /);
      expect(res.body.hardestQuestions).toEqual([]);
    });

    it('a range with no sessions has no data; a draft role has no data', async () => {
      const empty = await get(
        `/api/admin/reports?roleId=${roleId}&from=2020-01-01&to=2020-01-31`,
      );
      expect(empty.body).toMatchObject({
        hasData: false,
        stats: { completedSession: 0, avgBaseline: null, change: null },
        dimensionAverages: null,
        weakest: null,
      });
      const draft = await get(`/api/admin/reports?roleId=${draftRoleId}`);
      expect(draft.status).toBe(200);
      expect(draft.body).toMatchObject({ hasData: false, needsAttention: [] });
    });

    it('validates the query', async () => {
      expect((await get('/api/admin/reports')).status).toBe(400);
      expect(
        (
          await get(
            `/api/admin/reports?roleId=${roleId}&from=2026-02-02&to=2026-02-01`,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await get(
            '/api/admin/reports?roleId=00000000-0000-4000-8000-000000000000',
          )
        ).status,
      ).toBe(404);
    });

    it('exports the report CSV with the date basis in the Range row', async () => {
      const res = await get(
        `/api/admin/reports/export.csv?roleId=${roleId}&dateBasis=completed`,
      );
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toMatch(
        /^attachment; filename="report-e2e-reports-[a-z0-9]+-support-associate-\d{4}-\d{2}-\d{2}\.csv"$/,
      );
      const lines = res.text.split('\r\n');
      expect(lines[0]).toBe(`Report,${RUN} Support Associate`);
      expect(lines[1]).toMatch(
        /^Range,Last 30 days · .* · by session completion date$/,
      );
      expect(lines.slice(3, 10)).toEqual([
        'Metric,Value',
        'Invited,4',
        'Active,3',
        'Completed a session,3',
        'Average baseline,45',
        'Average latest,54',
        'Change,9',
      ]);
      expect(lines).toContain('Not ready yet,2,1,-1');
      expect(lines).toContain('Structure,40');
      expect(lines).toContain(`${RUN} Handle an upset customer,4,50,55,38`);

      const invited = await get(
        `/api/admin/reports/export.csv?roleId=${roleId}&dateBasis=invited`,
      );
      expect(invited.text.split('\r\n')[1]).toMatch(/ · by invite date$/);
    });
  });
});
