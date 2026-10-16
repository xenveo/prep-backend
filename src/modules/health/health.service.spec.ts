import { Logger } from '@nestjs/common';
import type { StorageAdapter } from '../../adapters/storage/storage.adapter.js';
import type { RedisService } from '../../common/infra/redis.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import {
  CHECK_TIMEOUT_MS,
  HealthService,
  STORAGE_PROBE_KEY,
} from './health.service.js';

type Probe = 'ok' | 'error' | 'hang';

const answer =
  <T>(probe: Probe, value: T) =>
  () =>
    probe === 'ok'
      ? Promise.resolve(value)
      : probe === 'error'
        ? Promise.reject(new Error('down'))
        : new Promise<T>(() => {});

function service(db: Probe, redis: Probe | 'unset', storage: Probe = 'ok') {
  const prisma = { $queryRaw: vi.fn(answer(db, [{ '?column?': 1 }])) };
  const ping = vi.fn(redis === 'unset' ? undefined : answer(redis, 'PONG'));
  const exists = vi.fn(answer(storage, false));
  const health = new HealthService(
    prisma as unknown as PrismaService,
    { client: redis === 'unset' ? null : { ping } } as unknown as RedisService,
    { exists } as unknown as StorageAdapter,
  );
  return { health, prisma, ping, exists };
}

describe('HealthService', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('check (liveness)', () => {
    it('reports db ok and redis disabled without REDIS_URL', async () => {
      await expect(service('ok', 'unset').health.check()).resolves.toEqual({
        status: 'ok',
        db: 'ok',
        redis: 'disabled',
      });
    });

    it('reports db error without throwing', async () => {
      await expect(service('error', 'unset').health.check()).resolves.toEqual({
        status: 'ok',
        db: 'error',
        redis: 'disabled',
      });
    });

    it('reports redis ok when PING answers', async () => {
      const { health, ping } = service('ok', 'ok');
      await expect(health.check()).resolves.toEqual({
        status: 'ok',
        db: 'ok',
        redis: 'ok',
      });
      expect(ping).toHaveBeenCalledOnce();
    });

    it('reports redis error when PING fails, and stays live', async () => {
      await expect(service('ok', 'error').health.check()).resolves.toEqual({
        status: 'ok',
        db: 'ok',
        redis: 'error',
      });
    });

    it('does not touch storage', async () => {
      const { health, exists } = service('ok', 'ok');
      await health.check();
      expect(exists).not.toHaveBeenCalled();
    });
  });

  describe('ready', () => {
    it.each([
      ['ok', 'ok', 'ok', 'ready', 'ok'],
      ['ok', 'unset', 'ok', 'ready', 'disabled'],
      ['error', 'ok', 'ok', 'not_ready', 'ok'],
      ['ok', 'error', 'ok', 'not_ready', 'error'],
      ['ok', 'ok', 'error', 'not_ready', 'ok'],
      ['ok', 'unset', 'error', 'not_ready', 'disabled'],
      ['error', 'error', 'error', 'not_ready', 'error'],
    ] as const)(
      'db %s, redis %s, storage %s → %s',
      async (db, redis, storage, status, redisField) => {
        await expect(
          service(db, redis, storage).health.ready(),
        ).resolves.toEqual({ status, db, redis: redisField, storage });
      },
    );

    it('probes storage with exists() on the sentinel key', async () => {
      const { health, exists } = service('ok', 'ok');
      await health.ready();
      expect(exists).toHaveBeenCalledWith(STORAGE_PROBE_KEY);
    });

    it('marks every hanging dependency as error after one shared timeout', async () => {
      vi.useFakeTimers();
      const ready = service('hang', 'hang', 'hang').health.ready();
      await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
      await expect(ready).resolves.toEqual({
        status: 'not_ready',
        db: 'error',
        redis: 'error',
        storage: 'error',
      });
    });

    it('logs the failing dependency by name and error message only', async () => {
      await service('ok', 'ok', 'error').health.ready();
      expect(warn).toHaveBeenCalledWith('Storage health check failed (down)');
    });
  });
});
