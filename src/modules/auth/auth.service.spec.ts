import { Logger } from '@nestjs/common';
import { hmacHex, sha256Hex } from '../../common/crypto.js';
import type { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import type { AppConfig } from '../../config/app-config.js';
import type { EmailService } from '../../jobs/email/email.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { ActivityService } from '../activity/activity.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import { AuthService } from './auth.service.js';

const SECRET = 'x'.repeat(32);
const NOW = new Date('2026-10-15T12:00:00Z');
const MIN = 60_000;
const EMAIL = 'priya@acme.com';
const env = {
  AUTH_SECRET: SECRET,
  OTP_TTL_MIN: 10,
  OTP_MAX_TRIES: 5,
  OTP_REQUESTS_PER_HOUR: 5,
  OTP_IP_REQUESTS_PER_HOUR: 20,
  OTP_RESEND_COOLDOWN_SEC: 30,
  SESSION_TTL_DAYS: 7,
};

const user = (over: object = {}) => ({
  id: 'u1',
  email: EMAIL,
  name: 'Priya Shah',
  title: null,
  role: 'candidate',
  status: 'invite_pending',
  accessExpiresAt: null,
  firstLoginAt: null,
  lastActiveAt: null,
  deletedAt: null,
  ...over,
});

const codeRow = (code: string, over: object = {}) => ({
  id: 'c1',
  email: EMAIL,
  codeHash: hmacHex(SECRET, `${EMAIL}:${code}`),
  expiresAt: new Date(NOW.getTime() + 10 * MIN),
  tries: 0,
  usedAt: null,
  ...over,
});

function setup(envOver: object = {}) {
  const tx = {
    authCode: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    invite: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    user: { update: vi.fn() },
    authSession: { create: vi.fn() },
  };
  const prisma = {
    user: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    authCode: {
      deleteMany: vi.fn().mockReturnValue('delete'),
      create: vi.fn().mockReturnValue('create'),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    invite: { findUnique: vi.fn() },
    authSession: { updateMany: vi.fn() },
    $transaction: vi.fn((arg: unknown) =>
      typeof arg === 'function' ? arg(tx) : Promise.resolve([]),
    ),
  };
  const rateLimiter = {
    consume: vi.fn().mockResolvedValue({ allowed: true, retryAfterSec: 0 }),
  };
  const email = { send: vi.fn() };
  const activity = { record: vi.fn() };
  const settings = {
    get: vi
      .fn()
      .mockResolvedValue({
        audioRetentionDays: 30,
        candidatesCanDeleteData: true,
      }),
  };
  const service = new AuthService(
    prisma as unknown as PrismaService,
    { env: { ...env, ...envOver } } as unknown as AppConfig,
    rateLimiter as unknown as RateLimiter,
    email as unknown as EmailService,
    activity as unknown as ActivityService,
    settings as unknown as SettingsService,
  );
  return { service, prisma, tx, rateLimiter, email, activity, settings };
}

describe('AuthService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('requestCode', () => {
    it('creates a hashed code and emails it to an invited user', async () => {
      const { service, prisma, email } = setup();
      prisma.user.findUnique.mockResolvedValue(user());
      await expect(service.requestCode(EMAIL, '1.2.3.4')).resolves.toEqual({
        result: 'sent',
      });

      expect(prisma.authCode.deleteMany).toHaveBeenCalledWith({
        where: { email: EMAIL, usedAt: null },
      });
      const { data } = prisma.authCode.create.mock.calls[0][0];
      expect(data.expiresAt).toEqual(new Date(NOW.getTime() + 10 * MIN));
      const sent = email.send.mock.calls[0][0];
      expect(sent).toMatchObject({
        template: 'login-code',
        to: EMAIL,
        vars: { minutes: 10 },
      });
      expect(sent.vars.code).toMatch(/^\d{6}$/);
      expect(data.codeHash).toBe(hmacHex(SECRET, `${EMAIL}:${sent.vars.code}`));
      expect(data.codeHash).not.toContain(sent.vars.code);
    });

    it.each([
      ['unknown', null],
      ['deactivated', user({ status: 'deactivated' })],
      ['revoked', user({ status: 'revoked' })],
      ['erased', user({ deletedAt: NOW })],
      ['access expired', user({ status: 'active', accessExpiresAt: NOW })],
    ])(
      'returns the same response for an %s email, without a code or email',
      async (_label, found) => {
        const { service, prisma, email } = setup();
        prisma.user.findUnique.mockResolvedValue(found);
        await expect(service.requestCode(EMAIL, '1.2.3.4')).resolves.toEqual({
          result: 'sent',
        });
        expect(prisma.authCode.create).not.toHaveBeenCalled();
        expect(email.send).not.toHaveBeenCalled();
      },
    );

    it('applies IP, email and cooldown limits with hashed email keys', async () => {
      const { service, prisma, rateLimiter } = setup();
      prisma.user.findUnique.mockResolvedValue(null);
      await service.requestCode(EMAIL, '1.2.3.4');
      const h = sha256Hex(EMAIL);
      expect(rateLimiter.consume.mock.calls).toEqual([
        ['otp:ip:1.2.3.4', 20, 3600],
        [`otp:email:${h}`, 5, 3600],
        [`otp:cooldown:${h}`, 1, 30],
      ]);
    });

    it('returns rate-limited with retryAfterSec and does nothing else', async () => {
      const { service, prisma, rateLimiter } = setup();
      rateLimiter.consume
        .mockResolvedValueOnce({ allowed: true, retryAfterSec: 0 })
        .mockResolvedValueOnce({ allowed: false, retryAfterSec: 1800 });
      await expect(service.requestCode(EMAIL, '1.2.3.4')).resolves.toEqual({
        result: 'rate-limited',
        retryAfterSec: 1800,
      });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('still answers sent if enqueueing the email fails', async () => {
      const { service, prisma, email } = setup();
      prisma.user.findUnique.mockResolvedValue(user());
      email.send.mockRejectedValue(new Error('queue down'));
      await expect(service.requestCode(EMAIL, '1.2.3.4')).resolves.toEqual({
        result: 'sent',
      });
    });
  });

  describe('verify with a code', () => {
    it('logs in: consumes the code, activates the user, accepts invites, creates a session', async () => {
      const { service, prisma, tx, activity } = setup();
      prisma.authCode.findFirst.mockResolvedValue(codeRow('123456'));
      prisma.user.findUnique.mockResolvedValue(user());

      const out = await service.verify({ email: EMAIL, code: '123456' });
      expect(out.result).toBe('ok');
      if (out.result !== 'ok') return;
      expect(out.maxAgeMs).toBe(7 * 24 * 60 * MIN);

      expect(prisma.authCode.findFirst).toHaveBeenCalledWith({
        where: { email: EMAIL, usedAt: null, expiresAt: { gt: NOW } },
        orderBy: { createdAt: 'desc' },
      });
      expect(tx.authCode.updateMany).toHaveBeenCalledWith({
        where: { id: 'c1', usedAt: null },
        data: { usedAt: NOW },
      });
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { status: 'active', firstLoginAt: NOW, lastActiveAt: NOW },
      });
      expect(tx.invite.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', status: 'pending' },
        data: { status: 'accepted' },
      });
      const session = tx.authSession.create.mock.calls[0][0].data;
      expect(session).toEqual({
        userId: 'u1',
        tokenHash: sha256Hex(out.sessionToken),
        lastSeenAt: NOW,
        expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * MIN),
      });
      expect(activity.record).toHaveBeenCalledWith('u1', 'First login', NOW);
    });

    it('does not record "First login" again', async () => {
      const { service, prisma, tx, activity } = setup();
      const first = new Date('2026-01-01T00:00:00Z');
      prisma.authCode.findFirst.mockResolvedValue(codeRow('123456'));
      prisma.user.findUnique.mockResolvedValue(
        user({ status: 'active', firstLoginAt: first }),
      );
      await expect(
        service.verify({ email: EMAIL, code: '123456' }),
      ).resolves.toMatchObject({ result: 'ok' });
      expect(tx.user.update.mock.calls[0][0].data.firstLoginAt).toBe(first);
      expect(activity.record).not.toHaveBeenCalled();
    });

    it('returns expired when there is no live code (none, used, or past its TTL)', async () => {
      const { service, prisma } = setup();
      prisma.authCode.findFirst.mockResolvedValue(null);
      await expect(
        service.verify({ email: EMAIL, code: '123456' }),
      ).resolves.toEqual({ result: 'expired' });
    });

    it('counts a wrong code and returns wrong', async () => {
      const { service, prisma } = setup();
      prisma.authCode.findFirst.mockResolvedValue(codeRow('123456'));
      prisma.authCode.update.mockResolvedValue({ tries: 1 });
      await expect(
        service.verify({ email: EMAIL, code: '654321' }),
      ).resolves.toEqual({ result: 'wrong' });
      expect(prisma.authCode.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { tries: { increment: 1 } },
        select: { tries: true },
      });
      expect(prisma.authCode.update).toHaveBeenCalledTimes(1);
    });

    it('burns the code on the 5th wrong try and returns expired', async () => {
      const { service, prisma } = setup();
      prisma.authCode.findFirst.mockResolvedValue(
        codeRow('123456', { tries: 4 }),
      );
      prisma.authCode.update.mockResolvedValueOnce({ tries: 5 });
      await expect(
        service.verify({ email: EMAIL, code: '000000' }),
      ).resolves.toEqual({ result: 'expired' });
      expect(prisma.authCode.update).toHaveBeenLastCalledWith({
        where: { id: 'c1' },
        data: { usedAt: NOW },
      });
    });

    it('is single use: a concurrent consume returns expired', async () => {
      const { service, prisma, tx } = setup();
      prisma.authCode.findFirst.mockResolvedValue(codeRow('123456'));
      prisma.user.findUnique.mockResolvedValue(user());
      tx.authCode.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.verify({ email: EMAIL, code: '123456' }),
      ).resolves.toEqual({ result: 'expired' });
      expect(tx.authSession.create).not.toHaveBeenCalled();
    });

    it('never logs in an ineligible user even with the right code', async () => {
      const { service, prisma, tx } = setup();
      prisma.authCode.findFirst.mockResolvedValue(codeRow('123456'));
      prisma.user.findUnique.mockResolvedValue(user({ status: 'deactivated' }));
      await expect(
        service.verify({ email: EMAIL, code: '123456' }),
      ).resolves.toEqual({ result: 'expired' });
      expect(prisma.authCode.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { usedAt: NOW },
      });
      expect(tx.authSession.create).not.toHaveBeenCalled();
    });
  });

  describe('verify with AUTH_DEV_ACCEPT_ANY_CODE', () => {
    it('logs in an eligible user with any code, even without a requested code', async () => {
      const { service, prisma, tx } = setup({ AUTH_DEV_ACCEPT_ANY_CODE: true });
      prisma.user.findUnique.mockResolvedValue(user());
      await expect(
        service.verify({ email: EMAIL, code: '000000' }),
      ).resolves.toMatchObject({ result: 'ok' });
      expect(prisma.authCode.findFirst).not.toHaveBeenCalled();
      expect(tx.authCode.updateMany).toHaveBeenCalledWith({
        where: { email: EMAIL, usedAt: null },
        data: { usedAt: NOW },
      });
      expect(tx.authSession.create).toHaveBeenCalled();
    });

    it('still refuses unknown and ineligible users', async () => {
      const { service, prisma, tx } = setup({ AUTH_DEV_ACCEPT_ANY_CODE: true });
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(user({ status: 'deactivated' }));
      for (let i = 0; i < 2; i++)
        await expect(
          service.verify({ email: EMAIL, code: '000000' }),
        ).resolves.toEqual({ result: 'expired' });
      expect(tx.authSession.create).not.toHaveBeenCalled();
    });
  });

  describe('verify with an invite token', () => {
    const invite = (over: object = {}) => ({
      id: 'i1',
      status: 'pending',
      expiresAt: new Date(NOW.getTime() + MIN),
      user: user(),
      ...over,
    });

    it('logs in with a pending invite token', async () => {
      const { service, prisma, tx } = setup();
      prisma.invite.findUnique.mockResolvedValue(invite());
      await expect(
        service.verify({ token: 'magic-token-0123456789' }),
      ).resolves.toMatchObject({ result: 'ok' });
      expect(prisma.invite.findUnique).toHaveBeenCalledWith({
        where: { tokenHash: sha256Hex('magic-token-0123456789') },
        include: { user: true },
      });
      expect(tx.invite.updateMany).toHaveBeenCalledWith({
        where: { id: 'i1', status: 'pending' },
        data: { status: 'accepted' },
      });
      expect(tx.authSession.create).toHaveBeenCalled();
    });

    it.each([
      ['unknown', null],
      ['accepted', invite({ status: 'accepted' })],
      ['expired', invite({ expiresAt: NOW })],
      ['revoked user', invite({ user: user({ status: 'revoked' }) })],
    ])('returns expired for an %s token', async (_label, found) => {
      const { service, prisma, tx } = setup();
      prisma.invite.findUnique.mockResolvedValue(found);
      await expect(
        service.verify({ token: 'magic-token-0123456789' }),
      ).resolves.toEqual({ result: 'expired' });
      expect(tx.authSession.create).not.toHaveBeenCalled();
    });
  });

  it('logout revokes the current session', async () => {
    const { service, prisma } = setup();
    await service.logout('as1');
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'as1', revokedAt: null },
      data: { revokedAt: NOW },
    });
  });

  it('me returns the candidate shape', async () => {
    const { service } = setup();
    const accessExpiresAt = new Date('2027-01-01T00:00:00Z');
    await expect(
      service.me({
        id: 'u1',
        email: EMAIL,
        name: null,
        role: 'candidate',
        status: 'active',
        accessExpiresAt,
        authSessionId: 'as1',
      }),
    ).resolves.toEqual({
      id: 'u1',
      email: EMAIL,
      name: null,
      initials: 'PR',
      role: 'candidate',
      accessExpiresAt: '2027-01-01T00:00:00.000Z',
      audioRetentionDays: 30,
      candidatesCanDeleteData: true,
    });
  });

  it('projects disabled deletion policy without exposing other workspace settings', async () => {
    const { service, settings } = setup();
    const workspace = {
      audioRetentionDays: 30,
      candidatesCanDeleteData: false,
      providerSecret: 'not-for-candidates',
    };
    settings.get.mockResolvedValue(workspace);
    const response = await service.me({
      id: 'u1',
      email: EMAIL,
      name: null,
      role: 'candidate',
      status: 'active',
      accessExpiresAt: null,
      authSessionId: 'as1',
    });
    expect(response.candidatesCanDeleteData).toBe(false);
    expect(response).not.toHaveProperty('providerSecret');
  });

  it('adminMe returns the admin UI Admin shape', async () => {
    const { service, prisma } = setup();
    const sentAt = new Date('2026-09-01T00:00:00Z');
    prisma.user.findUniqueOrThrow.mockResolvedValue(
      user({
        role: 'super_admin',
        status: 'active',
        title: 'Head of Talent',
        lastActiveAt: NOW,
        invites: [{ sentAt }],
      }),
    );
    const authUser = {
      id: 'u1',
      email: EMAIL,
      name: 'Priya Shah',
      role: 'super_admin' as const,
      status: 'active' as const,
      accessExpiresAt: null,
      authSessionId: 'as1',
    };
    await expect(service.adminMe(authUser)).resolves.toEqual({
      id: 'u1',
      name: 'Priya Shah',
      email: EMAIL,
      title: 'Head of Talent',
      access: 'super_admin',
      status: 'active',
      lastActiveAt: NOW.toISOString(),
      invitedAt: sentAt.toISOString(),
    });
  });
});
