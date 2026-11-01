import { ADMIN_SESSION_COOKIE } from '../src/common/auth/session-cookie.js';
import { AppConfig } from '../src/config/app-config.js';
import {
  cleanupUsers,
  createTestApp,
  loginAs,
  runId,
  type TestApp,
} from './helpers/e2e.js';

const RUN = runId('executive-security');
const ROUTES = ['', '/candidates', '/insights'] as const;
const asAdminCookie = (cookie: string) =>
  cookie.replace(/^pp_session=/, `${ADMIN_SESSION_COOKIE}=`);

describe('Executive reports admin-only security boundary', () => {
  let t: TestApp;
  let admin: string;
  let superAdmin: string;
  let candidate: string;
  let dual: string;
  let removedAccess: string;
  let adminOrigin: string;
  const denied: { label: string; cookie: string; status: number }[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    adminOrigin = t.app.get(AppConfig).env.APP_ADMIN_ORIGIN;
    const account = (
      label: string,
      extra: Parameters<typeof loginAs>[1] = { email: '' },
    ) => loginAs(t.prisma, { ...extra, email: `${RUN}-${label}@example.test` });
    admin = (await account('admin', { email: '', role: 'admin' })).cookie;
    superAdmin = (await account('super', { email: '', role: 'super_admin' }))
      .cookie;
    candidate = (await account('candidate')).cookie;
    dual = (
      await account('dual', {
        email: '',
        role: 'candidate',
        adminRole: 'admin',
      })
    ).cookie;
    const demoted = await account('demoted', {
      email: '',
      role: 'candidate',
      adminRole: 'admin',
    });
    removedAccess = demoted.cookie;
    // Existing sessions must not retain access after a database role change.
    await t.prisma.user.update({
      where: { id: demoted.user.id },
      data: { adminRole: null },
    });
    for (const label of ['expired', 'revoked'] as const) {
      const session = await account(label, { email: '', role: 'admin' });
      await t.prisma.authSession.updateMany({
        where: { userId: session.user.id },
        data:
          label === 'expired'
            ? { expiresAt: new Date(Date.now() - 1000) }
            : { revokedAt: new Date() },
      });
      denied.push({ label, cookie: session.cookie, status: 401 });
    }
    for (const status of [
      'deactivated',
      'revoked',
      'invite_pending',
    ] as const) {
      const row = await account(`status-${status}`, {
        email: '',
        role: 'admin',
        status,
      });
      denied.push({ label: status, cookie: row.cookie, status: 401 });
    }
    const erased = await account('erased', {
      email: '',
      role: 'admin',
      deletedAt: new Date(),
    });
    denied.push({ label: 'erased', cookie: erased.cookie, status: 401 });
    const expiredAccess = await account('access-expired', {
      email: '',
      role: 'admin',
      accessExpiresAt: new Date(Date.now() - 1000),
    });
    denied.push({
      label: 'access-expired',
      cookie: expiredAccess.cookie,
      status: 403,
    });
  });
  afterAll(async () => {
    if (t) {
      await cleanupUsers(t.prisma, RUN);
      await t.close();
    }
  });
  const request = (suffix: string) =>
    t.http().get(`/api/admin/reports/executive${suffix}`);
  function noReport(body: Record<string, unknown>) {
    expect(Object.keys(body)).toEqual(['error']);
    expect(body).not.toHaveProperty('meta');
    expect(body).not.toHaveProperty('recruiterResults');
    expect(body).not.toHaveProperty('candidates');
    expect(body).not.toHaveProperty('funnel');
  }

  it.each(ROUTES)(
    'rejects anonymous and invalid-cookie requests to %s',
    async (suffix) => {
      const anonymous = await request(suffix).expect(401);
      noReport(anonymous.body);
      const invalid = await request(suffix)
        .set('Cookie', `${ADMIN_SESSION_COOKIE}=invalid-token`)
        .set('X-PrepPilot-App', 'admin')
        .expect(401);
      noReport(invalid.body);
    },
  );
  it.each(ROUTES)(
    'denies candidates even when they forge app headers or cookie names on %s',
    async (suffix) => {
      noReport(
        (await request(suffix).set('Cookie', candidate).expect(404)).body,
      );
      for (const headers of [
        { 'X-PrepPilot-App': 'admin' },
        { Origin: adminOrigin },
        { Referer: `${adminOrigin}/executive` },
      ]) {
        const response = await request(suffix)
          .set(headers)
          .set('Cookie', asAdminCookie(candidate))
          .expect(404);
        noReport(response.body);
      }
      // Role/query spoofing must not reach validation or expose whether a requested role exists.
      const forged = await request(suffix)
        .set('Cookie', candidate)
        .query({
          role: 'super_admin',
          roleId: "' OR 1=1--",
          recruiterId: 'unknown',
        })
        .expect(404);
      noReport(forged.body);
    },
  );
  it.each(ROUTES)(
    'rejects invalidated admin sessions and accounts on %s',
    async (suffix) => {
      for (const row of denied) {
        const response = await request(suffix)
          .set('Cookie', row.cookie)
          .expect(row.status);
        noReport(response.body);
      }
      const demoted = await request(suffix)
        .set('X-PrepPilot-App', 'admin')
        .set('Cookie', asAdminCookie(removedAccess))
        .expect(404);
      noReport(demoted.body);
    },
  );
  it.each(ROUTES)(
    'allows genuine admins, super admins and database-granted dual admins on %s without caching',
    async (suffix) => {
      for (const cookie of [admin, superAdmin, dual]) {
        const response = await request(suffix)
          .set('X-PrepPilot-App', 'admin')
          .set('Cookie', asAdminCookie(cookie))
          .expect(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).toHaveProperty('meta');
      }
      // A dual-access candidate still has no admin role in the candidate-app context.
      noReport((await request(suffix).set('Cookie', dual).expect(404)).body);
    },
  );
  it('validates authenticated query inputs and bounds personal-data pages', async () => {
    for (const suffix of ROUTES) {
      await request(suffix)
        .set('Cookie', admin)
        .query({ roleId: "' OR 1=1--" })
        .expect(400);
    }
    await request('/candidates')
      .set('Cookie', admin)
      .query({ pageSize: 101 })
      .expect(400);
    await request('/candidates')
      .set('Cookie', admin)
      .query({ search: 'x'.repeat(201) })
      .expect(400);
  });
});
