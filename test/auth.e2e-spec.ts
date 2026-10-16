import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { randomToken, sha256Hex } from '../src/common/crypto.js';
import { RateLimiter } from '../src/common/rate-limit/rate-limiter.js';
import { EmailService } from '../src/jobs/email/email.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

// Login flows (plan §11): fake providers, console mail, real Postgres from .env.
const RUN = `e2e-auth-${Date.now().toString(36)}`;
const emailFor = (label: string) => `${RUN}-${label}@example.test`;

describe('Auth (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const sent: { template: string; to: string; vars: { code?: string } }[] = [];

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    process.env.LOG_PRETTY = 'false';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EmailService)
      .useValue({
        send: async (job: (typeof sent)[number]) => void sent.push(job),
      })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    // On Redis the per-IP OTP window outlives the process; earlier runs from this loopback
    // address would otherwise rate-limit this one.
    await app.get(RateLimiter).reset('otp:ip:127.0.0.1');
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.unfiltered.user.deleteMany({
        where: { email: { startsWith: RUN } },
      });
      await prisma.unfiltered.authCode.deleteMany({
        where: { email: { startsWith: RUN } },
      });
    }
    await app?.close();
  });

  const http = () => request(app.getHttpServer());

  const createUser = (label: string, data: Record<string, unknown> = {}) =>
    prisma.user.create({
      data: {
        email: emailFor(label),
        role: 'candidate',
        status: 'invite_pending',
        ...data,
      },
    });

  const lastCodeFor = (email: string) =>
    [...sent].reverse().find((m) => m.to === email)?.vars.code;

  async function requestCode(email: string) {
    return http().post('/api/auth/code').send({ email }).expect(200);
  }

  async function login(email: string): Promise<string> {
    await requestCode(email);
    const code = lastCodeFor(email);
    const res = await http()
      .post('/api/auth/verify')
      .send({ email, code })
      .expect(200);
    expect(res.body).toEqual({ result: 'ok' });
    const cookie = ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('pp_session='));
    expect(cookie).toBeDefined();
    return cookie!.split(';')[0];
  }

  it('GET /api/health is public', async () => {
    const res = await http().get('/api/health').expect(200);
    // `redis` is 'disabled' in the in-memory e2e run and 'ok' when REDIS_URL is set.
    expect(res.body).toEqual({
      status: 'ok',
      db: 'ok',
      redis: expect.stringMatching(/^(disabled|ok)$/),
    });
  });

  it('an invited user logs in, becomes active and sees /me', async () => {
    const user = await createUser('invited', { name: 'Priya Shah' });
    await prisma.invite.create({
      data: {
        email: user.email,
        userId: user.id,
        tokenHash: sha256Hex(randomToken()),
        sentAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    expect((await requestCode(` ${user.email.toUpperCase()} `)).body).toEqual({
      result: 'sent',
    });
    const code = lastCodeFor(user.email);
    expect(code).toMatch(/^\d{6}$/);

    const wrong = code === '000000' ? '111111' : '000000';
    await http()
      .post('/api/auth/verify')
      .send({ email: user.email, code: wrong })
      .expect(200, { result: 'wrong' });

    const res = await http()
      .post('/api/auth/verify')
      .send({ email: user.email, code })
      .expect(200, { result: 'ok' });
    const setCookie = ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .join(';');
    expect(setCookie).toMatch(/pp_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    const cookie = setCookie.split(';')[0];

    const me = await http().get('/api/me').set('Cookie', cookie).expect(200);
    expect(me.body).toEqual({
      id: user.id,
      email: user.email,
      name: 'Priya Shah',
      initials: 'PS',
      role: 'candidate',
      accessExpiresAt: null,
      audioRetentionDays: expect.any(Number),
      candidatesCanDeleteData: expect.any(Boolean),
    });

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { invites: true },
    });
    expect(after.status).toBe('active');
    expect(after.firstLoginAt).not.toBeNull();
    expect(after.invites.map((i) => i.status)).toEqual(['accepted']);
    const activity = await prisma.activityEvent.findMany({
      where: { userId: user.id },
    });
    expect(activity.map((a) => a.text)).toEqual(['First login']);

    // Single use.
    await http()
      .post('/api/auth/verify')
      .send({ email: user.email, code })
      .expect(200, { result: 'expired' });
  });

  it('an uninvited email gets the same response and no code', async () => {
    const email = emailFor('stranger');
    expect((await requestCode(email)).body).toEqual({ result: 'sent' });
    expect(lastCodeFor(email)).toBeUndefined();
    expect(await prisma.authCode.count({ where: { email } })).toBe(0);
  });

  it('a deactivated user gets sent but no code, and cannot verify', async () => {
    const user = await createUser('deactivated', { status: 'deactivated' });
    expect((await requestCode(user.email)).body).toEqual({ result: 'sent' });
    expect(lastCodeFor(user.email)).toBeUndefined();
    await http()
      .post('/api/auth/verify')
      .send({ email: user.email, code: '123456' })
      .expect(200, { result: 'expired' });
  });

  it('hides erased users from reads (erasure stage 1)', async () => {
    const user = await createUser('erased', {
      status: 'active',
      deletedAt: new Date(),
    });
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
    expect(await prisma.user.count({ where: { email: user.email } })).toBe(0);
    expect(
      await prisma.unfiltered.user.findUnique({ where: { id: user.id } }),
    ).not.toBeNull();
    expect((await requestCode(user.email)).body).toEqual({ result: 'sent' });
    expect(lastCodeFor(user.email)).toBeUndefined();
  });

  it('enforces the resend cooldown', async () => {
    const user = await createUser('cooldown');
    await requestCode(user.email);
    const res = await requestCode(user.email);
    expect(res.body.result).toBe('rate-limited');
    expect(res.body.retryAfterSec).toBeGreaterThan(0);
  });

  it('a code expires after its TTL', async () => {
    const user = await createUser('ttl');
    await requestCode(user.email);
    await prisma.authCode.updateMany({
      where: { email: user.email },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await http()
      .post('/api/auth/verify')
      .send({ email: user.email, code: lastCodeFor(user.email) })
      .expect(200, { result: 'expired' });
  });

  it('5 wrong tries burn the code', async () => {
    const user = await createUser('tries');
    await requestCode(user.email);
    const code = lastCodeFor(user.email)!;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) {
      await http()
        .post('/api/auth/verify')
        .send({ email: user.email, code: wrong })
        .expect(200, { result: 'wrong' });
    }
    await http()
      .post('/api/auth/verify')
      .send({ email: user.email, code: wrong })
      .expect(200, { result: 'expired' });
    await http()
      .post('/api/auth/verify')
      .send({ email: user.email, code })
      .expect(200, { result: 'expired' });
  });

  it('validates bodies', async () => {
    const res = await http()
      .post('/api/auth/code')
      .send({ email: 'not-an-email' })
      .expect(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('an invite magic-link token logs in once', async () => {
    const user = await createUser('token');
    const token = randomToken();
    await prisma.invite.create({
      data: {
        email: user.email,
        userId: user.id,
        tokenHash: sha256Hex(token),
        sentAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await http()
      .post('/api/auth/verify')
      .send({ token })
      .expect(200, { result: 'ok' });
    await http()
      .post('/api/auth/verify')
      .send({ token })
      .expect(200, { result: 'expired' });
  });

  it('rejects unauthenticated requests and cross-site posts', async () => {
    const res = await http().get('/api/me').expect(401);
    expect(res.body).toEqual({
      error: { code: 'unauthenticated', message: expect.any(String) },
    });
    const csrf = await http()
      .post('/api/auth/code')
      .set('Origin', 'https://evil.example')
      .send({ email: emailFor('csrf') })
      .expect(403);
    expect(csrf.body.error.code).toBe('forbidden');
  });

  it('hides /admin/me from candidates and serves it to admins', async () => {
    const candidate = await createUser('cand-admin-check', {
      status: 'active',
    });
    const candidateCookie = await login(candidate.email);
    const hidden = await http()
      .get('/api/admin/me')
      .set('Cookie', candidateCookie)
      .expect(404);
    expect(hidden.body.error.code).toBe('not_found');

    const admin = await createUser('admin', {
      role: 'admin',
      status: 'active',
      name: 'Arjun Mehta',
      title: 'Recruiter',
    });
    const adminCookie = await login(admin.email);
    const me = await http()
      .get('/api/admin/me')
      .set('Cookie', adminCookie)
      .expect(200);
    expect(me.body).toMatchObject({
      id: admin.id,
      name: 'Arjun Mehta',
      email: admin.email,
      title: 'Recruiter',
      access: 'admin',
      status: 'active',
    });
  });

  it('logout, deactivation and access expiry end the session', async () => {
    const a = await createUser('logout', { status: 'active' });
    const cookieA = await login(a.email);
    await http().post('/api/auth/logout').set('Cookie', cookieA).expect(204);
    await http().get('/api/me').set('Cookie', cookieA).expect(401);

    const b = await createUser('deact', { status: 'active' });
    const cookieB = await login(b.email);
    await prisma.user.update({
      where: { id: b.id },
      data: { status: 'deactivated' },
    });
    await http().get('/api/me').set('Cookie', cookieB).expect(401);

    const c = await createUser('lapsed', {
      status: 'active',
      accessExpiresAt: new Date(Date.now() + 60_000),
    });
    const cookieC = await login(c.email);
    await prisma.user.update({
      where: { id: c.id },
      data: { accessExpiresAt: new Date(Date.now() - 1000) },
    });
    const res = await http().get('/api/me').set('Cookie', cookieC).expect(403);
    expect(res.body.error.code).toBe('access_expired');
  });
});
