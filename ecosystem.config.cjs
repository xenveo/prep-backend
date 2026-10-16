// pm2 process file for production.
//   npm ci && npm run build && npx prisma migrate deploy
//   pm2 start ecosystem.config.cjs
// The app reads .env itself (dotenv); the `env` values below take precedence over it.
//
// With REDIS_URL set, the API and the queue worker run as separate processes (BullMQ + Redis
// pub/sub). Without it the queue and pub/sub are in-process, so everything must run in one
// process (PROCESS_ROLE=all).
const path = require('node:path');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // No .env: rely on the shell environment.
}

const common = {
  cwd: __dirname,
  exec_mode: 'fork',
  instances: 1,
  autorestart: true,
  min_uptime: '10s',
  max_restarts: 10,
  exp_backoff_restart_delay: 200,
  // Nest shutdown hooks close DB/Redis connections; give in-flight jobs time to finish.
  kill_timeout: 15000,
  max_memory_restart: '1G',
  time: true,
};

// Production on xenveo: nginx proxies prep-api.xenveo.com to this port.
const env = {
  NODE_ENV: 'production',
  PORT: '3000',
  PUBLIC_API_URL: 'https://prep-api.xenveo.com',
  APP_CANDIDATE_ORIGIN: 'https://prep.xenveo.com',
  APP_ADMIN_ORIGIN: 'https://prep-admin.xenveo.com',
  // The frontends' servers read the session cookie, so it must cover their hosts too.
  SESSION_COOKIE_DOMAIN: 'xenveo.com',
  // Any login code works only for this one super admin; everyone else needs the emailed code.
  AUTH_DEV_ACCEPT_ANY_CODE: 'true',
  AUTH_DEV_ANY_CODE_ALLOWLIST: 'superadmin@xenveo.com',
  // Cloudflare -> nginx -> app: the client IP is two hops back.
  TRUST_PROXY: '2',
  // pino-pretty is a dev dependency; production logs are JSON.
  LOG_PRETTY: 'false',
};

const apps = process.env.REDIS_URL
  ? [
      {
        ...common,
        name: 'prep-api',
        script: 'dist/main.js',
        env: { ...env, PROCESS_ROLE: 'api' },
      },
      {
        ...common,
        name: 'prep-worker',
        script: 'dist/worker.js',
        env: { ...env, PROCESS_ROLE: 'worker' },
      },
    ]
  : [
      {
        ...common,
        name: 'prep-api',
        script: 'dist/main.js',
        env: { ...env, PROCESS_ROLE: 'all' },
      },
    ];

module.exports = { apps };
