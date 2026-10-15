import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';

// Queue-processor process (PROCESS_ROLE=worker): no HTTP server. Processors register themselves
// from their modules on init.
const app = await NestFactory.createApplicationContext(AppModule, {
  bufferLogs: true,
});
app.useLogger(app.get(Logger));
app.enableShutdownHooks();
app.get(Logger).log('Worker started');
