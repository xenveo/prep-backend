import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localAdmin = 'superadmin@xenveo.com';

/** Keep the existing OTP/session flow, scoped to one account and a local database. */
export function buildLocalEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (source.NODE_ENV === 'production')
    throw new Error('Local mode cannot run with NODE_ENV=production.');
  let database: URL;
  try {
    database = new URL(source.DATABASE_URL ?? '');
  } catch {
    throw new Error('Local mode requires a valid local DATABASE_URL.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) ||
    database.searchParams.has('host') ||
    database.searchParams.has('hostaddr')
  )
    throw new Error('Local mode requires a loopback PostgreSQL DATABASE_URL.');
  const port = source.PORT || '3000';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error('Local mode requires PORT between 1 and 65535.');
  return {
    ...source,
    NODE_ENV: 'development',
    PROCESS_ROLE: 'all',
    PORT: port,
    API_BIND_HOST: '127.0.0.1',
    AUTH_DEV_ACCEPT_ANY_CODE: 'true',
    AUTH_DEV_ANY_CODE_ALLOWLIST: localAdmin,
    BOOTSTRAP_ADMIN_EMAIL: localAdmin,
    BOOTSTRAP_ADMIN_NAME: 'Local super admin',
    PUBLIC_API_URL: `http://localhost:${port}`,
    APP_ADMIN_ORIGIN: 'http://localhost:5174',
    APP_CANDIDATE_ORIGIN: 'http://localhost:5173',
    // Empty strings also prevent child dotenv/config from restoring deployed values from .env.
    SESSION_COOKIE_DOMAIN: '',
    TRUST_PROXY: '',
  };
}

type Runner = (args: string[], env: NodeJS.ProcessEnv) => Promise<number>;

async function runChild(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((done, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(process.execPath, args, {
      cwd: root,
      env,
      stdio: 'inherit',
      detached: grouped,
    });
    const forward = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    child.once('error', () => {
      cleanup();
      reject(new Error('Could not start the local development process.'));
    });
    child.once('exit', (code, signal) => {
      cleanup();
      done(code ?? (signal ? 128 + constants.signals[signal] : 1));
    });
  });
}

export async function runLocalMode(
  env: NodeJS.ProcessEnv,
  run: Runner = runChild,
): Promise<number> {
  const bootstrap = await run(['--import', 'tsx', 'scripts/bootstrap.ts'], env);
  if (bootstrap !== 0) return bootstrap;
  return run(['node_modules/@nestjs/cli/bin/nest.js', 'start', '--watch'], env);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  loadDotenv({ path: resolve(root, '.env'), quiet: true });
  try {
    const env = buildLocalEnvironment(process.env);
    console.log(
      'Local mode: preparing the local super admin, then starting the API.',
    );
    process.exitCode = await runLocalMode(env);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Local startup failed.',
    );
    process.exitCode = 1;
  }
}
