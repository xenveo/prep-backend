import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../src/common/crypto.js';
import { EmailService } from '../src/jobs/email/email.service.js';
import type { EmailJob } from '../src/jobs/email/templates/templates.js';
import { DEFAULT_ROLE_SETTINGS } from '../src/modules/interview/types.js';
import {
  cleanupUsers,
  createTestApp,
  loginAs,
  runId,
  type TestApp,
} from './helpers/e2e.js';

// Admin MCP extensions: read invitation lifecycle and queue active-candidate reminders.
const RUN = runId('mcp-admin');
const emailFor = (label: string) => `${RUN}-${label}@example.test`;

describe('MCP admin support (e2e)', () => {
  let t: TestApp;
  let adminCookie: string;
  let adminId: string;
  let candidateCookie: string;
  let roleId: string;
  let batchId: string;
  const candidates: Record<string, string> = {};
  const queued: EmailJob[] = [];
  let failQueue = false;

  beforeAll(async () => {
    t = await createTestApp((builder) =>
      builder.overrideProvider(EmailService).useValue({
        send: async (job: EmailJob) => {
          if (failQueue) throw new Error('Fake queue unavailable');
          queued.push(job);
        },
      }),
    );
    const admin = await loginAs(t.prisma, {
      email: emailFor('admin'),
      role: 'admin',
    });
    adminId = admin.user.id;
    adminCookie = admin.cookie;
    const role = await t.prisma.jobRole.create({
      data: {
        title: `${RUN} approved role`,
        slug: `${RUN}-approved`,
        seniority: 'entry',
        keySkills: [],
        status: 'approved',
        settings: DEFAULT_ROLE_SETTINGS,
      },
    });
    roleId = role.id;
    for (const [label, extra] of [
      ['active', {}],
      ['pending', { status: 'invite_pending' as const }],
      ['deactivated', { status: 'deactivated' as const }],
      ['expired', { accessExpiresAt: new Date(Date.now() - 60_000) }],
      ['erased', { deletedAt: new Date() }],
      ['unassigned', {}],
      ['queue-failure', {}],
    ] as const) {
      const { user, cookie } = await loginAs(t.prisma, {
        email: emailFor(label),
        ...extra,
      });
      candidates[label] = user.id;
      if (label === 'active') candidateCookie = cookie;
      if (label !== 'unassigned') {
        await t.prisma.roleAssignment.create({
          data: { userId: user.id, jobRoleId: roleId, assignedBy: adminId },
        });
      }
    }
    const batch = await t.prisma.inviteBatch.create({
      data: {
        createdBy: adminId,
        source: 'csv',
        fileName: 'mcp.csv',
        sent: 5,
        skipped: 2,
      },
    });
    batchId = batch.id;
    for (const [label, status, expired] of [
      ['pending', 'pending', false],
      ['expired', 'pending', true],
      ['active', 'accepted', true],
      ['deactivated', 'revoked', false],
      ['erased', 'pending', false],
    ] as const) {
      await t.prisma.invite.create({
        data: {
          userId: candidates[label],
          email: emailFor(label),
          invitedBy: adminId,
          batchId,
          tokenHash: sha256Hex(randomUUID()),
          status,
          sentAt: new Date(Date.now() - 120_000),
          expiresAt: new Date(Date.now() + (expired ? -60_000 : 60_000)),
        },
      });
    }
  });

  afterAll(async () => {
    if (t) {
      await t.prisma.auditLog.deleteMany({ where: { actorId: adminId } });
      await t.prisma.inviteBatch.deleteMany({ where: { createdBy: adminId } });
      await cleanupUsers(t.prisma, RUN);
      await t.prisma.jobRole.deleteMany({
        where: { slug: { startsWith: RUN } },
      });
      await t.close();
    }
  });

  it('requires authentication and hides both admin operations from candidates', async () => {
    await t.http().get(`/api/admin/invites/batches/${batchId}`).expect(401);
    await t
      .http()
      .post('/api/admin/candidates/remind')
      .send({ candidateIds: [candidates.active] })
      .expect(401);
    await t
      .http()
      .get(`/api/admin/invites/batches/${batchId}`)
      .set('Cookie', candidateCookie)
      .expect(404);
    await t
      .http()
      .post('/api/admin/candidates/remind')
      .set('Cookie', candidateCookie)
      .send({ candidateIds: [candidates.active] })
      .expect(404);
  });

  it('validates identifiers and limits before executing reminder work', async () => {
    await t
      .http()
      .get('/api/admin/invites/batches/bad-id')
      .set('Cookie', adminCookie)
      .expect(400);
    await t
      .http()
      .get(`/api/admin/invites/batches/${randomUUID()}`)
      .set('Cookie', adminCookie)
      .expect(404);
    for (const body of [
      { candidateIds: [] },
      { candidateIds: ['bad-id'] },
      { candidateIds: Array.from({ length: 101 }, () => candidates.active) },
      { candidateIds: [candidates.active], message: 'Custom message' },
    ]) {
      await t
        .http()
        .post('/api/admin/candidates/remind')
        .set('Cookie', adminCookie)
        .send(body)
        .expect(400);
    }
    expect(queued).toHaveLength(0);
  });

  it('returns lifecycle without erased subjects, identities or invitation credentials', async () => {
    const { body } = await t
      .http()
      .get(`/api/admin/invites/batches/${batchId}`)
      .set('Cookie', adminCookie)
      .expect(200);
    expect(body).toMatchObject({
      batchId,
      createdBy: adminId,
      source: 'csv',
      fileName: 'mcp.csv',
      // The immutable historical creation count may exceed the visible lifecycle after erasure.
      created: 5,
      skipped: 2,
      lifecycle: { pending: 1, accepted: 1, expired: 1, revoked: 1 },
      delivery: { status: 'unavailable' },
    });
    const json = JSON.stringify(body);
    expect(json).not.toContain('tokenHash');
    expect(json).not.toContain(emailFor('active'));
    expect(json).not.toContain(candidates.erased);
  });

  it('defaults to a side-effect-free preview and filters candidate eligibility', async () => {
    const ids = [
      'active',
      'pending',
      'deactivated',
      'expired',
      'erased',
      'unassigned',
    ].map((key) => candidates[key]);
    const { body } = await t
      .http()
      .post('/api/admin/candidates/remind')
      .set('Cookie', adminCookie)
      .send({ candidateIds: [...ids, candidates.active] })
      .expect(200);
    expect(body).toMatchObject({
      dryRun: true,
      eligible: 1,
      queued: 0,
      skipped: 5,
    });
    expect(body.rows).toEqual(
      ids.map((candidateId, i) => ({
        candidateId,
        status: i === 0 ? 'eligible' : 'ineligible',
      })),
    );
    expect(queued).toHaveLength(0);
    expect(
      await t.prisma.auditLog.count({
        where: { actorId: adminId, action: 'Sent practice reminders' },
      }),
    ).toBe(0);
  });

  it('queues one fixed reminder and enforces cooldown on subsequent actual sends', async () => {
    const payload = { candidateIds: [candidates.active], dryRun: false };
    const first = await t
      .http()
      .post('/api/admin/candidates/remind')
      .set('Cookie', adminCookie)
      .send(payload)
      .expect(200);
    expect(first.body).toMatchObject({
      dryRun: false,
      queued: 1,
      skipped: 0,
      rows: [{ candidateId: candidates.active, status: 'queued' }],
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      template: 'practice-reminder',
      to: emailFor('active'),
    });
    const link = new URL((queued[0].vars as { link: string }).link);
    expect(link.pathname).toBe('/login');
    expect(link.search).toBe('');
    const second = await t
      .http()
      .post('/api/admin/candidates/remind')
      .set('Cookie', adminCookie)
      .send(payload)
      .expect(200);
    expect(second.body).toMatchObject({
      queued: 0,
      skipped: 1,
      rows: [{ candidateId: candidates.active, status: 'cooldown' }],
    });
    expect(queued).toHaveLength(1);
    const audit = await t.prisma.auditLog.findMany({
      where: { actorId: adminId, action: 'Sent practice reminders' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].after).toEqual({
      candidateIds: [candidates.active],
      queued: 1,
    });
    expect(JSON.stringify(audit)).not.toContain(emailFor('active'));
  });

  it('reports failed queue acceptance and keeps cooldown after an ambiguous failure', async () => {
    failQueue = true;
    const payload = {
      candidateIds: [candidates['queue-failure']],
      dryRun: false,
    };
    const first = await t
      .http()
      .post('/api/admin/candidates/remind')
      .set('Cookie', adminCookie)
      .send(payload)
      .expect(200);
    expect(first.body).toMatchObject({
      queued: 0,
      rows: [{ status: 'queue_failed' }],
    });
    failQueue = false;
    const second = await t
      .http()
      .post('/api/admin/candidates/remind')
      .set('Cookie', adminCookie)
      .send(payload)
      .expect(200);
    expect(second.body).toMatchObject({
      queued: 0,
      rows: [{ status: 'cooldown' }],
    });
    expect(queued).toHaveLength(1);
  });
});
