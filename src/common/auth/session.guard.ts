import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppConfig } from '../../config/app-config.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { sha256Hex } from '../crypto.js';
import { AppError } from '../errors/app-error.js';
import type { AuthedRequest } from './auth.types.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { sessionCookieName } from './session-cookie.js';

const SLIDE_EVERY_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const unauthenticated = () =>
  new AppError('unauthenticated', 401, 'Please sign in');

/**
 * Global guard: resolves the app's login cookie (`pp_session`, or `pp_admin_session` from the admin
 * app; see sessionCookieName) to `req.user`, sliding the session expiry (FR-AUTH-04).
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const cookie = sessionCookieName(
      req.headers,
      this.config.env.APP_ADMIN_ORIGIN,
    );
    const token: unknown = req.cookies?.[cookie];
    if (typeof token !== 'string' || !token) throw unauthenticated();

    const session = await this.prisma.authSession.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { user: true },
    });
    const now = new Date();
    if (!session || session.revokedAt || session.expiresAt <= now)
      throw unauthenticated();
    const { user } = session;
    if (user.deletedAt || user.status !== 'active') throw unauthenticated();
    if (user.accessExpiresAt && user.accessExpiresAt <= now) {
      throw new AppError('access_expired', 403, 'Your access has expired');
    }

    if (now.getTime() - session.lastSeenAt.getTime() >= SLIDE_EVERY_MS) {
      const expiresAt = new Date(
        now.getTime() + this.config.env.SESSION_TTL_DAYS * DAY_MS,
      );
      await this.prisma.$transaction([
        this.prisma.authSession.update({
          where: { id: session.id },
          data: { lastSeenAt: now, expiresAt },
        }),
        this.prisma.user.update({
          where: { id: user.id },
          data: { lastActiveAt: now },
        }),
      ]);
    }

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      accessExpiresAt: user.accessExpiresAt,
      authSessionId: session.id,
    };
    return true;
  }
}
