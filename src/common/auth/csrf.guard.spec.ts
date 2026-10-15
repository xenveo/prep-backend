import type { ExecutionContext } from '@nestjs/common';
import type { AppConfig } from '../../config/app-config.js';
import { AppError } from '../errors/app-error.js';
import { CsrfGuard } from './csrf.guard.js';

const ctx = (method: string, headers: Record<string, string> = {}) =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ method, headers }) }),
  }) as unknown as ExecutionContext;

describe('CsrfGuard', () => {
  const guard = new CsrfGuard({
    env: {
      APP_CANDIDATE_ORIGIN: 'https://app.example.com',
      APP_ADMIN_ORIGIN: 'https://admin.example.com',
      PUBLIC_API_URL: 'https://api.example.com/base',
    },
  } as AppConfig);

  const rejects = (c: ExecutionContext) => {
    try {
      guard.canActivate(c);
      return false;
    } catch (e) {
      return (
        e instanceof AppError && e.status === 403 && e.code === 'forbidden'
      );
    }
  };

  it('ignores safe methods', () => {
    expect(
      guard.canActivate(ctx('GET', { origin: 'https://evil.example' })),
    ).toBe(true);
  });

  it('allows requests with neither Origin nor Referer', () => {
    expect(guard.canActivate(ctx('POST'))).toBe(true);
  });

  it('allows our origins', () => {
    expect(
      guard.canActivate(ctx('POST', { origin: 'https://app.example.com' })),
    ).toBe(true);
    expect(
      guard.canActivate(ctx('DELETE', { origin: 'https://admin.example.com' })),
    ).toBe(true);
    expect(
      guard.canActivate(ctx('PATCH', { origin: 'https://api.example.com' })),
    ).toBe(true);
    expect(
      guard.canActivate(
        ctx('POST', { referer: 'https://app.example.com/login?x=1' }),
      ),
    ).toBe(true);
  });

  it('rejects foreign or malformed origins with 403', () => {
    expect(rejects(ctx('POST', { origin: 'https://evil.example' }))).toBe(true);
    expect(rejects(ctx('POST', { origin: 'null' }))).toBe(true);
    expect(rejects(ctx('POST', { referer: 'https://evil.example/page' }))).toBe(
      true,
    );
    expect(
      rejects(
        ctx('POST', {
          origin: 'https://evil.example',
          referer: 'https://app.example.com/',
        }),
      ),
    ).toBe(true);
  });
});
