import { randomToken } from '../src/common/crypto.js';
import { ADMIN_SESSION_COOKIE } from '../src/common/auth/session-cookie.js';
import { DEFAULT_ROLE_SETTINGS } from '../src/modules/interview/types.js';
import { ExecutiveService } from '../src/modules/reports/executive.service.js';
import {
  cleanupUsers,
  createTestApp,
  loginAs,
  runId,
  type TestApp,
} from './helpers/e2e.js';

const RUN = runId('executive');
const old = new Date('2024-01-01T00:00:00Z');
const day = 864e5;

describe('Executive dashboard APIs (FR-REP-01, FR-REP-03)', () => {
  let t: TestApp;
  let adminId: string;
  let zeroId: string;
  let dualId: string;
  let cookie: string;
  let dualCookie: string;
  let candidateCookie: string;
  let roleA: string;
  let roleB: string;
  let multiId: string;
  let singleId: string;
  let cohortStart: Date;
  let reportMonth: string;
  const email = (x: string) => `${RUN}-${x}@example.test`;
  const when = (offset: number) =>
    new Date(cohortStart.getTime() + offset * day);

  async function invite(
    userId: string,
    invitedBy: string | null,
    sentAt = when(0),
  ) {
    const user = await t.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    return t.prisma.invite.create({
      data: {
        userId,
        email: user.email,
        invitedBy,
        tokenHash: randomToken(),
        sentAt,
        expiresAt: new Date(sentAt.getTime() + 30 * day),
      },
    });
  }
  async function candidate(
    label: string,
    inviter: string | null,
    roles: string[],
    erased = false,
  ) {
    const u = await t.prisma.user.create({
      data: {
        name: label,
        email: email(label),
        role: 'candidate',
        status: 'active',
        firstLoginAt: when(1),
        createdAt: old,
        deletedAt: erased ? when(2) : null,
      },
    });
    await t.prisma.invite.create({
      data: {
        userId: u.id,
        email: u.email,
        invitedBy: inviter,
        tokenHash: randomToken(),
        sentAt: when(0),
        expiresAt: when(30),
      },
    });
    for (const jobRoleId of roles)
      await t.prisma.roleAssignment.create({
        data: {
          userId: u.id,
          jobRoleId,
          assignedAt: when(0),
          assignedBy: inviter,
        },
      });
    return u.id;
  }
  async function session(
    userId: string,
    jobRoleId: string,
    number: number,
    score: number,
    extra: { preview?: boolean; date?: Date } = {},
  ) {
    return t.prisma.session.create({
      data: {
        userId,
        jobRoleId,
        number,
        mode: 'typed',
        status: 'completed',
        score,
        band:
          score >= 85
            ? 'interview_ready'
            : score >= 70
              ? 'nearly_ready'
              : score >= 50
                ? 'developing'
                : 'not_ready',
        isPreview: extra.preview ?? false,
        startedAt: extra.date ?? when(number + 1),
        completedAt: extra.date ?? when(number + 1),
        weightsSnapshot: {},
        promptVersions: {},
      },
    });
  }
  beforeAll(async () => {
    t = await createTestApp();
    const now = new Date();
    reportMonth = now.toISOString().slice(0, 7);
    cohortStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    );
    const admin = await loginAs(t.prisma, {
      email: email('admin'),
      role: 'admin',
      createdAt: old,
    });
    adminId = admin.user.id;
    cookie = admin.cookie;
    zeroId = (
      await loginAs(t.prisma, {
        email: email('zero'),
        role: 'super_admin',
        createdAt: old,
      })
    ).user.id;
    const dual = await loginAs(t.prisma, {
      email: email('dual'),
      role: 'candidate',
      adminRole: 'admin',
      createdAt: old,
    });
    dualId = dual.user.id;
    dualCookie = dual.cookie.replace('pp_session=', `${ADMIN_SESSION_COOKIE}=`);
    candidateCookie = (await loginAs(t.prisma, { email: email('login-only') }))
      .cookie;
    for (const key of ['A', 'B']) {
      const role = await t.prisma.jobRole.create({
        data: {
          title: `${RUN}-${key}`,
          slug: `${RUN}-${key.toLowerCase()}`,
          seniority: 'mid',
          keySkills: [],
          status: 'approved',
          settings: DEFAULT_ROLE_SETTINGS,
          createdAt: old,
        },
      });
      if (key === 'A') roleA = role.id;
      else roleB = role.id;
    }
    multiId = await candidate('Alpha-multi', adminId, [roleA, roleB]);
    await invite(multiId, dualId, when(5)); // Resend must not change inviter or people count.
    await session(multiId, roleA, 1, 40);
    await session(multiId, roleA, 2, 60);
    await session(multiId, roleB, 1, 80);
    await session(multiId, roleB, 2, 70);
    await session(multiId, roleA, 3, 100, { preview: true });
    await session(multiId, roleA, 4, 0, {
      date: new Date(now.getTime() + day),
    });
    singleId = await candidate('Beta-single', adminId, [roleA]);
    await session(singleId, roleA, 1, 55);
    const unknown = await candidate('Gamma-unknown', null, [roleA]);
    await session(unknown, roleA, 1, 40);
    await session(unknown, roleA, 2, 40);
    const preview = await candidate('Delta-preview', adminId, [roleA]);
    await session(preview, roleA, 1, 100, { preview: true });
    const erased = await candidate('Erased', adminId, [roleA], true);
    await session(erased, roleA, 1, 99);
    const older = await candidate('Older-resend', adminId, [roleA]);
    await invite(older, adminId, new Date(cohortStart.getTime() - day));
    // Admin invitations never enter candidate cohorts.
    await invite(zeroId, adminId);
  });
  afterAll(async () => {
    if (t) {
      await cleanupUsers(t.prisma, RUN);
      await t.prisma.jobRole.deleteMany({
        where: { slug: { startsWith: RUN } },
      });
      await t.close();
    }
  });
  const get = (path = '', params: object = {}) =>
    t
      .http()
      .get(`/api/admin/reports/executive${path}`)
      .set('Cookie', cookie)
      .query({ period: reportMonth, roleId: roleA, ...params });

  it('requires admin access and validates all query filters', async () => {
    await t.http().get('/api/admin/reports/executive').expect(401);
    await t
      .http()
      .get('/api/admin/reports/executive')
      .set('Cookie', candidateCookie)
      .expect(404);
    await get('', { period: '2026-13' }).expect(400);
    await get('', { period: '9999-01' }).expect(400);
    await get('/candidates', { pageSize: '101' }).expect(400);
    await get('/candidates', { recruiterId: 'oops' }).expect(400);
  });
  it('counts unique invites but scores role pairs, preserves original inviter and zero/dual admins', async () => {
    const res = await get().expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const row = res.body.recruiterResults.recruiters.find(
      (r: { id: string }) => r.id === adminId,
    );
    expect(row).toMatchObject({
      invited: 3,
      assignmentPairs: 3,
      paired: 1,
      first: 40,
      latest: 60,
      gain: 20,
      singleSession: 1,
      unassessed: 1,
    });
    expect(row.acceptance).toMatchObject({ num: 3, den: 3, value: 1 });
    expect(
      res.body.recruiterResults.recruiters.find(
        (r: { id: string }) => r.id === zeroId,
      ),
    ).toMatchObject({ invited: 0, paired: 0, gain: null });
    expect(
      res.body.options.recruiters.some((r: { id: string }) => r.id === dualId),
    ).toBe(true);
    expect(res.body.recruiterResults.team).toMatchObject({
      invited: 4,
      paired: 2,
      gain: 10,
    });
    const all = await get('', { roleId: undefined }).expect(200);
    expect(
      all.body.recruiterResults.recruiters.find(
        (r: { id: string }) => r.id === adminId,
      ),
    ).toMatchObject({ invited: 3, assignmentPairs: 4, paired: 2, gain: 5 });
  });
  it('returns reconciled paired summaries and stable server pages; search only narrows detail', async () => {
    const res = await get('/candidates', { pageSize: 1 }).expect(200);
    expect(res.body.total).toBe(4);
    expect(res.body.candidates).toHaveLength(1);
    expect(res.body.summary).toMatchObject({
      paired: 2,
      first: 40,
      latest: 50,
      gain: 10,
      improved: 1,
      unchanged: 1,
      declined: 0,
    });
    const next = await get('/candidates', { pageSize: 1, page: 2 }).expect(200);
    expect(next.body.candidates[0].id).not.toBe(res.body.candidates[0].id);
    const single = await get('/candidates', { search: 'Beta-single' }).expect(
      200,
    );
    expect(single.body.total).toBe(1);
    expect(single.body.candidates[0]).toMatchObject({
      candidateId: singleId,
      sessions: 1,
      firstScore: 55,
      latestScore: null,
    });
    expect(single.body.summary).toEqual(res.body.summary);
    const missing = await get('/candidates', { page: 999 }).expect(200);
    expect(missing.body.total).toBe(4);
    expect(missing.body.candidates).toEqual([]);
    const unknown = await get('/candidates', { recruiterId: 'unknown' }).expect(
      200,
    );
    expect(unknown.body.summary).toMatchObject({
      invited: 1,
      paired: 1,
      gain: 0,
    });
    const pairB = await get('/candidates', {
      roleId: roleB,
      recruiterId: adminId,
    }).expect(200);
    expect(pairB.body.candidates[0].candidateId).toBe(multiId);
    expect(pairB.body.summary).toMatchObject({
      invited: 1,
      paired: 1,
      gain: -10,
    });
  });
  it('allows dual-access admins when acting in the admin app', async () => {
    await t
      .http()
      .get('/api/admin/reports/executive')
      .set('Cookie', dualCookie)
      .set('x-preppilot-app', 'admin')
      .query({ period: reportMonth, roleId: roleA })
      .expect(200);
  });
  it('keeps historical cutoff completions and immature acceptance windows out', async () => {
    const service = t.app.get(ExecutiveService);
    const cutoff = new Date(cohortStart.getTime() + 32 * day);
    // The current cohort fixture is not dependent on today's day; directly verify a historic period.
    const historicMonth = new Date(
      Date.UTC(cohortStart.getUTCFullYear(), cohortStart.getUTCMonth(), 1),
    )
      .toISOString()
      .slice(0, 7);
    const report = await service.overview(
      { period: historicMonth, roleId: roleA },
      cutoff,
    );
    expect(report.recruiterResults.team.invited).toBe(1); // Older-resend's globally earliest invite is in the previous month.
    expect(report.meta.cutoff).toBe(
      new Date(
        Date.UTC(
          cohortStart.getUTCFullYear(),
          cohortStart.getUTCMonth() + 1,
          1,
        ),
      ).toISOString(),
    );
  });
  it('separates unclosed acceptance windows and excludes sign-ins before invitation', async () => {
    const late = await candidate('Late-window', adminId, [roleA]);
    const lateSent = new Date(
      Date.UTC(cohortStart.getUTCFullYear(), cohortStart.getUTCMonth() + 1, 0),
    );
    await t.prisma.invite.updateMany({
      where: { userId: late },
      data: { sentAt: lateSent },
    });
    await t.prisma.user.update({
      where: { id: late },
      data: { firstLoginAt: new Date(lateSent.getTime() + day) },
    });
    const invalid = await candidate('Pre-invite-login', adminId, [roleA]);
    await t.prisma.user.update({
      where: { id: invalid },
      data: { firstLoginAt: new Date(cohortStart.getTime() - day) },
    });
    const cutoff = new Date(
      Date.UTC(cohortStart.getUTCFullYear(), cohortStart.getUTCMonth() + 1, 3),
    );
    const report = await t.app
      .get(ExecutiveService)
      .overview({ period: reportMonth, roleId: roleA }, cutoff);
    expect(report.recruiterResults.team).toMatchObject({
      invited: 6,
      awaitingAcceptanceWindow: 1,
      acceptance: { num: 4, den: 5, value: 0.8 },
    });
  });
});
