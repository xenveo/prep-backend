import {
  STORAGE_ADAPTER,
  type StorageAdapter,
} from '../src/adapters/storage/storage.adapter.js';
import { ERASED_ITEM_LABEL } from '../src/common/audit/audit.service.js';
import {
  QUEUE_SERVICE,
  type QueueJob,
  type QueueService,
} from '../src/common/queue/queue.types.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { EmailService } from '../src/jobs/email/email.service.js';
import type { EmailJob } from '../src/jobs/email/templates/templates.js';
import { DEFAULT_ROLE_SETTINGS } from '../src/modules/interview/types.js';
import {
  ErasureService,
  erasurePurgeJobId,
} from '../src/modules/privacy/erasure.service.js';
import { RetentionService } from '../src/modules/privacy/retention.service.js';
import {
  cleanupUsers,
  createTestApp,
  loginAs,
  runId,
  settle,
  type TestApp,
  waitFor,
} from './helpers/e2e.js';

// Settings, audit, AI config, exports and two-stage erasure (plan M7 settings, M8 privacy).
const RUN = runId('privacy');
const emailFor = (label: string) => `${RUN}-${label}@example.test`;

/** No job, or a finished one: nothing left to run. */
const idle = (job: QueueJob | null) =>
  !job || job.status === 'done' || job.status === 'failed';

