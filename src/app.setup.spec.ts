import { Controller, Get } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from './app.setup.js';
import { loadConfig } from './config/app-config.js';
import { AppConfig } from './config/app-config.js';

@Controller('ping')
class PingController {
  @Get()
  ping() {
    return { ok: true };
  }
}

async function appFor(
  nodeEnv: 'development' | 'production',
): Promise<NestExpressApplication> {
  const config = loadConfig({
    NODE_ENV: nodeEnv,
    DATABASE_URL: 'postgresql://unused',
    AUTH_SECRET: 'x'.repeat(16),
  });
  const moduleRef = await Test.createTestingModule({
    controllers: [PingController],
    providers: [{ provide: AppConfig, useValue: config }],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: false,
  });
  configureApp(app);
  await app.init();
  return app;
}

describe('configureApp security headers', () => {
  let app: NestExpressApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('sets the API security headers and hides X-Powered-By', async () => {
    app = await appFor('development');
    const res = await request(app.getHttpServer()).get('/api/ping').expect(200);
    expect(res.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-site',
    });
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('sets the headers on error responses too', async () => {
    app = await appFor('development');
    const res = await request(app.getHttpServer()).get('/api/missing');
    expect(res.status).toBe(404);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('adds HSTS in production', async () => {
    app = await appFor('production');
    const res = await request(app.getHttpServer()).get('/api/ping').expect(200);
    expect(res.headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });
});
