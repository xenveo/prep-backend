import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { AppConfig } from './config/app-config.js';

/**
 * Response headers for a JSON API (helmet's relevant subset, without the dependency).
 * CORP is same-site, not same-origin: the UIs play API-served audio with a plain <audio src>, a
 * no-cors load that same-origin would block. The apps share the API's parent domain (the session
 * cookie needs it), and localhost ports are one site.
 */
export function securityHeaders(production: boolean) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    if (production)
      res.setHeader(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains',
      );
    next();
  };
}

/** HTTP setup shared by main.ts and the e2e tests, so tests run the same stack. */
export function configureApp(app: NestExpressApplication): void {
  const { env } = app.get(AppConfig);
  if (env.TRUST_PROXY) app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');
  app.use(securityHeaders(env.NODE_ENV === 'production'));
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
