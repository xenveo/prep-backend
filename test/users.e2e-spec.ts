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

// Admin user management (plan M3): invites, resend/revoke, deactivate, assignments, saved filters, admins.
const RUN = runId('users');
const emailFor = (label: string) => `${RUN}-${label}@example.test`;

describe('Users and invites (e2e)', () => {
  let t: TestApp;
  const sent: EmailJob[] = [];
  let superCookie: string;
  let superId: string;
  let adminCookie: string;
  const roles: Record<
    'alpha' | 'beta' | 'draft' | 'archived',
    { id: string; title: string; slug: string }
  > = {} as never;

  beforeAll(async () => {
    t = await createTestApp((b) =>
      b.overrideProvider(EmailService).useValue({
        send: async (job: EmailJob) => void sent.push(job),
      }),
    );
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
    const make = async (
      key: keyof typeof roles,
      status: 'approved' | 'draft' | 'archived',
    ) => {
      const r = await t.prisma.jobRole.create({
        data: {
          slug: `${RUN}-${key}`,
          title: `${RUN} ${key}`,
          seniority: 'entry',
          keySkills: [],
          status,
          settings: DEFAULT_ROLE_SETTINGS,
        },
      });
      roles[key] = { id: r.id, title: r.title, slug: r.slug };
    };
    await make('alpha', 'approved');
    await make('beta', 'approved');
    await make('draft', 'draft');
    await make('archived', 'archived');
  });

  afterAll(async () => {
    if (t) {
      const ids = (
        await t.prisma.unfiltered.user.findMany({
          where: { email: { startsWith: RUN } },
          select: { id: true },
        })
      ).map((u) => u.id);
      await t.prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
      await t.prisma.inviteBatch.deleteMany({
        where: { createdBy: { in: ids } },
      });
      await cleanupUsers(t.prisma, RUN);
      await t.prisma.jobRole.deleteMany({
        where: { slug: { startsWith: RUN } },
      });
    }
    await t?.close();
  });

  const asSuper = () => ({ Cookie: superCookie });
  const lastMailTo = (to: string) =>
    [...sent].reverse().find((m) => m.to === to);
  const tokenFrom = (job: EmailJob | undefined) => {
    if (!job || !('link' in job.vars)) throw new Error('No invite email');
    return new URL(job.vars.link).searchParams.get('token')!;
  };

  async function inviteOne(label: string, roleIds = [roles.alpha.id]) {
    const res = await t
      .http()
      .post('/api/admin/invites')
      .set(asSuper())
      .send({
        source: 'single',
        rows: [{ email: emailFor(label), name: `Cand ${label}`, roleIds }],
      })
      .expect(200);
    expect(res.body.sent).toBe(1);
    return res.body.candidateIds[0] as string;
  }

  describe('access', () => {
    it('hides admin routes from candidates (404)', async () => {
      const { cookie } = await loginAs(t.prisma, { email: emailFor('cand0') });
      await t
        .http()
        .get('/api/admin/invites/context')
        .set('Cookie', cookie)
        .expect(404);
      await t
        .http()
        .post('/api/admin/candidates/deactivate')
        .set('Cookie', cookie)
        .send({ ids: [superId] })
        .expect(404);
    });

    it('lets any admin list admins but only a super admin change them', async () => {
      const res = await t
        .http()
        .get('/api/admin/admins')
        .set('Cookie', adminCookie)
        .expect(200);
      expect(res.body.some((a: { id: string }) => a.id === superId)).toBe(true);
      await t
        .http()
        .post('/api/admin/admins')
        .set('Cookie', adminCookie)
        .send({ email: emailFor('nope'), access: 'admin' })
        .expect(404);
    });
  });

  describe('invites', () => {
    it('returns the invite context', async () => {
      const res = await t
        .http()
        .get('/api/admin/invites/context')
        .set(asSuper())
        .expect(200);
      expect(res.body.approvedRoleNames).toContain(roles.alpha.title);
      expect(res.body.draftRoleNames).toContain(roles.draft.title);
      expect(res.body.approvedRoleNames).not.toContain(roles.archived.title);
      expect(res.body.existingEmails).toContain(emailFor('super'));
    });

    it('validates CSV rows', async () => {
      const res = await t
        .http()
        .post('/api/admin/invites/validate')
        .set(asSuper())
        .send({
          rows: [
            {
              email: emailFor('v1'),
              name: 'V1',
              roles: [roles.alpha.title.toUpperCase()],
            },
            { email: 'bad', name: 'Bad', roles: [roles.alpha.title] },
            { email: emailFor('super'), name: 'S', roles: [roles.alpha.title] },
            { email: emailFor('v1'), name: 'Dup', roles: [roles.alpha.title] },
            { email: emailFor('v2'), name: 'U', roles: ['No such role'] },
            { email: emailFor('v3'), name: 'D', roles: [roles.draft.title] },
            { email: emailFor('v4'), name: 'A', roles: [roles.archived.title] },
          ],
        })
        .expect(200);
      expect(
        res.body.rows.map((r: { result: string; badRole?: string }) => [
          r.result,
          r.badRole,
        ]),
      ).toEqual([
        ['ready', undefined],
        ['invalid_email', undefined],
        ['already_invited', undefined],
        ['duplicate_in_file', undefined],
        ['unknown_role', 'No such role'],
        ['role_not_approved', roles.draft.title],
        ['unknown_role', roles.archived.title],
      ]);
      expect(res.body.summary).toEqual({ total: 7, ready: 1, needFixing: 6 });
    });

    it('sends a batch: user, invite, assignments, batch, audit and email; the link logs in', async () => {
      const res = await t
        .http()
        .post('/api/admin/invites')
        .set(asSuper())
        .send({
          source: 'csv',
          fileName: `${RUN}.csv`,
          accessUntil: '2099-12-31',
          maxSessions: 3,
          rows: [
            {
              email: emailFor('inv1'),
              name: 'Invited One',
              roleIds: [roles.alpha.id, roles.beta.id],
            },
            {
              email: emailFor('inv2'),
              name: 'Draft',
              roleIds: [roles.draft.id],
            },
            {
              email: emailFor('super'),
              name: 'Taken',
              roleIds: [roles.alpha.id],
            },
          ],
        })
        .expect(200);
      expect(res.body).toMatchObject({ sent: 1, skipped: 2 });
      const [id] = res.body.candidateIds;

      const user = await t.prisma.user.findUniqueOrThrow({
        where: { id },
        include: { invites: true, assignments: true },
      });
      expect(user).toMatchObject({
        role: 'candidate',
        status: 'invite_pending',
        name: 'Invited One',
      });
      expect(user.accessExpiresAt?.toISOString()).toBe(
        '2099-12-31T23:59:59.999Z',
      );
      expect(user.invites).toHaveLength(1);
      expect(user.invites[0]).toMatchObject({
        status: 'pending',
        batchId: res.body.batchId,
        invitedBy: superId,
      });
      expect(
        user.assignments.map((a) => [a.jobRoleId, a.maxAttempts]).sort(),
      ).toEqual(
        [
          [roles.alpha.id, 3],
          [roles.beta.id, 3],
        ].sort(),
      );
      const batch = await t.prisma.inviteBatch.findUniqueOrThrow({
        where: { id: res.body.batchId },
      });
      expect(batch).toMatchObject({ source: 'csv', sent: 1, skipped: 2 });
      const audit = await t.prisma.auditLog.findFirst({
        where: { actorId: superId, entityId: res.body.batchId },
      });
      expect(audit).toMatchObject({
        action: 'Sent invites',
        itemLabel: `1 invite · ${RUN}.csv`,
      });

      const mail = lastMailTo(emailFor('inv1'));
      expect(mail?.template).toBe('candidate-invite');
      const login = await t
        .http()
        .post('/api/auth/verify')
        .send({ token: tokenFrom(mail) })
        .expect(200);
      expect(login.body).toEqual({ result: 'ok' });
      const cookie = ([] as string[])
        .concat(login.headers['set-cookie'] ?? [])
        .find((c) => c.startsWith('pp_session='))!
        .split(';')[0];
      const me = await t
        .http()
        .get('/api/me')
        .set('Cookie', cookie)
        .expect(200);
      expect(me.body).toMatchObject({ id, role: 'candidate' });
    });

    it('resends: the old link expires and the new one works', async () => {
      const id = await inviteOne('resend');
      const oldToken = tokenFrom(lastMailTo(emailFor('resend')));
      const res = await t
        .http()
        .post('/api/admin/invites/resend')
        .set(asSuper())
        .send({ candidateIds: [id, superId] })
        .expect(200);
      expect(res.body).toEqual({ resent: 1, skipped: 1 });
      const newToken = tokenFrom(lastMailTo(emailFor('resend')));
      expect(newToken).not.toBe(oldToken);
      await t
        .http()
        .post('/api/auth/verify')
        .send({ token: oldToken })
        .expect(200, { result: 'expired' });
      await t
        .http()
        .post('/api/auth/verify')
        .send({ token: newToken })
        .expect(200, { result: 'ok' });
    });

    it('revokes a pending invite', async () => {
      const id = await inviteOne('revoke');
      const token = tokenFrom(lastMailTo(emailFor('revoke')));
      await t
        .http()
        .post(`/api/admin/candidates/${id}/revoke-invite`)
        .set(asSuper())
        .expect(204);
      const user = await t.prisma.user.findUniqueOrThrow({ where: { id } });
      expect(user.status).toBe('revoked');
      await t
        .http()
        .post('/api/auth/verify')
        .send({ token })
        .expect(200, { result: 'expired' });
      await t
        .http()
        .post(`/api/admin/candidates/${id}/revoke-invite`)
        .set(asSuper())
        .expect(400);
      expect(
        await t.prisma.auditLog.count({
          where: {
            actorId: superId,
            action: 'Revoked an invite',
            entityId: id,
          },
        }),
      ).toBe(1);
    });
  });

  describe('candidates', () => {
    it('deactivation signs the candidate out at once; reactivation restores access', async () => {
      const { user, cookie } = await loginAs(t.prisma, {
        email: emailFor('deact'),
      });
      await t.http().get('/api/me').set('Cookie', cookie).expect(200);
      const res = await t
        .http()
        .post('/api/admin/candidates/deactivate')
        .set(asSuper())
        .send({ ids: [user.id] })
        .expect(200);
      expect(res.body).toEqual({ deactivated: 1, skipped: 0 });
      await t.http().get('/api/me').set('Cookie', cookie).expect(401);

      await t
        .http()
        .post('/api/admin/candidates/reactivate')
        .set(asSuper())
        .send({ ids: [user.id] })
        .expect(200, { reactivated: 1 });
      const after = await t.prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(after.status).toBe('active');
    });

    it('updates name and access expiry', async () => {
      const id = await inviteOne('patch');
      await t
        .http()
        .patch(`/api/admin/candidates/${id}`)
        .set(asSuper())
        .send({ name: 'Renamed', accessUntil: null })
        .expect(204);
      const user = await t.prisma.user.findUniqueOrThrow({ where: { id } });
      expect(user).toMatchObject({ name: 'Renamed', accessExpiresAt: null });
      await t
        .http()
        .patch(`/api/admin/candidates/${superId}`)
        .set(asSuper())
        .send({ name: 'Nope' })
        .expect(404);
    });

    it('assigns, limits and removes roles', async () => {
      const id = await inviteOne('assign');
      await t
        .http()
        .post('/api/admin/candidates/assign-roles')
        .set(asSuper())
        .send({ ids: [id], roleIds: [roles.archived.id] })
        .expect(400);
      const added = await t
        .http()
        .post('/api/admin/candidates/assign-roles')
        .set(asSuper())
        .send({ ids: [id], roleIds: [roles.alpha.id, roles.beta.id] })
        .expect(200);
      expect(added.body).toEqual({ added: 1 });
      expect(lastMailTo(emailFor('assign'))).toMatchObject({
        template: 'role-assigned',
        vars: { roleTitle: roles.beta.title },
      });

      await t
        .http()
        .patch(`/api/admin/candidates/${id}/roles/${roles.beta.id}`)
        .set(asSuper())
        .send({ maxSessions: 2 })
        .expect(204);
      await t
        .http()
        .delete(`/api/admin/candidates/${id}/roles/${roles.beta.id}`)
        .set(asSuper())
        .expect(204);
      await t
        .http()
        .delete(`/api/admin/candidates/${id}/roles/${roles.beta.id}`)
        .set(asSuper())
        .expect(404);
      const removed = await t.prisma.roleAssignment.findFirstOrThrow({
        where: { userId: id, jobRoleId: roles.beta.id },
      });
      expect(removed.removedAt).not.toBeNull();

      // Re-assigning restores the removed assignment.
      await t
        .http()
        .post('/api/admin/candidates/assign-roles')
        .set(asSuper())
        .send({ ids: [id], roleIds: [roles.beta.id] })
        .expect(200, { added: 1 });
      const restored = await t.prisma.roleAssignment.findFirstOrThrow({
        where: { userId: id, jobRoleId: roles.beta.id },
      });
      expect(restored).toMatchObject({ removedAt: null, maxAttempts: null });
    });
  });

  it('lists system saved filters and saves the caller’s own', async () => {
    const created = await t
      .http()
      .post('/api/admin/saved-filters')
      .set(asSuper())
      .send({ label: 'Mine', query: { statuses: ['active'] } })
      .expect(201);
    expect(created.body).toMatchObject({
      label: 'Mine',
      query: { statuses: ['active'] },
    });
    const mine = await t
      .http()
      .get('/api/admin/saved-filters')
      .set(asSuper())
      .expect(200);
    const labels = mine.body.map((f: { label: string }) => f.label);
    expect(labels).toContain('All candidates');
    expect(labels).toContain('Mine');
    const theirs = await t
      .http()
      .get('/api/admin/saved-filters')
      .set('Cookie', adminCookie)
      .expect(200);
    expect(theirs.body.map((f: { id: string }) => f.id)).not.toContain(
      created.body.id,
    );
    const system = mine.body.find(
      (f: { label: string }) => f.label === 'All candidates',
    );
    expect(system.adminId).toBeNull();
    expect(
      mine.body.find((f: { id: string }) => f.id === created.body.id).adminId,
    ).toBe(superId);
  });

  it('deletes only the caller’s own saved filter, audited', async () => {
    const created = await t
      .http()
      .post('/api/admin/saved-filters')
      .set(asSuper())
      .send({ label: 'To delete', query: {} })
      .expect(201);
    const system = (
      await t.http().get('/api/admin/saved-filters').set(asSuper()).expect(200)
    ).body.find((f: { adminId: string | null }) => f.adminId === null);

    // Another admin's filter and a system filter are 404; a malformed id is a 400.
    await t
      .http()
      .delete(`/api/admin/saved-filters/${created.body.id}`)
      .set('Cookie', adminCookie)
      .expect(404);
    await t
      .http()
      .delete(`/api/admin/saved-filters/${system.id}`)
      .set(asSuper())
      .expect(404);
    await t
      .http()
      .delete('/api/admin/saved-filters/nope')
      .set(asSuper())
      .expect(400);

    await t
      .http()
      .delete(`/api/admin/saved-filters/${created.body.id}`)
      .set(asSuper())
      .expect(204);
    expect(
      await t.prisma.savedFilter.count({ where: { id: created.body.id } }),
    ).toBe(0);
    expect(
      await t.prisma.auditLog.findFirst({
        where: { actorId: superId, entityId: created.body.id },
        orderBy: { at: 'desc' },
      }),
    ).toMatchObject({
      action: 'Deleted a saved filter',
      entity: 'saved_filter',
      itemLabel: 'To delete',
    });
    await t
      .http()
      .delete(`/api/admin/saved-filters/${created.body.id}`)
      .set(asSuper())
      .expect(404);
    expect(await t.prisma.savedFilter.count({ where: { id: system.id } })).toBe(
      1,
    );
  });

  describe('admins', () => {
    it('invites an admin whose link logs in; a taken email is a 409', async () => {
      const res = await t
        .http()
        .post('/api/admin/admins')
        .set(asSuper())
        .send({ email: emailFor('newadmin'), access: 'admin' })
        .expect(201);
      expect(res.body).toMatchObject({
        email: emailFor('newadmin'),
        access: 'admin',
        status: 'invite_pending',
        name: null,
      });
      const mail = lastMailTo(emailFor('newadmin'));
      expect(mail?.template).toBe('admin-invite');
      await t
        .http()
        .post(`/api/admin/admins/${res.body.id}/resend`)
        .set(asSuper())
        .expect(204);
      await t
        .http()
        .post('/api/auth/verify')
        .send({ token: tokenFrom(lastMailTo(emailFor('newadmin'))) })
        .expect(200, { result: 'ok' });
      const dup = await t
        .http()
        .post('/api/admin/admins')
        .set(asSuper())
        .send({ email: emailFor('newadmin').toUpperCase(), access: 'admin' })
        .expect(409);
      expect(dup.body.error.code).toBe('conflict');
    });

    it('blocks self-demotion and self-removal', async () => {
      const demote = await t
        .http()
        .patch(`/api/admin/admins/${superId}`)
        .set(asSuper())
        .send({ access: 'admin' })
        .expect(400);
      expect(demote.body.error.code).toBe('validation_failed');
      const remove = await t
        .http()
        .delete(`/api/admin/admins/${superId}`)
        .set(asSuper())
        .expect(400);
      expect(remove.body.error.message).toBe('You can’t remove yourself');
    });

    it('promotes, demotes and removes another admin, signing them out', async () => {
      const other = await loginAs(t.prisma, {
        email: emailFor('other'),
        role: 'admin',
      });
      const up = await t
        .http()
        .patch(`/api/admin/admins/${other.user.id}`)
        .set(asSuper())
        .send({ access: 'super_admin' })
        .expect(200);
      expect(up.body.access).toBe('super_admin');
      await t
        .http()
        .patch(`/api/admin/admins/${other.user.id}`)
        .set(asSuper())
        .send({ access: 'admin' })
        .expect(200);
      await t
        .http()
        .get('/api/admin/admins')
        .set('Cookie', other.cookie)
        .expect(200);
      await t
        .http()
        .delete(`/api/admin/admins/${other.user.id}`)
        .set(asSuper())
        .expect(204);
      await t
        .http()
        .get('/api/admin/admins')
        .set('Cookie', other.cookie)
        .expect(401);
      expect(
        await t.prisma.auditLog.count({
          where: { actorId: superId, entityId: other.user.id },
        }),
      ).toBe(3);
    });

    it('is a 404 for a non-admin target', async () => {
      const { user } = await loginAs(t.prisma, { email: emailFor('cand1') });
      await t
        .http()
        .patch(`/api/admin/admins/${user.id}`)
        .set(asSuper())
        .send({ access: 'admin' })
        .expect(404);
    });
  });
});
