import { createRequire } from 'node:module';
import { loadConfig } from './app-config.js';

describe('loadConfig', () => {
  const base = { DATABASE_URL: 'postgresql://x', AUTH_SECRET: 'a'.repeat(32) };

  it('applies defaults', () => {
    const { env } = loadConfig(base);
    expect(env.PORT).toBe(3000);
    expect(env.SESSION_TTL_DAYS).toBe(7);
    expect(env.LOG_PRETTY).toBe(false);
    expect(env.API_BIND_HOST).toBeUndefined();
  });

  it('supports an explicit bind interface without changing normal production startup', () => {
    const { env } = loadConfig({
      ...base,
      NODE_ENV: 'production',
      API_BIND_HOST: '0.0.0.0',
    });
    expect(env.API_BIND_HOST).toBe('0.0.0.0');
    expect(
      loadConfig({ ...base, API_BIND_HOST: '127.0.0.1' }).env.API_BIND_HOST,
    ).toBe('127.0.0.1');
    expect(() => loadConfig({ ...base, API_BIND_HOST: '  ' })).toThrow(
      /API_BIND_HOST/,
    );
  });

  it.each(['', 'Team@Acme.com, @acme.io'])(
    'rejects the production OTP bypass regardless of allowlist (%s)',
    (allowlist) => {
      expect(() =>
        loadConfig({
          ...base,
          NODE_ENV: 'production',
          AUTH_DEV_ACCEPT_ANY_CODE: 'true',
          AUTH_DEV_ANY_CODE_ALLOWLIST: allowlist,
        }),
      ).toThrow(/AUTH_DEV_ACCEPT_ANY_CODE/);
    },
  );

  it('allows normal production OTP configuration', () => {
    const { env } = loadConfig({ ...base, NODE_ENV: 'production' });
    expect(env.AUTH_DEV_ACCEPT_ANY_CODE).toBe(false);
  });

  it('preserves the non-production allowlist', () => {
    const { env } = loadConfig({
      ...base,
      NODE_ENV: 'development',
      AUTH_DEV_ACCEPT_ANY_CODE: 'true',
      AUTH_DEV_ANY_CODE_ALLOWLIST: 'Team@Acme.com, @acme.io',
    });
    expect(env.AUTH_DEV_ANY_CODE_ALLOWLIST).toEqual([
      'team@acme.com',
      '@acme.io',
    ]);
  });

  it.each(['', 'redis://localhost:6379'])(
    'production process configuration disables inherited OTP bypass (Redis=%s)',
    (redis) => {
      vi.stubEnv('REDIS_URL', redis);
      vi.stubEnv('AUTH_DEV_ACCEPT_ANY_CODE', 'true');
      vi.stubEnv('AUTH_DEV_ANY_CODE_ALLOWLIST', '@example.test');
      try {
        const require = createRequire(import.meta.url);
        const filename = require.resolve('../../ecosystem.config.cjs');
        delete require.cache[filename];
        const config = require(filename) as {
          apps: { env: NodeJS.ProcessEnv }[];
        };
        expect(config.apps.length).toBeGreaterThan(0);
        for (const app of config.apps) {
          const { env } = loadConfig({ ...process.env, ...base, ...app.env });
          expect(env.NODE_ENV).toBe('production');
          expect(env.AUTH_DEV_ACCEPT_ANY_CODE).toBe(false);
          expect(env.AUTH_DEV_ANY_CODE_ALLOWLIST).toEqual([]);
        }
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

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
