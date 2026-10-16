import { Logger } from '@nestjs/common';
import type { EventBus } from '../../common/events/event-bus.types.js';
import type { RedisService } from '../../common/infra/redis.service.js';
import type { QueueService } from '../../common/queue/queue.types.js';
import type { AppConfig } from '../../config/app-config.js';
import { STALE_RUN_MS } from '../../modules/interview/pipeline/attempt-pipeline.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import {
  ATTEMPT_SWEEP_INTERVAL_MS,
  EXPORT_STALE_MS,
  EXPORT_SWEEP_INTERVAL_MS,
  MAX_SWEEPS,
  RecoveryService,
} from './recovery.service.js';

const NOW = new Date('2026-10-16T10:00:00Z');
const SUBMITTED = new Date('2026-10-16T09:50:00Z');

function setup(
  opts: {
    role?: 'all' | 'api' | 'worker';
    redisClient?: Record<string, ReturnType<typeof vi.fn>>;
  } = {},
) {
  const prisma = {
    exportJob: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    attempt: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const queue = { add: vi.fn().mockResolvedValue({ jobId: 'j' }) };
  const events = { publish: vi.fn().mockResolvedValue(undefined) };
  const redis = {
    client: opts.redisClient ?? null,
    key: (...parts: string[]) => ['preppilot', ...parts].join(':'),
  };
  const config = { env: { PROCESS_ROLE: opts.role ?? 'worker' } };
  const service = new RecoveryService(
    prisma as unknown as PrismaService,
    redis as unknown as RedisService,
    config as unknown as AppConfig,
    queue as unknown as QueueService,
    events as unknown as EventBus,
  );
  return { service, prisma, queue, events };
}

describe('RecoveryService', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('exports', () => {
    it('re-enqueues queued/running exports older than 10 min with the export service job id', async () => {
      const { service, prisma, queue } = setup();
      prisma.exportJob.findMany.mockResolvedValue([
        { id: 'e1', requestedBy: 'admin-1', subjectId: null },
      ]);
      await expect(service.sweepExports(NOW)).resolves.toEqual({
        requeued: 1,
        failed: 0,
      });
      expect(prisma.exportJob.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: { in: ['queued', 'running'] },
            createdAt: { lt: new Date(NOW.getTime() - EXPORT_STALE_MS) },
          },
        }),
      );
      expect(queue.add).toHaveBeenCalledWith(
        'export',
        { exportJobId: 'e1' },
        { jobId: 'export-e1', attempts: 3, backoffMs: 5000 },
      );
    });

    it('marks an export failed on the sweep after the third', async () => {
      const { service, prisma, queue } = setup();
      prisma.exportJob.findMany.mockResolvedValue([
        { id: 'e1', requestedBy: 'admin-1', subjectId: null },
      ]);
      for (let i = 0; i < MAX_SWEEPS; i++) await service.sweepExports(NOW);
      expect(queue.add).toHaveBeenCalledTimes(MAX_SWEEPS);
      expect(prisma.exportJob.updateMany).not.toHaveBeenCalled();

      await expect(service.sweepExports(NOW)).resolves.toEqual({
        requeued: 0,
        failed: 1,
      });
      expect(queue.add).toHaveBeenCalledTimes(MAX_SWEEPS);
      expect(prisma.exportJob.updateMany).toHaveBeenCalledWith({
        where: { id: 'e1', status: { in: ['queued', 'running'] } },
        data: { status: 'failed', finishedAt: NOW },
      });
    });

    it('skips exports of erased requesters or subjects', async () => {
      const { service, prisma, queue } = setup();
      prisma.exportJob.findMany.mockResolvedValue([
        { id: 'e1', requestedBy: 'u-gone', subjectId: 'u-gone' },
        { id: 'e2', requestedBy: 'admin-1', subjectId: 'u-gone' },
        { id: 'e3', requestedBy: 'admin-1', subjectId: 'u-ok' },
      ]);
      prisma.user.findMany.mockResolvedValue([{ id: 'u-gone' }]);
      await service.sweepExports(NOW);
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['u-gone', 'admin-1', 'u-ok'] },
          deletedAt: { not: null },
        },
        select: { id: true },
      });
      expect(queue.add.mock.calls.map((c) => c[2].jobId)).toEqual([
        'export-e3',
      ]);
    });
  });

  describe('attempts', () => {
    const row = {
      id: 'a1',
      sessionId: 's1',
      submittedAt: SUBMITTED,
      mode: 'voice',
    };
    const jobId = `attempt-s1-a1-${SUBMITTED.getTime().toString(36)}`;

    it('re-enqueues in-flight attempts idle for STALE_RUN_MS, skipping erased users', async () => {
      const { service, prisma, queue } = setup();
      prisma.attempt.findMany.mockResolvedValue([row]);
      await expect(service.sweepAttempts(NOW)).resolves.toEqual({
        requeued: 1,
        failed: 0,
      });
      expect(prisma.attempt.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: { in: ['received', 'transcribing', 'evaluating'] },
            updatedAt: { lt: new Date(NOW.getTime() - STALE_RUN_MS) },
            session: { user: { deletedAt: null } },
          },
        }),
      );
      expect(queue.add).toHaveBeenCalledWith(
        'attempt',
        { attemptId: 'a1' },
        { jobId: `${jobId}-r1`, attempts: 1 },
      );
      await service.sweepAttempts(NOW);
      expect(queue.add).toHaveBeenLastCalledWith(
        'attempt',
        { attemptId: 'a1' },
        { jobId: `${jobId}-r2`, attempts: 1 },
      );
    });

    it('fails a stuck attempt after three sweeps and pushes attempt.failed', async () => {
      const { service, prisma, queue, events } = setup();
      prisma.attempt.findMany.mockResolvedValue([row]);
      for (let i = 0; i < MAX_SWEEPS; i++) await service.sweepAttempts(NOW);
      expect(events.publish).not.toHaveBeenCalled();

      await expect(service.sweepAttempts(NOW)).resolves.toEqual({
        requeued: 0,
        failed: 1,
      });
      expect(queue.add).toHaveBeenCalledTimes(MAX_SWEEPS);
      expect(prisma.attempt.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'a1',
          status: { in: ['received', 'transcribing', 'evaluating'] },
          updatedAt: { lt: new Date(NOW.getTime() - STALE_RUN_MS) },
        },
        data: { status: 'failed', error: 'ai_unavailable' },
      });
      expect(events.publish).toHaveBeenCalledWith('session:s1', {
        type: 'attempt.failed',
        attemptId: 'a1',
        code: 'ai_unavailable',
        retryable: true,
        textModeOffered: true,
      });
    });

    it('publishes nothing when the attempt moved on before it could be failed', async () => {
      const { service, prisma, events } = setup();
      prisma.attempt.findMany.mockResolvedValue([row]);
      prisma.attempt.updateMany.mockResolvedValue({ count: 0 });
      for (let i = 0; i <= MAX_SWEEPS; i++) await service.sweepAttempts(NOW);
      expect(prisma.attempt.updateMany).toHaveBeenCalledOnce();
      expect(events.publish).not.toHaveBeenCalled();
    });
  });

  describe('with Redis', () => {
    const client = () => ({
      set: vi.fn().mockResolvedValue('OK'),
      incr: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
      del: vi.fn().mockResolvedValue(1),
    });

    it('namespaces the per-kind locks and sweep counters', async () => {
      const redis = client();
      const { service, prisma } = setup({ redisClient: redis });
      prisma.exportJob.findMany.mockResolvedValue([
        { id: 'e1', requestedBy: 'admin-1', subjectId: null },
      ]);
      prisma.attempt.findMany.mockResolvedValue([
        { id: 'a1', sessionId: 's1', submittedAt: SUBMITTED, mode: 'text' },
      ]);
      await service.sweepExports(NOW);
      await service.sweepAttempts(NOW);

      expect(redis.set.mock.calls).toEqual([
        ['preppilot:recovery:lock:export', '1', 'PX', 5 * 60 * 1000, 'NX'],
        ['preppilot:recovery:lock:attempt', '1', 'PX', STALE_RUN_MS / 2, 'NX'],
      ]);
      expect(redis.incr.mock.calls.map((c) => c[0])).toEqual([
        'preppilot:recovery:export:e1',
        'preppilot:recovery:attempt:a1',
      ]);
      expect(redis.expire).toHaveBeenCalledWith(
        'preppilot:recovery:export:e1',
        24 * 3600,
      );
    });

    it('keeps lock TTLs shorter than their intervals', async () => {
      const redis = client();
      const { service } = setup({ redisClient: redis });
      await service.sweepExports(NOW);
      await service.sweepAttempts(NOW);
      const [exportTtl, attemptTtl] = redis.set.mock.calls.map((c) => c[3]);
      expect(exportTtl).toBeLessThan(EXPORT_SWEEP_INTERVAL_MS);
      expect(attemptTtl).toBeLessThan(ATTEMPT_SWEEP_INTERVAL_MS);
    });

    it('skips only the kind whose lock another worker holds', async () => {
      const redis = client();
      redis.set.mockImplementation((key: string) =>
        Promise.resolve(key.endsWith(':export') ? null : 'OK'),
      );
      const { service, prisma } = setup({ redisClient: redis });
      await expect(service.sweepExports(NOW)).resolves.toBeNull();
      await expect(service.sweepAttempts(NOW)).resolves.toEqual({
        requeued: 0,
        failed: 0,
      });
      expect(prisma.exportJob.findMany).not.toHaveBeenCalled();
      expect(prisma.attempt.findMany).toHaveBeenCalledOnce();
    });

    it('fails a row once the shared counter passes the limit and clears it', async () => {
      const redis = client();
      redis.incr.mockResolvedValue(MAX_SWEEPS + 1);
      const { service, prisma, queue } = setup({ redisClient: redis });
      prisma.exportJob.findMany.mockResolvedValue([
        { id: 'e1', requestedBy: 'admin-1', subjectId: null },
      ]);
      await service.sweepExports(NOW);
      expect(queue.add).not.toHaveBeenCalled();
      expect(prisma.exportJob.updateMany).toHaveBeenCalledOnce();
      expect(redis.del).toHaveBeenCalledWith('preppilot:recovery:export:e1');
    });
  });

  describe('scheduling', () => {
    it('sweeps both on boot, then attempts every STALE_RUN_MS and exports hourly', async () => {
      vi.useFakeTimers();
      const { service, prisma } = setup({ role: 'worker' });
      service.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      expect(prisma.exportJob.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.attempt.findMany).toHaveBeenCalledTimes(1);

      expect(ATTEMPT_SWEEP_INTERVAL_MS).toBe(STALE_RUN_MS);
      await vi.advanceTimersByTimeAsync(ATTEMPT_SWEEP_INTERVAL_MS);
      expect(prisma.attempt.findMany).toHaveBeenCalledTimes(2);
      expect(prisma.exportJob.findMany).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(
        EXPORT_SWEEP_INTERVAL_MS - ATTEMPT_SWEEP_INTERVAL_MS,
      );
      expect(prisma.exportJob.findMany).toHaveBeenCalledTimes(2);
      expect(prisma.attempt.findMany).toHaveBeenCalledTimes(
        1 + EXPORT_SWEEP_INTERVAL_MS / ATTEMPT_SWEEP_INTERVAL_MS,
      );
      service.onModuleDestroy();
    });

    it('surfaces a lost attempt as attempt.failed within about 8 minutes', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const { service, prisma, events } = setup({ role: 'worker' });
      prisma.attempt.findMany.mockResolvedValue([
        { id: 'a1', sessionId: 's1', submittedAt: SUBMITTED, mode: 'voice' },
      ]);
      service.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(MAX_SWEEPS * ATTEMPT_SWEEP_INTERVAL_MS);
      expect(events.publish).toHaveBeenCalledWith(
        'session:s1',
        expect.objectContaining({ type: 'attempt.failed', attemptId: 'a1' }),
      );
      service.onModuleDestroy();
    });

    it('clears both timers on destroy', async () => {
      vi.useFakeTimers();
      const { service, prisma } = setup({ role: 'all' });
      service.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(2);
      service.onModuleDestroy();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(EXPORT_SWEEP_INTERVAL_MS);
      expect(prisma.exportJob.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.attempt.findMany).toHaveBeenCalledTimes(1);
    });

    it('does nothing in the api role', async () => {
      vi.useFakeTimers();
      const { service, prisma } = setup({ role: 'api' });
      service.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(EXPORT_SWEEP_INTERVAL_MS);
      expect(vi.getTimerCount()).toBe(0);
      expect(prisma.exportJob.findMany).not.toHaveBeenCalled();
      expect(prisma.attempt.findMany).not.toHaveBeenCalled();
    });

    it('logs a failed sweep without stopping the other kind or later passes', async () => {
      vi.useFakeTimers();
      const { service, prisma } = setup({ role: 'all' });
      prisma.exportJob.findMany.mockRejectedValueOnce(new Error('db down'));
      service.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        'Recovery sweep exports failed (Error)',
      );
      expect(prisma.attempt.findMany).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(EXPORT_SWEEP_INTERVAL_MS);
      expect(prisma.exportJob.findMany).toHaveBeenCalledTimes(2);
      service.onModuleDestroy();
    });
  });
});