describe('Settings, audit and privacy (e2e)', () => {
  let t: TestApp;
  let storage: StorageAdapter;
  let queue: QueueService;
  const sent: EmailJob[] = [];
  let superCookie: string;
  let superId: string;
  let adminCookie: string;
  let roleId: string;
  let questionId: string;
  let originalSettings: Prisma.JsonValue | null = null;
  /** Users erased by a test: gone from `users`, so cleanup finds their rows by id. */
  const erasedIds: string[] = [];

  /** A candidate with one completed session and an answer whose audio is in storage. */
  async function candidateWithAudio(label: string) {
    const login = await loginAs(t.prisma, {
      email: emailFor(label),
      name: `Cand ${label}`,
    });
    const session = await t.prisma.session.create({
      data: {
        userId: login.user.id,
        jobRoleId: roleId,
        number: 1,
        status: 'completed',
        mode: 'voice',
        weightsSnapshot: {},
        promptVersions: {},
      },
    });
    const audioKey = `audio/${session.id}/${label}.webm`;
    await storage.put(audioKey, Buffer.from('fake audio'), 'audio/webm');
    await t.prisma.attempt.create({
      data: {
        sessionId: session.id,
        questionId,
        attemptNo: 1,
        mode: 'voice',
        status: 'done',
        idempotencyKey: `${RUN}-${label}`,
        transcript: `my answer ${label}`,
        audioKey,
        audioExpiresAt: new Date(Date.now() + 30 * 864e5),
        score: 64,
      },
    });
    return { ...login, sessionId: session.id, audioKey };
  }

  beforeAll(async () => {
    t = await createTestApp((b) =>
      b.overrideProvider(EmailService).useValue({
        send: async (job: EmailJob) => void sent.push(job),
      }),
    );
    storage = t.app.get(STORAGE_ADAPTER);
    queue = t.app.get(QUEUE_SERVICE);
    originalSettings =
      (await t.prisma.workspaceSettings.findUnique({ where: { id: 1 } }))
        ?.data ?? null;

    const sup = await loginAs(t.prisma, {
      email: emailFor('super'),
      role: 'super_admin',
      name: 'Super Tester',
    });
    superCookie = sup.cookie;
    superId = sup.user.id;
    adminCookie = (
      await loginAs(t.prisma, { email: emailFor('admin'), role: 'admin' })
    ).cookie;
    const role = await t.prisma.jobRole.create({
      data: {
        slug: RUN,
        title: `${RUN} role`,
        seniority: 'entry',
        keySkills: [],
        status: 'approved',
        settings: DEFAULT_ROLE_SETTINGS,
      },
    });
    roleId = role.id;
    questionId = (
      await t.prisma.question.create({
        data: {
          jobRoleId: roleId,
          text: 'Tell me about a project',
          category: 'behavioural',
          difficulty: 'easy',
          rubric: { keyPoints: [], redFlags: [], expectedStructure: '' },
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (!t) return;
    const ids = (
      await t.prisma.unfiltered.user.findMany({
        where: { email: { startsWith: RUN } },
        select: { id: true },
      })
    ).map((u) => u.id);
    const subjects = [...ids, ...erasedIds];
    await t.prisma.promptVersion.deleteMany({
      where: { createdBy: { in: ids } },
    });
    const exportsMade = await t.prisma.exportJob.findMany({
      where: { requestedBy: { in: subjects } },
    });
    for (const e of exportsMade)
      if (e.fileKey)
        await (e.fileKey.endsWith('/')
          ? storage.deletePrefix(e.fileKey)
          : storage.delete(e.fileKey));
    await t.prisma.exportJob.deleteMany({
      where: { requestedBy: { in: subjects } },
    });
    await t.prisma.erasureReceipt.deleteMany({
      where: { subjectId: { in: subjects } },
    });
    await t.prisma.auditLog.deleteMany({
      where: {
        OR: [{ actorId: { in: subjects } }, { entityId: { in: subjects } }],
      },
    });
    await cleanupUsers(t.prisma, RUN);
    await t.prisma.jobRole.deleteMany({ where: { slug: RUN } });
    if (originalSettings === null)
      await t.prisma.workspaceSettings.deleteMany({ where: { id: 1 } });
    else
      await t.prisma.workspaceSettings.update({
        where: { id: 1 },
        data: { data: originalSettings as Prisma.InputJsonValue },
      });
    await t.close();
  });

  describe('workspace settings', () => {
    it('GET returns the admin view to any admin', async () => {
      const res = await t
        .http()
        .get('/api/admin/settings')
        .set('Cookie', adminCookie)
        .expect(200);
      expect(Object.keys(res.body).sort()).toEqual(
        [
          'audioRetentionDays',
          'candidatesCanDeleteData',
          'feedbackLength',
          'inviteLinkExpiryDays',
          'language',
          'lastExportAt',
          'replyTo',
          'senderName',
          'transcriptRetention',
          'voice',
        ].sort(),
      );
    });

    it('PATCH is super admin only (404 for an admin)', async () => {
      await t
        .http()
        .patch('/api/admin/settings')
        .set('Cookie', adminCookie)
        .send({ senderName: 'Nope' })
        .expect(404);
    });

    it('PATCH saves and writes one audit row per changed field', async () => {
      const before = (
        await t
          .http()
          .get('/api/admin/settings')
          .set('Cookie', superCookie)
          .expect(200)
      ).body;
      const audioRetentionDays = before.audioRetentionDays === 7 ? 90 : 7;
      const res = await t
        .http()
        .patch('/api/admin/settings')
        .set('Cookie', superCookie)
        .send({
          audioRetentionDays,
          senderName: `${RUN} sender`,
          voice: before.voice,
        })
        .expect(200);
      expect(res.body).toMatchObject({
        audioRetentionDays,
        senderName: `${RUN} sender`,
      });
      const rows = await t.prisma.auditLog.findMany({
        where: { actorId: superId, entity: 'workspace_settings' },
        orderBy: { action: 'asc' },
      });
      expect(rows.map((r) => r.action)).toEqual([
        'Changed audio retention',
        'Changed sender name',
      ]);
      expect(rows[0].itemLabel).toBe(
        `${before.audioRetentionDays} days → ${audioRetentionDays} days`,
      );
    });

    it('PATCH rejects invalid values', async () => {
      const res = await t
        .http()
        .patch('/api/admin/settings')
        .set('Cookie', superCookie)
        .send({ audioRetentionDays: 14 })
        .expect(400);
      expect(res.body.error.code).toBe('validation_failed');
    });

    it('voice sample redirects to signed audio; unknown voice is 404', async () => {
      const res = await t
        .http()
        .get(
          `/api/admin/settings/voices/${encodeURIComponent('Calm, mid-pitch')}/sample`,
        )
        .set('Cookie', adminCookie)
        .expect(302);
      expect(res.headers.location).toContain('/api/storage/local/tts/');
      await t
        .http()
        .get('/api/admin/settings/voices/Robot/sample')
        .set('Cookie', adminCookie)
        .expect(404);
    });
  });

  describe('audit log', () => {
    it('filters by actor, action and date, newest first with actor names', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await t
        .http()
        .get('/api/admin/audit')
        .query({ actorId: superId, from: today, to: today })
        .set('Cookie', adminCookie)
        .expect(200);
      expect(res.body.total).toBeGreaterThanOrEqual(2);
      expect(res.body.rows[0]).toMatchObject({
        actorId: superId,
        actor: 'Super Tester',
      });
      const times = res.body.rows.map((r: { at: string }) => r.at);
      expect([...times].sort().reverse()).toEqual(times);

      const byAction = await t
        .http()
        .get('/api/admin/audit')
        .query({ actorId: superId, action: 'Changed sender name' })
        .set('Cookie', adminCookie)
        .expect(200);
      expect(byAction.body.rows).toHaveLength(1);

      const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
      const none = await t
        .http()
        .get('/api/admin/audit')
        .query({ actorId: superId, to: yesterday })
        .set('Cookie', adminCookie)
        .expect(200);
      expect(none.body.total).toBe(0);
    });

    it('lists distinct actions', async () => {
      const res = await t
        .http()
        .get('/api/admin/audit/actions')
        .set('Cookie', adminCookie)
        .expect(200);
      expect(res.body).toContain('Changed sender name');
      expect([...res.body].sort()).toEqual(res.body);
    });
  });

  describe('AI config', () => {
    it('is super admin only; PUT activates a new version', async () => {
      await t
        .http()
        .get('/api/admin/ai-config')
        .set('Cookie', adminCookie)
        .expect(404);
      const before = await t
        .http()
        .get('/api/admin/ai-config')
        .set('Cookie', superCookie)
        .expect(200);
      const summariser = before.body.roles.find(
        (r: { role: string }) => r.role === 'summariser',
      );
      const res = await t
        .http()
        .put('/api/admin/ai-config')
        .set('Cookie', superCookie)
        .send({ role: 'summariser', model: 'test-model', temperature: 0.3 })
        .expect(200);
      expect(res.body.active).toMatchObject({
        model: 'test-model',
        temperature: 0.3,
        template: summariser.active.template,
      });
      expect(res.body.active.version).toBeGreaterThan(
        summariser.active.version,
      );
      expect(
        res.body.versions.filter((v: { active: boolean }) => v.active),
      ).toHaveLength(1);

      // Put the previous active version back so other specs see the original prompt.
      await t.prisma.promptVersion.deleteMany({
        where: { role: 'summariser', createdBy: superId },
      });
      if (summariser.active.version > 0)
        await t.prisma.promptVersion.updateMany({
          where: { role: 'summariser', version: summariser.active.version },
          data: { active: true },
        });
    });
  });

  describe('candidate export', () => {
    it('emails a JSON bundle with transcripts and no audio', async () => {
      const cand = await candidateWithAudio('exporter');
      const res = await t
        .http()
        .get('/api/me/export')
        .set('Cookie', cand.cookie)
        .expect(202);
      const { requestId } = res.body;
      // The request is completed last, after the bundle is stored and emailed.
      await settle(t, async () => {
        const request = await t.prisma.privacyRequest.findUnique({
          where: { id: requestId },
        });
        const job = await t.prisma.exportJob.findFirst({
          where: { subjectId: cand.user.id },
        });
        return request?.status !== 'pending' || job?.status === 'failed';
      });

      const job = await t.prisma.exportJob.findFirst({
        where: { subjectId: cand.user.id },
      });
      expect(job).toMatchObject({ status: 'done', kind: 'candidate_json' });
      const bundle = (await storage.get(job!.fileKey!)).toString();
      expect(bundle).toContain('my answer exporter');
      expect(bundle).not.toContain(cand.audioKey);
      expect(bundle).not.toMatch(/audio/i);
      expect(
        sent.find(
          (m) => m.template === 'export-ready' && m.to === cand.user.email,
        ),
      ).toBeDefined();
      const request = await t.prisma.privacyRequest.findUnique({
        where: { id: requestId },
      });
      expect(request?.status).toBe('completed');
    });
  });

  describe('transcript retention', () => {
    it('strips transcripts and verbatim quotes, keeping scores and coaching', async () => {
      const cand = await candidateWithAudio('old');
      const old = new Date(Date.now() - 2 * 365 * 864e5);
      await t.prisma.attempt.updateMany({
        where: { sessionId: cand.sessionId },
        data: {
          submittedAt: old,
          words: [{ w: 'my', start: 0, end: 0.2 }],
          evidence: [{ dimension: 'content', quote: 'my answer', note: 'n' }],
          feedback: {
            worked: ['Clear example'],
            improvementPoints: ['Add a result'],
            applied: [
              {
                point: 'Add a result',
                status: 'partly',
                evidence: 'my answer',
              },
            ],
            highlights: [{ quote: 'my answer', kind: 'match', note: 'n' }],
          },
        },
      });
      const cutoff = new Date(Date.now() - 18 * 30 * 864e5);
      const service = t.app.get(RetentionService);
      expect(await service.clearAnswerText(cutoff)).toBeGreaterThanOrEqual(1);
      const row = await t.prisma.attempt.findFirst({
        where: { sessionId: cand.sessionId },
      });
      expect(row).toMatchObject({
        transcript: null,
        words: null,
        evidence: null,
        score: 64,
        feedback: {
          worked: ['Clear example'],
          improvementPoints: ['Add a result'],
          applied: [{ point: 'Add a result', status: 'partly', evidence: '' }],
          highlights: [],
        },
      });
      // Rows already stripped are not rewritten.
      expect(await service.clearAnswerText(cutoff)).toBe(0);
    });
  });

  describe('workspace export', () => {
    it('builds the CSVs and serves 24 h links to super admins', async () => {
      await t
        .http()
        .post('/api/admin/exports')
        .set('Cookie', adminCookie)
        .expect(404);
      const res = await t
        .http()
        .post('/api/admin/exports')
        .set('Cookie', superCookie)
        .expect(201);
      expect(res.body.lastExportAt).toEqual(expect.any(String));
      await settle(t, async () => {
        const job = await t.prisma.exportJob.findUnique({
          where: { id: res.body.exportId },
        });
        return job?.status === 'done' || job?.status === 'failed';
      });
      const view = await t
        .http()
        .get(`/api/admin/exports/${res.body.exportId}`)
        .set('Cookie', superCookie)
        .expect(200);
      expect(view.body.status).toBe('done');
      expect(view.body.files.map((f: { name: string }) => f.name)).toEqual([
        'candidates.csv',
        'sessions.csv',
        'scores.csv',
      ]);
      const scores = (
        await storage.get(`exports/${res.body.exportId}/scores.csv`)
      ).toString();
      expect(scores).not.toContain('my answer');
      const audit = await t.prisma.auditLog.findFirst({
        where: { entityId: res.body.exportId },
      });
      expect(audit?.action).toBe('Exported all data');
    });
  });

  describe('deletion (DPDP two-stage erasure)', () => {
    it('candidate requests, super admin completes, user is hidden at once, then purged', async () => {
      const cand = await candidateWithAudio('leaver');
      erasedIds.push(cand.user.id);
      const asked = await t
        .http()
        .post('/api/me/deletion-request')
        .set('Cookie', cand.cookie)
        .expect(202);
      const again = await t
        .http()
        .post('/api/me/deletion-request')
        .set('Cookie', cand.cookie)
        .expect(202);
      expect(again.body.requestId).toBe(asked.body.requestId);

      const list = await t
        .http()
        .get('/api/admin/privacy/requests')
        .set('Cookie', superCookie)
        .expect(200);
      expect(
        list.body.rows.find(
          (r: { id: string }) => r.id === asked.body.requestId,
        ),
      ).toMatchObject({
        kind: 'deletion',
        status: 'pending',
        email: cand.user.email,
      });
      await t
        .http()
        .post(`/api/admin/privacy/requests/${asked.body.requestId}/complete`)
        .set('Cookie', adminCookie)
        .expect(404);
      await t
        .http()
        .post(`/api/admin/privacy/requests/${asked.body.requestId}/complete`)
        .set('Cookie', superCookie)
        .expect(200);

      // Stage 1: hidden at once.
      const receipt = await waitFor(() =>
        t.prisma.erasureReceipt.findFirst({
          where: { subjectId: cand.user.id },
        }),
      );
      expect(receipt.purgedAt).toBeNull();
      expect(receipt.purgeAfter.getTime()).toBeGreaterThan(Date.now());
      await t.http().get('/api/me').set('Cookie', cand.cookie).expect(401);
      expect(
        await t.prisma.user.findUnique({ where: { id: cand.user.id } }),
      ).toBeNull();
      const hiddenRow = await t.prisma.unfiltered.user.findUnique({
        where: { id: cand.user.id },
      });
      expect(hiddenRow?.deletedAt).not.toBeNull();
      expect(await storage.exists(cand.audioKey)).toBe(false);
      const attempt = await t.prisma.unfiltered.attempt.findFirst({
        where: { sessionId: cand.sessionId },
      });
      expect(attempt?.audioKey).toBeNull();
      const after = await t
        .http()
        .get('/api/admin/privacy/requests')
        .set('Cookie', superCookie)
        .expect(200);
      expect(
        after.body.rows.find(
          (r: { id: string }) => r.id === asked.body.requestId,
        ),
      ).toBeUndefined();

      // Stage 2, run now instead of after the grace period.
      await t.app.get(ErasureService).purge(cand.user.id);
      expect(
        await t.prisma.unfiltered.user.findUnique({
          where: { id: cand.user.id },
        }),
      ).toBeNull();
      expect(
        await t.prisma.unfiltered.session.findUnique({
          where: { id: cand.sessionId },
        }),
      ).toBeNull();
      const done = await t.prisma.erasureReceipt.findUnique({
        where: { id: receipt.id },
      });
      expect(done?.purgedAt).not.toBeNull();
      const audit = await t.prisma.auditLog.findMany({
        where: { entityId: cand.user.id },
      });
      expect(audit.length).toBeGreaterThan(0);
      for (const row of audit) expect(row.itemLabel).toBe(ERASED_ITEM_LABEL);
      expect(
        sent.find(
          (m) => m.template === 'erasure-complete' && m.to === cand.user.email,
        ),
      ).toBeDefined();

      // Idempotent: a second run is a no-op.
      await t.app.get(ErasureService).purge(cand.user.id);
      // Stage 1 has finished and no delayed stage 2 job is left behind.
      await settle(
        t,
        async () =>
          idle(
            await queue.getJob('erasure-hide', `erasure-hide-${cand.user.id}`),
          ) &&
          idle(
            await queue.getJob(
              'erasure-purge',
              erasurePurgeJobId(cand.user.id),
            ),
          ),
      );
    });

    it('is forbidden when the workspace turns candidate deletion off', async () => {
      const cand = await loginAs(t.prisma, { email: emailFor('stayer') });
      await t
        .http()
        .patch('/api/admin/settings')
        .set('Cookie', superCookie)
        .send({ candidatesCanDeleteData: false })
        .expect(200);
      const res = await t
        .http()
        .post('/api/me/deletion-request')
        .set('Cookie', cand.cookie)
        .expect(403);
      expect(res.body.error.code).toBe('forbidden');
    });
  });
});
