import type { Response } from 'express';
import { HealthController } from './health.controller.js';
import type { HealthService, ReadyStatus } from './health.service.js';

describe('HealthController.ready', () => {
  const run = async (status: ReadyStatus) => {
    const res = { status: vi.fn() };
    const controller = new HealthController({
      ready: () => Promise.resolve(status),
    } as unknown as HealthService);
    const body = await controller.ready(res as unknown as Response);
    return { body, code: res.status.mock.calls[0]?.[0] };
  };

  it('answers 200 when ready', async () => {
    const status: ReadyStatus = {
      status: 'ready',
      db: 'ok',
      redis: 'disabled',
      storage: 'ok',
    };
    await expect(run(status)).resolves.toEqual({ body: status, code: 200 });
  });

  it('answers 503 with the same body when not ready', async () => {
    const status: ReadyStatus = {
      status: 'not_ready',
      db: 'ok',
      redis: 'error',
      storage: 'ok',
    };
    await expect(run(status)).resolves.toEqual({ body: status, code: 503 });
  });
});
