import { Logger } from '@nestjs/common';
import type { HealthService, ReadyStatus } from './health.service.js';
import { WorkerHealthServer } from './worker-health.server.js';

describe('WorkerHealthServer', () => {
  let ready: ReadyStatus;
  let server: WorkerHealthServer;
  let base: string;

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    ready = { status: 'ready', db: 'ok', redis: 'ok', storage: 'ok' };
    server = new WorkerHealthServer({
      ready: () => Promise.resolve(ready),
    } as unknown as HealthService);
    base = `http://127.0.0.1:${await server.listen(0)}`;
  });
  afterEach(async () => {
    await server.onModuleDestroy();
    vi.restoreAllMocks();
  });

  it('answers GET /ready with 200 JSON when ready', async () => {
    const res = await fetch(`${base}/ready`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    await expect(res.json()).resolves.toEqual(ready);
  });

  it('answers 503 with the readiness body when a dependency is down', async () => {
    ready = { status: 'not_ready', db: 'error', redis: 'ok', storage: 'ok' };
    const res = await fetch(`${base}/ready?probe=1`);
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual(ready);
  });

  it.each([
    ['GET', '/'],
    ['GET', '/health'],
    ['POST', '/ready'],
  ])('answers 404 to %s %s', async (method, path) => {
    const res = await fetch(`${base}${path}`, { method });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: { code: 'not_found', message: 'Not found' },
    });
  });

  it('stops listening on shutdown', async () => {
    await server.onModuleDestroy();
    await expect(fetch(`${base}/ready`)).rejects.toThrow();
  });
});
