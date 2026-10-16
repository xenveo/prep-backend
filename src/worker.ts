import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { AppConfig } from './config/app-config.js';
import { WorkerHealthServer } from './modules/health/worker-health.server.js';

// Queue-processor process (PROCESS_ROLE=worker): no Nest HTTP server. Processors register themselves
// from their modules on init. WORKER_HEALTH_PORT adds a bare GET /ready for the orchestrator.
// Init hooks run here; one failing (Redis unreachable within REDIS_CONNECT_TIMEOUT_MS) exits
// non-zero with one line, so the orchestrator restarts the process instead of it hanging.
const app = await NestFactory.createApplicationContext(AppModule, {
  bufferLogs: true,
}).catch((err: unknown) => {
  console.error(
    `Startup failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
app.useLogger(app.get(Logger));
app.enableShutdownHooks();
const { env } = app.get(AppConfig);
if (env.WORKER_HEALTH_PORT !== undefined)
  await app.get(WorkerHealthServer).listen(env.WORKER_HEALTH_PORT);
app.get(Logger).log('Worker started');
