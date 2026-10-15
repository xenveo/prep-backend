import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { AppConfig } from './config/app-config.js';

if (process.env.PROCESS_ROLE === 'worker') {
  console.error(
    'PROCESS_ROLE=worker: start the queue worker with `node dist/worker.js` instead of the API.',
  );
  process.exit(1);
}

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  bufferLogs: true,
});
app.useLogger(app.get(Logger));
const { env } = app.get(AppConfig);

configureApp(app);

await app.listen(env.PORT);
