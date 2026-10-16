import { Injectable, Logger } from '@nestjs/common';
import type { AuthUser } from '../../common/auth/auth.types.js';
import {
  hmacHex,
  randomOtp,
  randomToken,
  safeEqual,
  sha256Hex,
} from '../../common/crypto.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { AppConfig } from '../../config/app-config.js';
import type { Prisma, User } from '../../generated/prisma/client.js';
import { EmailService } from '../../jobs/email/email.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { SettingsService } from '../settings/settings.service.js';
import type {
  AdminMeResponse,
  MeResponse,
  RequestCodeResponse,
  VerifyBody,
  VerifyResult,
} from './auth.schemas.js';
import { initialsFor } from './initials.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export type VerifyOutcome =
  | { result: Exclude<VerifyResult, 'ok'> }
  | { result: 'ok'; sessionToken: string; maxAgeMs: number };

/** Thrown inside the login transaction when a concurrent request already consumed the code or invite. */
class AlreadyConsumed extends Error {}

/** Passwordless login (FR-AUTH-01..06, plan §5 "Auth"). Never logs emails or codes: ids only. */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly rateLimiter: RateLimiter,
    private readonly email: EmailService,
    private readonly activity: ActivityService,
    private readonly settings: SettingsService,
  ) {}

  /** Always `sent` unless rate-limited, so the response never reveals who is invited (FR-AUTH-03). */
  async requestCode(email: string, ip: string): Promise<RequestCodeResponse> {
    const env = this.config.env;
    const emailKey = sha256Hex(email);
    const limits: [string, number, number][] = [
      [`otp:ip:${ip}`, env.OTP_IP_REQUESTS_PER_HOUR, 3600],
      [`otp:email:${emailKey}`, env.OTP_REQUESTS_PER_HOUR, 3600],
      [`otp:cooldown:${emailKey}`, 1, env.OTP_RESEND_COOLDOWN_SEC],
    ];
    for (const [key, limit, windowSec] of limits) {
      const r = await this.rateLimiter.consume(key, limit, windowSec);
      if (!r.allowed)
        return { result: 'rate-limited', retryAfterSec: r.retryAfterSec };
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    // Generated either way so both branches cost about the same.
    const code = randomOtp();
    const codeHash = this.codeHash(email, code);
    if (!user || !isEligible(user, new Date())) return { result: 'sent' };

    await this.prisma.$transaction([
      this.prisma.authCode.deleteMany({ where: { email, usedAt: null } }),
      this.prisma.authCode.create({
        data: {
          email,
          codeHash,
          expiresAt: new Date(Date.now() + env.OTP_TTL_MIN * MINUTE_MS),
        },
      }),
    ]);
    try {
      await this.email.send({
        template: 'login-code',
        to: email,
        vars: { code, minutes: env.OTP_TTL_MIN },
      });
    } catch (err) {
      // Still `sent`: an error here would reveal that the address is invited.
      this.logger.error(
        { userId: user.id, err },
        'Failed to enqueue login code email',
      );
    }
    return { result: 'sent' };
  }

  async verify(body: VerifyBody): Promise<VerifyOutcome> {
    return 'token' in body
      ? this.verifyToken(body.token)
      : this.verifyCode(body.email, body.code);
  }

  async logout(authSessionId: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { id: authSessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(user: AuthUser): Promise<MeResponse> {
    const { audioRetentionDays, candidatesCanDeleteData } =
      await this.settings.get();
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      initials: initialsFor(user.name, user.email),
      role: user.role,
      accessExpiresAt: user.accessExpiresAt?.toISOString() ?? null,
      audioRetentionDays,
      candidatesCanDeleteData,
    };
  }

  async adminMe(authUser: AuthUser): Promise<AdminMeResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: authUser.id },
      include: {
        invites: {
          orderBy: { sentAt: 'asc' },
          take: 1,
          select: { sentAt: true },
        },
      },
    });
    const invitedAt = user.invites[0]?.sentAt;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      ...(user.title ? { title: user.title } : {}),
      access: user.role === 'super_admin' ? 'super_admin' : 'admin',
      status: user.status === 'invite_pending' ? 'invite_pending' : 'active',
      lastActiveAt: user.lastActiveAt?.toISOString() ?? null,
      ...(invitedAt ? { invitedAt: invitedAt.toISOString() } : {}),
    };
  }

  private codeHash(email: string, code: string): string {
    return hmacHex(this.config.env.AUTH_SECRET, `${email}:${code}`);
  }

  private async verifyCode(
    email: string,
    code: string,
  ): Promise<VerifyOutcome> {
    const now = new Date();
    if (this.config.env.AUTH_DEV_ACCEPT_ANY_CODE)
      return this.verifyAnyCode(email, now);
    const authCode = await this.prisma.authCode.findFirst({
      where: { email, usedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
    if (!authCode) return { result: 'expired' };

    if (!safeEqual(authCode.codeHash, this.codeHash(email, code))) {
      const { tries } = await this.prisma.authCode.update({
        where: { id: authCode.id },
        data: { tries: { increment: 1 } },
        select: { tries: true },
      });
      if (tries < this.config.env.OTP_MAX_TRIES) return { result: 'wrong' };
      await this.prisma.authCode.update({
        where: { id: authCode.id },
        data: { usedAt: now },
      });
      return { result: 'expired' };
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !isEligible(user, now)) {
      await this.prisma.authCode.update({
        where: { id: authCode.id },
        data: { usedAt: now },
      });
      return { result: 'expired' };
    }
    return this.login(user, now, async (tx) => {
      const { count } = await tx.authCode.updateMany({
        where: { id: authCode.id, usedAt: null },
        data: { usedAt: now },
      });
      if (count === 0) throw new AlreadyConsumed();
    });
  }

  /** AUTH_DEV_ACCEPT_ANY_CODE: skips the code check but keeps eligibility, and burns any live codes. */
  private async verifyAnyCode(
    email: string,
    now: Date,
  ): Promise<VerifyOutcome> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !isEligible(user, now)) return { result: 'expired' };
    return this.login(user, now, async (tx) => {
      await tx.authCode.updateMany({
        where: { email, usedAt: null },
        data: { usedAt: now },
      });
    });
  }

  /** Invite magic link: a one-time token whose sha256 is on a pending, unexpired invite. */
  private async verifyToken(token: string): Promise<VerifyOutcome> {
    const now = new Date();
    const invite = await this.prisma.invite.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { user: true },
    });
    if (
      !invite ||
      invite.status !== 'pending' ||
      invite.expiresAt <= now ||
      !isEligible(invite.user, now)
    ) {
      return { result: 'expired' };
    }
    return this.login(invite.user, now, async (tx) => {
      const { count } = await tx.invite.updateMany({
        where: { id: invite.id, status: 'pending' },
        data: { status: 'accepted' },
      });
      if (count === 0) throw new AlreadyConsumed();
    });
  }

  private async login(
    user: User,
    now: Date,
    consume: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<VerifyOutcome> {
    const sessionToken = randomToken();
    const maxAgeMs = this.config.env.SESSION_TTL_DAYS * DAY_MS;
    const firstLogin = !user.firstLoginAt;
    try {
      await this.prisma.$transaction(async (tx) => {
        await consume(tx);
        await tx.user.update({
          where: { id: user.id },
          data: {
            status: 'active',
            firstLoginAt: user.firstLoginAt ?? now,
            lastActiveAt: now,
          },
        });
        await tx.invite.updateMany({
          where: { userId: user.id, status: 'pending' },
          data: { status: 'accepted' },
        });
        await tx.authSession.create({
          data: {
            userId: user.id,
            tokenHash: sha256Hex(sessionToken),
            lastSeenAt: now,
            expiresAt: new Date(now.getTime() + maxAgeMs),
          },
        });
      });
    } catch (err) {
      if (err instanceof AlreadyConsumed) return { result: 'expired' };
      throw err;
    }
    if (firstLogin) await this.activity.record(user.id, 'First login', now);
    return { result: 'ok', sessionToken, maxAgeMs };
  }
}

/** Invited or active, not erased, access not expired. */
function isEligible(user: User, now: Date): boolean {
  if (user.deletedAt) return false;
  if (user.status !== 'invite_pending' && user.status !== 'active')
    return false;
  return !user.accessExpiresAt || user.accessExpiresAt > now;
}
