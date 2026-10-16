import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AppConfig } from '../../config/app-config.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { sha256Hex } from '../crypto.js';
import { AppError } from '../errors/app-error.js';
import type { AuthedRequest } from './auth.types.js';
import { SessionGuard } from './session.guard.js';

const NOW = new Date('2026-10-15T12:00:00Z');
const MIN = 60_000;

function context(req: Partial<AuthedRequest>): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function makeSession(over: { session?: object; user?: object } = {}) {
  return {
    id: 'as1',
    userId: 'u1',
    lastSeenAt: new Date(NOW.getTime() - MIN),
    expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * MIN),
    revokedAt: null,
    ...over.session,
    user: {
      id: 'u1',
      email: 'a@b.co',
      name: 'A B',
      role: 'candidate',
      status: 'active',
      accessExpiresAt: null,
      deletedAt: null,
      ...over.user,
    },
  };
}

describe('SessionGuard', () => {
  let prisma: {
    authSession: {
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    user: { update: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let reflector: Reflector;
  let guard: SessionGuard;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    prisma = {
      authSession: {
        findUnique: vi.fn(),
        update: vi.fn().mockReturnValue('u-session'),
      },
      user: { update: vi.fn().mockReturnValue('u-user') },
      $transaction: vi.fn().mockResolvedValue([]),
    };
    reflector = new Reflector();
    guard = new SessionGuard(
      reflector,
      prisma as unknown as PrismaService,
      { env: { SESSION_TTL_DAYS: 7 } } as unknown as AppConfig,
    );
  });

  afterEach(() => vi.useRealTimers());

  const run = (req: Partial<AuthedRequest>) => guard.canActivate(context(req));
  const withCookie = (): Partial<AuthedRequest> => ({
    cookies: { pp_session: 'tok' },
  });

  async function expectError(
    promise: Promise<unknown>,
    status: number,
    code: string,
  ) {
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(status);
    expect((err as AppError).code).toBe(code);
  }

  it('lets public routes through without a cookie', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    await expect(run({ cookies: {} })).resolves.toBe(true);
    expect(prisma.authSession.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a missing cookie or unknown session with 401', async () => {
    await expectError(run({ cookies: {} }), 401, 'unauthenticated');
    prisma.authSession.findUnique.mockResolvedValue(null);
    await expectError(run(withCookie()), 401, 'unauthenticated');
    expect(prisma.authSession.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: sha256Hex('tok') } }),
    );
  });

  it.each([
    ['revoked', { session: { revokedAt: NOW } }],
    ['expired', { session: { expiresAt: NOW } }],
    ['deactivated', { user: { status: 'deactivated' } }],
    ['revoked user', { user: { status: 'revoked' } }],
    ['invite pending', { user: { status: 'invite_pending' } }],
    ['erased', { user: { deletedAt: NOW } }],
  ])('rejects a %s session with 401', async (_label, over) => {
    prisma.authSession.findUnique.mockResolvedValue(makeSession(over));
    await expectError(run(withCookie()), 401, 'unauthenticated');
  });

  it('returns 403 access_expired once access has lapsed', async () => {
    prisma.authSession.findUnique.mockResolvedValue(
      makeSession({ user: { accessExpiresAt: NOW } }),
    );
    await expectError(run(withCookie()), 403, 'access_expired');
  });

  it('sets req.user and skips the write when seen recently', async () => {
    prisma.authSession.findUnique.mockResolvedValue(makeSession());
    const req = withCookie();
    await expect(run(req)).resolves.toBe(true);
    expect(req.user).toEqual({
      id: 'u1',
      email: 'a@b.co',
      name: 'A B',
      role: 'candidate',
      status: 'active',
      accessExpiresAt: null,
      authSessionId: 'as1',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('slides the expiry and touches lastActiveAt after 5 minutes', async () => {
    prisma.authSession.findUnique.mockResolvedValue(
      makeSession({
        session: { lastSeenAt: new Date(NOW.getTime() - 5 * MIN) },
      }),
    );
    await run(withCookie());
    expect(prisma.authSession.update).toHaveBeenCalledWith({
      where: { id: 'as1' },
      data: {
        lastSeenAt: NOW,
        expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * MIN),
      },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { lastActiveAt: NOW },
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(['u-session', 'u-user']);
  });
});
