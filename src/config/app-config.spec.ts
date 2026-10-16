import { loadConfig } from './app-config.js';

describe('loadConfig', () => {
  const base = { DATABASE_URL: 'postgresql://x', AUTH_SECRET: 'a'.repeat(32) };

  it('applies defaults', () => {
    const { env } = loadConfig(base);
    expect(env.PORT).toBe(3000);
    expect(env.SESSION_TTL_DAYS).toBe(7);
    expect(env.LOG_PRETTY).toBe(false);
  });

  it('allows AUTH_DEV_ACCEPT_ANY_CODE in production only with an allowlist', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      AUTH_DEV_ACCEPT_ANY_CODE: 'true',
    };
    expect(() => loadConfig(prod)).toThrow(/AUTH_DEV_ACCEPT_ANY_CODE/);
    const { env } = loadConfig({
      ...prod,
      AUTH_DEV_ANY_CODE_ALLOWLIST: 'Team@Acme.com, @acme.io',
    });
    expect(env.AUTH_DEV_ANY_CODE_ALLOWLIST).toEqual([
      'team@acme.com',
      '@acme.io',
    ]);
  });

  it('names invalid variables without echoing secret values', () => {
    const secret = 'short-secret';
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgresql://x', AUTH_SECRET: secret }),
    ).toThrow(/AUTH_SECRET/);
    try {
      loadConfig({ DATABASE_URL: 'postgresql://x', AUTH_SECRET: secret });
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });
});
