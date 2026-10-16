import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  EVENT_BUS,
  sessionChannel,
  type EventBus,
  type SessionEvent,
} from '../../common/events/event-bus.types.js';
import { RedisService } from '../../common/infra/redis.service.js';
import {
  QUEUE_SERVICE,
  type QueueService,
} from '../../common/queue/queue.types.js';
import { AppConfig } from '../../config/app-config.js';
import { attemptJobId } from '../../modules/interview/attempts.service.js';
import { STALE_RUN_MS } from '../../modules/interview/pipeline/attempt-pipeline.service.js';
import type { AttemptJob } from '../../modules/interview/types.js';
import type { ExportJobData } from '../../modules/privacy/export.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/** Exports are slow and rare; an hourly look is enough. */
export const EXPORT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** A candidate is waiting on the attempt: re-check as often as a run can go stale. */
export const ATTEMPT_SWEEP_INTERVAL_MS = STALE_RUN_MS;
/** An export still queued or running this long after creation lost its job. */
export const EXPORT_STALE_MS = 10 * 60 * 1000;
/** Sweeps that re-enqueue a stuck row; the next one marks it failed. */
export const MAX_SWEEPS = 3;
/** Sweep counters outlive the sweeps that need them, then expire on their own. */
const SWEEP_COUNT_TTL_SEC = 24 * 3600;
const BATCH = 500;

type SweepKind = 'export' | 'attempt';
type SweepCounts = { requeued: number; failed: number };

/**
 * Each lock is held (never released) for less than its interval, so workers that boot or tick
 * together sweep, and count, the same rows once per interval.
 */
const SCHEDULE: Record<SweepKind, { intervalMs: number; lockMs: number }> = {
  export: { intervalMs: EXPORT_SWEEP_INTERVAL_MS, lockMs: 5 * 60 * 1000 },
  attempt: { intervalMs: ATTEMPT_SWEEP_INTERVAL_MS, lockMs: STALE_RUN_MS / 2 },
};

/** Matches ExportService's own enqueue (attempts, backoff), so the job behaves the same. */
const EXPORT_ATTEMPTS = 3;
const EXPORT_BACKOFF_MS = 5000;

const IN_FLIGHT_ATTEMPT = ['received', 'transcribing', 'evaluating'] as const;
const IN_FLIGHT_EXPORT = ['queued', 'running'];

/**
 * Recovers work whose queue job was lost (in-process queue restart) or ended while the DB status
 * lagged (plan 03 §4). Runs only where processors run (PROCESS_ROLE worker|all): both sweeps once on
 * boot, then exports hourly and attempts every STALE_RUN_MS, each under its own Redis lock.
 *
 * - Exports queued/running for 10 min are re-enqueued as `export-<id>`, the id ExportService uses,
 *   so a job that still exists absorbs the add. `privacyRequestId` isn't stored on the row, so a
 *   recovered candidate export leaves its privacy request pending for an admin to close.
 * - Attempts received/transcribing/evaluating for STALE_RUN_MS are re-enqueued as
 *   `<attemptJobId>-r<n>`; the pipeline's stale claim decides whether to run. The suffix is needed
 *   because BullMQ keeps finished jobs: a job that ended without moving the attempt on (a stalled
 *   re-run that saw a fresh claim) would otherwise swallow the add. The `attempt-<sessionId>` prefix
 *   still lets erasure cancel it.
 * - A row seen MAX_SWEEPS times is marked failed. A failed attempt pushes `attempt.failed` so the
 *   candidate UI offers a retry within minutes instead of waiting.
 * Rows of erased users are left alone.
 */
