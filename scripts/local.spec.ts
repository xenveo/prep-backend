import { buildLocalEnvironment, runLocalMode } from './local.js';
import { loadConfig } from '../src/config/app-config.js';

const startup = vi.hoisted(() => ({
  create: vi.fn(),
  configure: vi.fn(),
}));
vi.mock('@nestjs/core', () => ({ NestFactory: { create: startup.create } }));
vi.mock('../src/app.module.js', () => ({ AppModule: class {} }));
vi.mock('../src/app.setup.js', () => ({ configureApp: startup.configure }));
vi.mock('dotenv/config', () => ({}));

const base = {
  DATABASE_URL:
    'postgresql://dev:password@localhost:5432/prep_db?schema=public',
};

describe('local development mode', () => {
  it('sets an exact OTP allowlist and local origins without changing the source', () => {
    const source = {
      ...base,
      AUTH_DEV_ANY_CODE_ALLOWLIST: '@xenveo.com,another@example.com',
      SESSION_COOKIE_DOMAIN: 'example.com',
      TRUST_PROXY: '2',
      PROCESS_ROLE: 'worker',
      API_BIND_HOST: '0.0.0.0',
    };
    const env = buildLocalEnvironment(source);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PROCESS_ROLE: 'all',
      PORT: '3000',
      API_BIND_HOST: '127.0.0.1',
      AUTH_DEV_ACCEPT_ANY_CODE: 'true',
      AUTH_DEV_ANY_CODE_ALLOWLIST: 'superadmin@xenveo.com',
      BOOTSTRAP_ADMIN_EMAIL: 'superadmin@xenveo.com',
      PUBLIC_API_URL: 'http://localhost:3000',
      APP_ADMIN_ORIGIN: 'http://localhost:5174',
      APP_CANDIDATE_ORIGIN: 'http://localhost:5173',
      SESSION_COOKIE_DOMAIN: '',
      TRUST_PROXY: '',
    });
    expect(source.AUTH_DEV_ANY_CODE_ALLOWLIST).toBe(
      '@xenveo.com,another@example.com',
    );
    expect(source.SESSION_COOKIE_DOMAIN).toBe('example.com');
    expect(source.API_BIND_HOST).toBe('0.0.0.0');
  });

  it('refuses production before any bootstrap', () => {
    expect(() =>
      buildLocalEnvironment({ ...base, NODE_ENV: 'production' }),
    ).toThrow('NODE_ENV=production');
  });

  it.each([undefined, '0.0.0.0', '::', '192.168.1.50'])(
    'always binds local mode to loopback instead of inherited host %s',
    (API_BIND_HOST) => {
      const env = loadConfig(
        buildLocalEnvironment({
          ...base,
          AUTH_SECRET: 'a'.repeat(32),
          API_BIND_HOST,
        }),
      ).env;
      expect(env.API_BIND_HOST).toBe('127.0.0.1');
    },
  );

  it.each([
    undefined,
    'not-a-url',
    'https://localhost/db',
    'postgresql://db.example.com/db',
    'postgresql://localhost.example.com/db',
    'postgresql://localhost/db?host=db.example.com',
    'postgresql://localhost/db?hostaddr=203.0.113.1',
  ])(
    'refuses invalid or remote database configuration (%s)',
    (DATABASE_URL) => {
      expect(() => buildLocalEnvironment({ DATABASE_URL })).toThrow(
        /DATABASE_URL/,
      );
    },
  );

  it.each(['localhost', '127.0.0.1', '[::1]'])(
    'accepts loopback %s',
    (host) => {
      expect(
        buildLocalEnvironment({ DATABASE_URL: `postgresql://${host}/prep_db` }),
      ).toHaveProperty('NODE_ENV', 'development');
    },
  );

  it('respects a valid custom API port', () => {
    expect(
      buildLocalEnvironment({ ...base, PORT: '3100' }).PUBLIC_API_URL,
    ).toBe('http://localhost:3100');
    expect(() => buildLocalEnvironment({ ...base, PORT: '3000/path' })).toThrow(
      /PORT/,
    );
  });

  it('starts the API only after bootstrap succeeds, with the same scoped environment', async () => {
    const env = buildLocalEnvironment(base);
    const run = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(130);
    expect(await runLocalMode(env, run)).toBe(130);
    expect(run.mock.calls).toEqual([
      [['--import', 'tsx', 'scripts/bootstrap.ts'], env],
      [['node_modules/@nestjs/cli/bin/nest.js', 'start', '--watch'], env],
    ]);
  });

  it.each([1, 130, 143])(
    'does not start the API after bootstrap exits %s',
    async (code) => {
      const run = vi.fn().mockResolvedValue(code);
      expect(await runLocalMode(buildLocalEnvironment(base), run)).toBe(code);
      expect(run).toHaveBeenCalledTimes(1);
    },
  );
});

describe('API startup listening interface', () => {
  it.each([false, true])(
    'passes the validated interface to Nest only in configured startup (local=%s)',
    async (local) => {
      vi.resetModules();
      const source = { ...base, AUTH_SECRET: 'a'.repeat(32) };
      const env = loadConfig(
        local ? buildLocalEnvironment(source) : source,
      ).env;
      const listen = vi.fn().mockResolvedValue(undefined);
      const app = {
        get: vi.fn().mockReturnValue({ env }),
        useLogger: vi.fn(),
        listen,
      };
      startup.create.mockResolvedValue(app);
      vi.stubEnv('PROCESS_ROLE', 'all');
      try {
        await import('../src/main.js');
        expect(startup.configure).toHaveBeenCalledWith(app);
        expect(listen).toHaveBeenCalledExactlyOnceWith(
          ...(local ? [3000, '127.0.0.1'] : [3000]),
        );
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});
