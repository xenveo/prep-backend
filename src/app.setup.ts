import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppConfig } from './config/app-config.js';

/** HTTP setup shared by main.ts and the e2e tests, so tests run the same stack. */
export function configureApp(app: NestExpressApplication): void {
  const { env } = app.get(AppConfig);
  if (env.TRUST_PROXY) app.set('trust proxy', env.TRUST_PROXY);
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  // POST /admin/candidates/export.csv takes up to 5000 ids (~195 KB); the default is 100 KB.
  app.useBodyParser('json', { limit: '256kb' });
  app.enableCors({
    origin: [env.APP_CANDIDATE_ORIGIN, env.APP_ADMIN_ORIGIN],
    credentials: true,
    // CSV downloads carry their filename here; browsers hide it from fetch unless exposed.
    exposedHeaders: ['Content-Disposition'],
  });
  app.enableShutdownHooks();
}
