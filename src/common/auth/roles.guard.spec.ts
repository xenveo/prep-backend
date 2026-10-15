import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../errors/app-error.js';
import type { AuthUser } from './auth.types.js';
import { RolesGuard } from './roles.guard.js';

const ctx = (user?: Partial<AuthUser>) =>
  ({
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

describe('RolesGuard', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);

  it('allows any authenticated user when no roles are set', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    expect(guard.canActivate(ctx({ role: 'candidate' }))).toBe(true);
  });

  it('allows listed roles', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([
      'admin',
      'super_admin',
    ]);
    expect(guard.canActivate(ctx({ role: 'admin' }))).toBe(true);
  });

  it('hides the route with 404 for other roles', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['super_admin']);
    for (const user of [
      { role: 'admin' as const },
      { role: 'candidate' as const },
      undefined,
    ]) {
      try {
        guard.canActivate(ctx(user));
        expect.unreachable();
      } catch (e) {
        expect((e as AppError).status).toBe(404);
        expect((e as AppError).code).toBe('not_found');
      }
    }
  });
});