@Injectable()
export class RecoveryService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RecoveryService.name);
  private readonly localCounts = new Map<
    string,
    { n: number; expiresAt: number }
  >();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<SweepKind>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: AppConfig,
    @Inject(QUEUE_SERVICE) private readonly queue: QueueService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.env.PROCESS_ROLE === 'api') return;
    for (const kind of ['export', 'attempt'] as const) {
      void this.runSweep(kind);
      const timer = setInterval(
        () => void this.runSweep(kind),
        SCHEDULE[kind].intervalMs,
      );
      timer.unref();
      this.timers.push(timer);
    }
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
  }

  /** One export pass. Null when another worker holds the export lock. */
  async sweepExports(now = new Date()): Promise<SweepCounts | null> {
    return this.locked('export', () => this.recoverExports(now));
  }

  /** One attempt pass. Null when another worker holds the attempt lock. */
  async sweepAttempts(now = new Date()): Promise<SweepCounts | null> {
    return this.locked('attempt', () => this.recoverAttempts(now));
  }

  private async locked(
    kind: SweepKind,
    sweep: () => Promise<SweepCounts>,
  ): Promise<SweepCounts | null> {
    if (!(await this.acquireLock(kind))) return null;
    const counts = await sweep();
    const line = `Recovery sweep ${kind}s: requeued=${counts.requeued} failed=${counts.failed}`;
    if (counts.requeued + counts.failed > 0) this.logger.log(line);
    else this.logger.debug(line);
    return counts;
  }

  private async runSweep(kind: SweepKind): Promise<void> {
    if (this.running.has(kind)) return;
    this.running.add(kind);
    try {
      await (kind === 'export' ? this.sweepExports() : this.sweepAttempts());
    } catch (err) {
      this.logger.error(`Recovery sweep ${kind}s failed (${errName(err)})`);
    } finally {
      this.running.delete(kind);
    }
  }

  private async recoverExports(now: Date): Promise<SweepCounts> {
    const rows = await this.prisma.exportJob.findMany({
      where: {
        status: { in: IN_FLIGHT_EXPORT },
        createdAt: { lt: new Date(now.getTime() - EXPORT_STALE_MS) },
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
      select: { id: true, requestedBy: true, subjectId: true },
    });
    const erased = await this.erasedUserIds(
      rows.flatMap((r) =>
        r.subjectId ? [r.requestedBy, r.subjectId] : [r.requestedBy],
      ),
    );
    const counts = { requeued: 0, failed: 0 };
    for (const row of rows) {
      if (
        erased.has(row.requestedBy) ||
        (row.subjectId && erased.has(row.subjectId))
      )
        continue;
      const sweeps = await this.countSweep('export', row.id);
      if (sweeps > MAX_SWEEPS) {
        const { count } = await this.prisma.exportJob.updateMany({
          where: { id: row.id, status: { in: IN_FLIGHT_EXPORT } },
          data: { status: 'failed', finishedAt: now },
        });
        await this.clearSweeps('export', row.id);
        if (count === 0) continue;
        counts.failed++;
        this.logger.warn(
          `export ${row.id} marked failed after ${MAX_SWEEPS} recovery sweeps`,
        );
        continue;
      }
      await this.queue.add<ExportJobData>(
        'export',
        { exportJobId: row.id },
        {
          jobId: `export-${row.id}`,
          attempts: EXPORT_ATTEMPTS,
          backoffMs: EXPORT_BACKOFF_MS,
        },
      );
      counts.requeued++;
      this.logger.log(`export ${row.id} re-enqueued (sweep ${sweeps})`);
    }
    return counts;
  }

  private async recoverAttempts(now: Date): Promise<SweepCounts> {
    const staleBefore = new Date(now.getTime() - STALE_RUN_MS);
    const rows = await this.prisma.attempt.findMany({
      where: {
        status: { in: [...IN_FLIGHT_ATTEMPT] },
        updatedAt: { lt: staleBefore },
        session: { user: { deletedAt: null } },
      },
      orderBy: { updatedAt: 'asc' },
      take: BATCH,
      select: { id: true, sessionId: true, submittedAt: true, mode: true },
    });
    const counts = { requeued: 0, failed: 0 };
    for (const row of rows) {
      const sweeps = await this.countSweep('attempt', row.id);
      if (sweeps > MAX_SWEEPS) {
        // Only if it hasn't moved on since the read: a run that resumed bumps updatedAt.
        const { count } = await this.prisma.attempt.updateMany({
          where: {
            id: row.id,
            status: { in: [...IN_FLIGHT_ATTEMPT] },
            updatedAt: { lt: staleBefore },
          },
          data: { status: 'failed', error: 'ai_unavailable' },
        });
        await this.clearSweeps('attempt', row.id);
        if (count === 0) continue;
        counts.failed++;
        this.logger.warn(
          `attempt ${row.id} marked failed after ${MAX_SWEEPS} recovery sweeps`,
        );
        await this.publish(row.sessionId, {
          type: 'attempt.failed',
          attemptId: row.id,
          code: 'ai_unavailable',
          retryable: true,
          textModeOffered: row.mode === 'voice',
        });
        continue;
      }
      await this.queue.add<AttemptJob>(
        'attempt',
        { attemptId: row.id },
        { jobId: `${attemptJobId(row)}-r${sweeps}`, attempts: 1 },
      );
      counts.requeued++;
      this.logger.log(`attempt ${row.id} re-enqueued (sweep ${sweeps})`);
    }
    return counts;
  }

  private async erasedUserIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(ids)] }, deletedAt: { not: null } },
      select: { id: true },
    });
    return new Set(users.map((u) => u.id));
  }

  private async acquireLock(kind: SweepKind): Promise<boolean> {
    const client = this.redis.client;
    if (!client) return true;
    const ok = await client.set(
      this.redis.key('recovery', 'lock', kind),
      '1',
      'PX',
      SCHEDULE[kind].lockMs,
      'NX',
    );
    return ok === 'OK';
  }

  /** How many sweeps have seen this row, this one included. */
  private async countSweep(kind: SweepKind, id: string): Promise<number> {
    const client = this.redis.client;
    if (client) {
      const key = this.redis.key('recovery', kind, id);
      const n = await client.incr(key);
      await client.expire(key, SWEEP_COUNT_TTL_SEC);
      return n;
    }
    const key = `${kind}:${id}`;
    const now = Date.now();
    for (const [k, v] of this.localCounts)
      if (v.expiresAt <= now) this.localCounts.delete(k);
    const n = (this.localCounts.get(key)?.n ?? 0) + 1;
    this.localCounts.set(key, {
      n,
      expiresAt: now + SWEEP_COUNT_TTL_SEC * 1000,
    });
    return n;
  }

  private async clearSweeps(kind: SweepKind, id: string): Promise<void> {
    if (this.redis.client)
      await this.redis.client.del(this.redis.key('recovery', kind, id));
    else this.localCounts.delete(`${kind}:${id}`);
  }

  private async publish(sessionId: string, event: SessionEvent): Promise<void> {
    try {
      await this.events.publish(sessionChannel(sessionId), event);
    } catch (err) {
      // The state is in Postgres; the client can poll GET /attempts/:id.
      this.logger.warn(
        `publish ${event.type} failed for session ${sessionId} (${errName(err)})`,
      );
    }
  }
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
