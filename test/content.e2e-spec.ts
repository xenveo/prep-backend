// Content e2e (plan M2, M4, M7): roles, cards, questions, approve, AI drafting, test evaluation and
// candidate flash cards, over Postgres with the fake LLM/TTS and the in-memory queue.
import {
  cleanupUsers,
  createTestApp,
  loginAs,
  runId,
  type TestApp,
} from './helpers/e2e.js';

const RUN = runId('content');
const emailFor = (label: string) => `${RUN}-${label}@example.test`;

const rubric = {
  keyPoints: [{ point: 'Names the problem', example: 'The order was late' }],
  redFlags: ['Blames the customer'],
  expectedStructure: 'star',
};
const cardInput = (n: number) => ({
  category: 'behavioural',
  question: `Card question ${n}?`,
  strongAnswerPoints: ['One', 'Two', 'Three'],
  tip: 'Keep it short.',
  commonMistakes: ['Rambling', 'No result'],
});

async function waitFor<T>(
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  ms = 5000,
): Promise<T> {
  const until = Date.now() + ms;
  let value = await fn();
  while (!ok(value) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50));
    value = await fn();
  }
  return value;
}

describe('Content (e2e)', () => {
  let t: TestApp;
  let admin: string;
  let adminId: string;
  let candidate: string;
  let candidateId: string;
  let stranger: string;
  const roleIds: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    const a = await loginAs(t.prisma, {
      email: emailFor('admin'),
      role: 'admin',
      name: 'Admin One',
    });
    admin = a.cookie;
    adminId = a.user.id;
    const c = await loginAs(t.prisma, { email: emailFor('cand') });
    candidate = c.cookie;
    candidateId = c.user.id;
    stranger = (await loginAs(t.prisma, { email: emailFor('other') })).cookie;
  });

  afterAll(async () => {
    if (t) {
      await t.prisma.jobRole.deleteMany({ where: { id: { in: roleIds } } });
      await t.prisma.auditLog.deleteMany({ where: { actorId: adminId } });
      await cleanupUsers(t.prisma, RUN);
      await t.close();
    }
  });

  const http = () => t.http();

  it('hides admin routes from candidates (404)', async () => {
    await http().get('/api/admin/roles').set('Cookie', candidate).expect(404);
  });

  it('runs the role lifecycle', async () => {
    // ---- Create and edit -------------------------------------------------
    const created = await http()
      .post('/api/admin/roles')
      .set('Cookie', admin)
      .send({
        title: `${RUN} Support`,
        seniority: 'entry',
        description:
          '<p onclick="x()">Help <b>people</b></p><script>bad()</script>',
        keySkills: ['Empathy'],
      })
      .expect(201);
    const role = created.body;
    roleIds.push(role.id);
    expect(role).toMatchObject({
      status: 'draft',
      description: '<p>Help <b>people</b></p>',
      flashCardCount: 0,
      candidatesAssigned: 0,
      avgLatestScore: null,
      updatedBy: adminId,
      updatedByName: 'Admin One',
    });
    expect(role.settings.sessionWeights).toEqual({
      firstTry: 20,
      secondTry: 55,
      learning: 25,
    });
    const { slug } = await t.prisma.jobRole.findUniqueOrThrow({
      where: { id: role.id },
    });
    expect(slug).toBe(`${RUN}-support`);

    const badWeights = await http()
      .patch(`/api/admin/roles/${role.id}`)
      .set('Cookie', admin)
      .send({
        settings: {
          ...role.settings,
          sessionWeights: { firstTry: 10, secondTry: 55, learning: 25 },
        },
      })
      .expect(400);
    expect(badWeights.body.error.code).toBe('validation_failed');

    for (const keySkills of [
      ['Empathy', 'Tact'],
      ['Empathy', 'Patience'],
    ]) {
      await http()
        .patch(`/api/admin/roles/${role.id}`)
        .set('Cookie', admin)
        .send({ keySkills })
        .expect(200);
    }
    const edits = await t.prisma.auditLog.findMany({
      where: { entityId: role.id, action: 'Edited role' },
    });
    expect(edits).toHaveLength(1);
    expect(edits[0].before).toEqual({ keySkills: ['Empathy'] });
    expect(edits[0].after).toEqual({ keySkills: ['Empathy', 'Patience'] });

    await t.prisma.roleAssignment.create({
      data: { userId: candidateId, jobRoleId: role.id, assignedBy: adminId },
    });

    // ---- Cards ------------------------------------------------------------
    const c1 = (
      await http()
        .post(`/api/admin/roles/${role.id}/cards`)
        .set('Cookie', admin)
        .send(cardInput(1))
        .expect(201)
    ).body;
    expect(c1).toMatchObject({
      position: 1,
      status: 'approved',
      createdBy: adminId,
    });
    await http()
      .post(`/api/admin/roles/${role.id}/cards`)
      .set('Cookie', admin)
      .send({ ...cardInput(2), tip: 'x'.repeat(91) })
      .expect(400);
    await http()
      .post(`/api/admin/roles/${role.id}/cards`)
      .set('Cookie', admin)
      .send({ ...cardInput(2), sampleAnswerOutline: 'x'.repeat(1001) })
      .expect(400);
    const c2 = (
      await http()
        .post(`/api/admin/roles/${role.id}/cards`)
        .set('Cookie', admin)
        .send({ ...cardInput(2), sampleAnswerOutline: '  Situation, action  ' })
        .expect(201)
    ).body;
    expect(c1.sampleAnswerOutline).toBeNull();
    expect(c2.sampleAnswerOutline).toBe('Situation, action');
    const outlined = await http()
      .put(`/api/admin/cards/${c1.id}`)
      .set('Cookie', admin)
      .send({ ...cardInput(1), sampleAnswerOutline: 'Task, result' })
      .expect(200);
    expect(outlined.body.sampleAnswerOutline).toBe('Task, result');
    // Omitting the field leaves the outline as it is.
    await http()
      .put(`/api/admin/cards/${c1.id}`)
      .set('Cookie', admin)
      .send(cardInput(1))
      .expect(200);

    const drafted = await http()
      .post(`/api/admin/roles/${role.id}/cards/draft-ai`)
      .set('Cookie', admin)
      .send({})
      .expect(200);
    expect(drafted.body).toHaveLength(3);
    expect(drafted.body.map((c: any) => c.position)).toEqual([3, 4, 5]);
    expect(drafted.body[0]).toMatchObject({
      status: 'ai_draft',
      createdBy: 'ai',
    });
    const [d3, d4, d5] = drafted.body;

    // Reorder: reverse.
    const allIds = [c1.id, c2.id, d3.id, d4.id, d5.id];
    await http()
      .put(`/api/admin/roles/${role.id}/cards/order`)
      .set('Cookie', admin)
      .send({ orderedIds: allIds.slice(1) })
      .expect(400);
    const reordered = await http()
      .put(`/api/admin/roles/${role.id}/cards/order`)
      .set('Cookie', admin)
      .send({ orderedIds: [...allIds].reverse() })
      .expect(200);
    expect(reordered.body.map((c: any) => c.id)).toEqual([...allIds].reverse());
    expect(reordered.body.map((c: any) => c.position)).toEqual([1, 2, 3, 4, 5]);

    // Discard a draft in the middle (d4 is at position 2): the rest close up.
    await http()
      .delete(`/api/admin/cards/${c1.id}`)
      .set('Cookie', admin)
      .expect(409);
    await http()
      .delete(`/api/admin/cards/${d4.id}`)
      .set('Cookie', admin)
      .expect(204);
    const afterDiscard = (
      await http()
        .get(`/api/admin/roles/${role.id}/cards`)
        .set('Cookie', admin)
        .expect(200)
    ).body;
    expect(afterDiscard.map((c: any) => [c.id, c.position])).toEqual([
      [d5.id, 1],
      [d3.id, 2],
      [c2.id, 3],
      [c1.id, 4],
    ]);

    const approvedCard = await http()
      .post(`/api/admin/cards/${d3.id}/approve`)
      .set('Cookie', admin)
      .expect(200);
    expect(approvedCard.body).toMatchObject({
      status: 'approved',
      approvedBy: adminId,
    });

    // ---- Questions --------------------------------------------------------
    const questionIds: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const q = await http()
        .post(`/api/admin/roles/${role.id}/questions`)
        .set('Cookie', admin)
        .send({
          text: `Question ${i}?`,
          category: 'behavioural',
          difficulty: 'medium',
          rubric,
          cardId: i === 5 ? null : c1.id,
        })
        .expect(201);
      questionIds.push(q.body.id);
    }
    const list = (
      await http()
        .get(`/api/admin/roles/${role.id}/questions`)
        .set('Cookie', admin)
        .expect(200)
    ).body;
    expect(list).toHaveLength(5);
    expect(list[0]).toMatchObject({
      status: 'approved',
      cardId: c1.id,
      timesAsked: 0,
      avgFirstTry: null,
    });
    expect(list[0].rubric.keyPoints[0].id).toBe('kp1');

    // Draft role: hidden from the candidate.
    await http()
      .get(`/api/roles/${slug}/cards`)
      .set('Cookie', candidate)
      .expect(404);

    let req = (
      await http()
        .get(`/api/admin/roles/${role.id}/approve-requirements`)
        .set('Cookie', admin)
        .expect(200)
    ).body;
    expect(req.canApprove).toBe(false);
    expect(req.firstUnmet).toMatch(/at least 5 questions/);
    await http()
      .post(`/api/admin/roles/${role.id}/approve`)
      .set('Cookie', admin)
      .expect(409);

    await http()
      .put(`/api/admin/questions/${questionIds[4]}`)
      .set('Cookie', admin)
      .send({
        text: 'Question 5?',
        category: 'behavioural',
        difficulty: 'medium',
        rubric,
        cardId: c2.id,
      })
      .expect(200);
    req = (
      await http()
        .get(`/api/admin/roles/${role.id}/approve-requirements`)
        .set('Cookie', admin)
        .expect(200)
    ).body;
    expect(req).toMatchObject({
      canApprove: true,
      firstUnmet: null,
      approvedFlashCards: 3,
      approvedQuestions: 5,
      candidatesToNotify: 1,
    });

    // ---- Approve ----------------------------------------------------------
    const approved = await http()
      .post(`/api/admin/roles/${role.id}/approve`)
      .set('Cookie', admin)
      .expect(200);
    expect(approved.body.notified).toBe(1);
    expect(approved.body.role).toMatchObject({
      status: 'approved',
      candidatesAssigned: 1,
      aiDraftCardCount: 1,
    });
    expect(
      await t.prisma.auditLog.count({
        where: { entityId: role.id, action: 'Approved role' },
      }),
    ).toBe(1);
    const withAudio = await waitFor(
      () =>
        t.prisma.question.count({
          where: { jobRoleId: role.id, audioKey: { not: null } },
        }),
      (n) => n === 5,
    );
    expect(withAudio).toBe(5);

    // ---- Candidate cards --------------------------------------------------
    const study = (
      await http()
        .get(`/api/roles/${slug}/cards`)
        .set('Cookie', candidate)
        .expect(200)
    ).body;
    expect(study.viewed).toEqual([]);
    expect(study.cards.map((c: any) => c.id)).toEqual([2, 3, 4]);
    expect(study.cards[0]).toEqual({
      id: 2,
      category: 'Behavioural',
      question: d3.question,
      strong: d3.strongAnswerPoints,
      outline: d3.sampleAnswerOutline,
      tip: d3.tip,
      mistakes: d3.commonMistakes,
    });
    expect(study.cards.map((c: any) => c.outline).slice(1)).toEqual([
      'Situation, action',
      'Task, result',
    ]);
    await http()
      .post(`/api/roles/${slug}/cards/1/view`)
      .set('Cookie', candidate)
      .expect(404);
    for (const id of [2, 3, 4, 4]) {
      await http()
        .post(`/api/roles/${role.id}/cards/${id}/view`)
        .set('Cookie', candidate)
        .expect(204);
    }
    const studied = await t.prisma.activityEvent.findMany({
      where: { userId: candidateId, text: 'Studied 3 of 3 flash cards' },
    });
    expect(studied).toHaveLength(1);
    expect(
      (
        await http()
          .get(`/api/roles/${slug}/cards`)
          .set('Cookie', candidate)
          .expect(200)
      ).body.viewed,
    ).toEqual([2, 3, 4]);

    const audio = await http()
      .get(`/api/roles/${slug}/cards/2/audio`)
      .set('Cookie', candidate)
      .expect(302);
    expect(audio.headers.location).toBeTruthy();

    await http()
      .get(`/api/roles/${slug}/cards`)
      .set('Cookie', stranger)
      .expect(404);

    // ---- Test evaluation and question drafting ----------------------------
    const test = await http()
      .post(`/api/admin/questions/${questionIds[0]}/test`)
      .set('Cookie', admin)
      .send({
        answer:
          'In my last role a customer had a late order. I apologised, tracked it and called back the same day with the delivery time.',
      })
      .expect(200);
    expect(test.body).toMatchObject({ isTest: true });
    expect(['not_ready', 'developing', 'nearly', 'ready']).toContain(
      test.body.band,
    );
    expect(test.body.matched).toContain('Names the problem');
    const cached = await t.prisma.question.findUniqueOrThrow({
      where: { id: questionIds[0] },
    });
    expect(cached.sampleEvaluation).toEqual(test.body);
    expect(
      await t.prisma.attempt.count({ where: { questionId: questionIds[0] } }),
    ).toBe(0);

    const draftedQs = await http()
      .post(`/api/admin/roles/${role.id}/questions/draft-ai`)
      .set('Cookie', admin)
      .send({ count: 2 })
      .expect(200);
    expect(draftedQs.body).toHaveLength(2);
    expect(draftedQs.body[0]).toMatchObject({ status: 'ai_draft' });
    expect(draftedQs.body[0].rubric.keyPoints.length).toBeGreaterThan(0);
    const after = await t.prisma.jobRole.findUniqueOrThrow({
      where: { id: role.id },
    });
    expect(after.lastAiDraftAt).not.toBeNull();

    // A never-asked question is deleted.
    await http()
      .delete(`/api/admin/questions/${draftedQs.body[1].id}`)
      .set('Cookie', admin)
      .expect(204);
    expect(
      await t.prisma.question.count({ where: { id: draftedQs.body[1].id } }),
    ).toBe(0);

    // ---- Archive ----------------------------------------------------------
    const archived = await http()
      .post(`/api/admin/roles/${role.id}/archive`)
      .set('Cookie', admin)
      .expect(200);
    expect(archived.body).toMatchObject({
      status: 'archived',
      avgLatestScore: null,
    });
    const readOnly = await http()
      .patch(`/api/admin/roles/${role.id}`)
      .set('Cookie', admin)
      .send({ title: 'New' })
      .expect(409);
    expect(readOnly.body.error.code).toBe('conflict');
    await http()
      .get(`/api/roles/${slug}/cards`)
      .set('Cookie', candidate)
      .expect(404);

    const listed = (
      await http()
        .get('/api/admin/roles?status=archived')
        .set('Cookie', admin)
        .expect(200)
    ).body;
    expect(listed.map((r: any) => r.id)).toContain(role.id);
    expect(listed.every((r: any) => r.status === 'archived')).toBe(true);
  });

  it('404s on unknown or malformed ids', async () => {
    await http()
      .get('/api/admin/roles/not-a-uuid')
      .set('Cookie', admin)
      .expect(404);
    await http()
      .get('/api/admin/roles/00000000-0000-4000-8000-000000000000')
      .set('Cookie', admin)
      .expect(404);
  });
});
