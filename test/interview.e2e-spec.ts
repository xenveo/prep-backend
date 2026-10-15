import { bandFor } from '../src/modules/interview/scoring/score.js';
import { DEFAULT_ROLE_SETTINGS } from '../src/modules/interview/types.js';
import {
  cleanupUsers,
  createTestApp,
  loginAs,
  runId,
  type TestApp,
} from './helpers/e2e.js';

// Candidate interview API (spec "Candidate API", plan M5): fake STT/LLM/TTS, in-process queue.
const RUN = runId('interview');
const ANSWER =
  'When a customer was upset about a late order, I listened, apologised, checked the tracking, ' +
  'found it stuck at a depot and arranged next-day delivery at no cost. The parcel arrived the ' +
  'next morning and the customer thanked us. I learned to own the problem and follow up.';

describe('Interview API (e2e)', () => {
  let t: TestApp;
  let roleId: string;
  let otherRoleId: string;
  let cookie: string;
  let userId: string;
  let otherCookie: string;
  let sessionId: string;
  let questionIds: string[] = [];
  const slug = RUN;
  const otherSlug = `${RUN}-other`;

  beforeAll(async () => {
    t = await createTestApp();
    const settings = {
      ...DEFAULT_ROLE_SETTINGS,
      questionsPerSession: 2,
      maxSessionsPerCandidate: 3,
    };
    const role = await t.prisma.jobRole.create({
      data: {
        slug,
        title: 'Interview Test Role',
        blurb: 'Practice role',
        seniority: 'entry',
        keySkills: [],
        status: 'approved',
        settings,
      },
    });
    roleId = role.id;
    const other = await t.prisma.jobRole.create({
      data: {
        slug: otherSlug,
        title: 'Unassigned Role',
        seniority: 'entry',
        keySkills: [],
        status: 'approved',
        settings,
      },
    });
    otherRoleId = other.id;
    const cards = await Promise.all(
      [1, 2, 3].map((position) =>
        t.prisma.flashCard.create({
          data: {
            jobRoleId: roleId,
            position,
            category: 'behavioural',
            question: `Card ${position}`,
            strongAnswerPoints: ['a', 'b', 'c'],
            commonMistakes: ['x', 'y'],
            tip: 'Be specific',
          },
        }),
      ),
    );
    for (const [i, card] of cards.slice(0, 2).entries()) {
      const q = await t.prisma.question.create({
        data: {
          jobRoleId: roleId,
          flashCardId: card.id,
          text: `Tell me about a time you helped an upset customer (${i + 1}).`,
          category: 'behavioural',
          difficulty: 'easy',
          rubric: {
            keyPoints: [
              { id: 'kp1', point: 'Empathy', example: 'I listened' },
              { id: 'kp2', point: 'Result', example: 'It arrived' },
            ],
            redFlags: [],
            expectedStructure: 'star',
          },
          createdAt: new Date(Date.now() + i * 1000),
        },
      });
      questionIds.push(q.id);
    }

    const login = await loginAs(t.prisma, {
      email: `${RUN}-cand@example.test`,
    });
    cookie = login.cookie;
    userId = login.user.id;
    await t.prisma.roleAssignment.create({
      data: { userId, jobRoleId: roleId },
    });
    otherCookie = (
      await loginAs(t.prisma, { email: `${RUN}-other@example.test` })
    ).cookie;
  });

  afterAll(async () => {
    if (!t) return;
    await t.prisma.unfiltered.aiCallLog.deleteMany({
      where: { session: { jobRoleId: { in: [roleId, otherRoleId] } } },
    });
    await cleanupUsers(t.prisma, RUN);
    await t.prisma.unfiltered.jobRole.deleteMany({
      where: { slug: { startsWith: RUN } },
    });
    await t.close();
  });

  const get = (path: string, c = cookie) =>
    t.http().get(`/api${path}`).set('Cookie', c);
  const post = (path: string, c = cookie) =>
    t.http().post(`/api${path}`).set('Cookie', c);
  const startBody = {
    mode: 'typed',
    consent: {
      recording: true,
      text: 'Your answers are recorded.',
      version: 'v1',
    },
  };

  function submitTyped(questionId: string, attemptNo: 1 | 2, key: string) {
    return post(`/sessions/${sessionId}/questions/${questionId}/attempts`)
      .set('Idempotency-Key', key)
      .field('attemptNo', String(attemptNo))
      .field('mode', 'typed')
      .field('text', ANSWER)
      .field('durationSec', '45');
  }

  async function pollDone(attemptId: string) {
    const end = Date.now() + 10_000;
    for (;;) {
      const res = await get(`/attempts/${attemptId}`).expect(200);
      if (res.body.status === 'done' || res.body.status === 'failed')
        return res.body;
      if (Date.now() > end)
        throw new Error(`attempt stuck: ${res.body.status}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('lists the assigned role as not started and hides unassigned roles', async () => {
    const res = await get('/roles').expect(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: slug,
        name: 'Interview Test Role',
        cardCount: 3,
        questionCount: 2,
        status: { kind: 'not-started' },
        latest: null,
        bestBand: null,
        latestBand: null,
        attemptsLeft: 3,
      }),
    ]);
    await get(`/roles/${otherSlug}`).expect(404);
    await post(`/roles/${otherSlug}/sessions`).send(startBody).expect(404);
  });

  it('returns the role shell settings', async () => {
    const res = await get(`/roles/${slug}`).expect(200);
    expect(res.body).toMatchObject({
      id: slug,
      cardsRequired: true,
      questionsPerSession: 2,
      answerSoftLimitSec: 120,
      retriesPerQuestion: 1,
    });
  });

  it('403 cards_not_viewed until every card is viewed', async () => {
    const res = await post(`/roles/${slug}/sessions`)
      .send(startBody)
      .expect(403);
    expect(res.body.error.code).toBe('cards_not_viewed');
    const cards = await t.prisma.flashCard.findMany({
      where: { jobRoleId: roleId },
    });
    await t.prisma.cardView.createMany({
      data: cards.map((c) => ({ userId, flashCardId: c.id })),
    });
    const roles = await get('/roles').expect(200);
    expect(roles.body[0].status).toEqual({ kind: 'studying', viewed: 3 });
  });

  it('starts a session and returns 409 with it on a second start', async () => {
    await post(`/roles/${slug}/sessions`)
      .send({
        ...startBody,
        consent: { ...startBody.consent, recording: false },
      })
      .expect(400);
    const res = await post(`/roles/${slug}/sessions`)
      .send(startBody)
      .expect(201);
    expect(res.body).toMatchObject({
      number: 1,
      currentQuestion: 1,
      intro: { text: expect.stringContaining('Interview Test Role') },
    });
    expect(res.body.questions.map((q: { id: string }) => q.id)).toEqual(
      questionIds,
    );
    expect(res.body.questions[0]).toMatchObject({
      index: 1,
      cardId: 1,
      category: 'Behavioural',
    });
    sessionId = res.body.id;
    const consent = await t.prisma.consent.findFirst({ where: { sessionId } });
    expect(consent).toMatchObject({ kind: 'recording', textVersion: 'v1' });

    const again = await post(`/roles/${slug}/sessions`)
      .send(startBody)
      .expect(409);
    expect(again.body.error.code).toBe('session_in_progress');
    expect(again.body.session.id).toBe(sessionId);

    const roles = await get('/roles').expect(200);
    expect(roles.body[0].status).toEqual({ kind: 'interviewing', question: 1 });
  });

  it('hides the session from other users', async () => {
    await get(`/sessions/${sessionId}`, otherCookie).expect(404);
    await submitTyped(questionIds[0], 1, 'x')
      .set('Cookie', otherCookie)
      .expect(404);
  });

  it('requires an Idempotency-Key', async () => {
    const res = await post(
      `/sessions/${sessionId}/questions/${questionIds[0]}/attempts`,
    )
      .field('attemptNo', '1')
      .field('mode', 'typed')
      .field('text', ANSWER)
      .expect(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('shows a processing attempt as pending after a refresh, and a failed one as failed', async () => {
    const stuck = await t.prisma.attempt.create({
      data: {
        sessionId,
        questionId: questionIds[0],
        attemptNo: 1,
        mode: 'typed',
        status: 'evaluating',
        idempotencyKey: `${RUN}-stuck`,
        transcript: ANSWER,
      },
    });
    let res = await get(`/sessions/${sessionId}`).expect(200);
    expect(res.body).toMatchObject({
      status: 'in_progress',
      mode: 'typed',
      currentQuestion: 1,
      results: [],
      pending: { questionId: questionIds[0], attemptNo: 1 },
      failed: null,
    });
    expect((await get(`/attempts/${stuck.id}`).expect(200)).body).toEqual({
      status: 'evaluating',
    });

    await t.prisma.attempt.update({
      where: { id: stuck.id },
      data: { status: 'failed', error: 'ai_unavailable' },
    });
    res = await get(`/sessions/${sessionId}`).expect(200);
    expect(res.body.pending).toBeNull();
    expect(res.body.failed).toEqual({
      questionId: questionIds[0],
      attemptNo: 1,
      code: 'ai_unavailable',
    });
    expect((await get(`/attempts/${stuck.id}`).expect(200)).body).toEqual({
      status: 'failed',
      code: 'ai_unavailable',
    });

    // Resubmitting a failed attempt reuses its row.
    const resubmit = await submitTyped(questionIds[0], 1, `${RUN}-q1a1`).expect(
      202,
    );
    expect(resubmit.body).toEqual({ attemptId: stuck.id });
  });

  it('runs attempt 1, replays idempotently, then runs attempt 2', async () => {
    const attemptId = (
      await t.prisma.attempt.findFirstOrThrow({
        where: { sessionId, questionId: questionIds[0], attemptNo: 1 },
      })
    ).id;
    const done = await pollDone(attemptId);
    expect(done.status).toBe('done');
    expect(done.attempt).toMatchObject({
      id: attemptId,
      attemptNo: 1,
      mode: 'typed',
      transcript: ANSWER,
      audioUrl: null,
    });
    expect(done.applied).toEqual([]);

    const replay = await submitTyped(questionIds[0], 1, `${RUN}-q1a1`).expect(
      202,
    );
    expect(replay.body).toEqual({ attemptId });
    expect(
      await t.prisma.attempt.count({
        where: { sessionId, questionId: questionIds[0] },
      }),
    ).toBe(1);

    const dup = await submitTyped(questionIds[0], 1, `${RUN}-dup`).expect(409);
    expect(dup.body.error.code).toBe('conflict');

    let res = await get(`/sessions/${sessionId}`).expect(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({
      state: 'awaiting_retry',
      second: null,
    });

    const second = await submitTyped(questionIds[0], 2, `${RUN}-q1a2`).expect(
      202,
    );
    const done2 = await pollDone(second.body.attemptId);
    expect(done2.status).toBe('done');
    expect(done2.attempt.attemptNo).toBe(2);
    expect(Array.isArray(done2.applied)).toBe(true);

    res = await get(`/sessions/${sessionId}`).expect(200);
    expect(res.body.currentQuestion).toBe(2);
    expect(res.body.results[0].state).toBe('done');
  });

  it('runs attempt 1 on question 2 and skips the retry', async () => {
    await post(
      `/sessions/${sessionId}/questions/${questionIds[1]}/skip-retry`,
    ).expect(409);
    const first = await submitTyped(questionIds[1], 1, `${RUN}-q2a1`).expect(
      202,
    );
    expect((await pollDone(first.body.attemptId)).status).toBe('done');
    await post(`/sessions/${sessionId}/complete`).expect(409);
    await post(
      `/sessions/${sessionId}/questions/${questionIds[1]}/skip-retry`,
    ).expect(204);
    await submitTyped(questionIds[1], 2, `${RUN}-q2a2`).expect(409);

    const res = await get(`/sessions/${sessionId}`).expect(200);
    expect(res.body.currentQuestion).toBe(3);
    expect(res.body.results.map((r: { state: string }) => r.state)).toEqual([
      'done',
      'done',
    ]);
  });

  it('serves audio redirects', async () => {
    const res = await get(`/questions/${questionIds[0]}/audio`).expect(302);
    expect(res.headers.location).toBeTruthy();
    await get(`/questions/${questionIds[0]}/audio`, otherCookie).expect(404);
    const a1 = await t.prisma.attempt.findFirstOrThrow({
      where: { sessionId, attemptNo: 1 },
    });
    await get(`/attempts/${a1.id}/audio`).expect(404); // typed: no recording
  });

  it('completes the session and returns the report', async () => {
    const res = await post(`/sessions/${sessionId}/complete`).expect(200);
    const report = res.body;
    expect(report).toMatchObject({
      id: sessionId,
      roleId: slug,
      number: 1,
    });
    expect(report.band).toBe(bandFor(report.score).replace('_', '-'));
    expect(report.results).toHaveLength(2);
    expect(report.results[0].second).not.toBeNull();
    expect(report.results[1].second).toBeNull();
    expect(report.results[1].applied).toEqual([]);
    expect(report.strengths.length).toBeGreaterThan(0);
    expect([1, 2]).toContain(report.strengths[0].cardId);
    expect(typeof report.bandMessage).toBe('string');

    // Idempotent; GET returns the report too.
    const again = await post(`/sessions/${sessionId}/complete`).expect(200);
    expect(again.body.score).toBe(report.score);
    expect((await get(`/sessions/${sessionId}`).expect(200)).body).toEqual(
      again.body,
    );

    const activity = await t.prisma.activityEvent.findMany({
      where: { userId },
    });
    expect(activity.map((a) => a.text)).toEqual([
      expect.stringMatching(/^Completed session 1 · \d+ .+ \(baseline\)$/),
    ]);

    const roles = await get('/roles').expect(200);
    expect(roles.body[0]).toMatchObject({
      status: { kind: 'completed', score: report.score, baseline: null },
      latest: report.score,
      latestBand: report.band,
      bestBand: report.band,
      attemptsLeft: 2,
    });

    const progress = await get(`/roles/${slug}/sessions`).expect(200);
    expect(progress.body).toEqual([
      {
        id: sessionId,
        number: 1,
        startedAt: report.startedAt,
        score: report.score,
        band: report.band,
      },
    ]);
    const history = await get(`/sessions?roleId=${slug}`).expect(200);
    expect(history.body).toEqual([{ ...progress.body[0], roleId: slug }]);
  });

  it('starts and abandons a second session', async () => {
    const res = await post(`/roles/${slug}/sessions`)
      .send(startBody)
      .expect(201);
    expect(res.body.number).toBe(2);
    await post(`/sessions/${res.body.id}/abandon`).expect(204);
    await get(`/sessions/${res.body.id}`).expect(404);
  });
});
