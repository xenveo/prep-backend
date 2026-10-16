import { Logger } from '@nestjs/common';
import type { RedisService } from '../../common/infra/redis.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { HealthService, REDIS_PING_TIMEOUT_MS } from './health.service.js';

describe('HealthService', () => {
  const dbOk = {
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  } as unknown as PrismaService;
  const redis = (ping?: () => Promise<string>) =>
    ({ client: ping ? { ping } : null }) as unknown as RedisService;

  beforeEach(() =>
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
  );
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports db ok and redis disabled without REDIS_URL', async () => {
    await expect(new HealthService(dbOk, redis()).check()).resolves.toEqual({
      status: 'ok',
      db: 'ok',
      redis: 'disabled',
    });
  });

  it('reports db error without throwing', async () => {
    const prisma = { $queryRaw: vi.fn().mockRejectedValue(new Error('down')) };
    await expect(
      new HealthService(prisma as unknown as PrismaService, redis()).check(),
    ).resolves.toEqual({ status: 'ok', db: 'error', redis: 'disabled' });
  });

  it('reports redis ok when PING answers', async () => {
    const ping = vi.fn().mockResolvedValue('PONG');
    await expect(new HealthService(dbOk, redis(ping)).check()).resolves.toEqual(
      { status: 'ok', db: 'ok', redis: 'ok' },
    );
    expect(ping).toHaveBeenCalledOnce();
  });

  it('reports redis error when PING fails, and stays live', async () => {
    const ping = () => Promise.reject(new Error('ECONNREFUSED'));
    await expect(new HealthService(dbOk, redis(ping)).check()).resolves.toEqual(
      { status: 'ok', db: 'ok', redis: 'error' },
    );
  });

  it('reports redis error when PING hangs past the timeout', async () => {
    vi.useFakeTimers();
    const check = new HealthService(
      dbOk,
      redis(() => new Promise(() => {})),
    ).check();
    await vi.advanceTimersByTimeAsync(REDIS_PING_TIMEOUT_MS);
    await expect(check).resolves.toEqual({
      status: 'ok',
      db: 'ok',
      redis: 'error',
    });
  });
});
