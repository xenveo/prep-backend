import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  STORAGE_ADAPTER,
  type StorageAdapter,
} from '../../adapters/storage/storage.adapter.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { sha256Hex } from '../../common/crypto.js';
import {
  QUEUE_SERVICE,
  type QueueService,
} from '../../common/queue/queue.types.js';
import { EmailService } from '../../jobs/email/email.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { UsersService } from '../users/users.service.js';
import { unsharedAudioKeys } from './audio-cleanup.js';
import { deleteExportFiles } from './export-files.js';

export type ErasureHideJob = {
  userId: string;
  /** The super admin who actioned the deletion. */
  requestedBy: string;
  /** When the candidate asked (ISO). Defaults to the time the job runs. */
  requestedAt?: string;
};

export type ErasurePurgeJob = { userId: string };

export const erasurePurgeJobId = (userId: string) => `erasure-purge-${userId}`;

const DAY_MS = 86_400_000;

/**
 * DPDP Act 2023 two-stage erasure (plan §4, §8, §13). Stage 1 hides the user at once and deletes
 * their audio; stage 2 hard-deletes every row and file after the grace period. Both stages are
 * idempotent: a retry or a second run repeats only what is left to do.
 */
@Injectable()
export class ErasureService {
  private readonly logger = new Logger(ErasureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    @Inject(QUEUE_SERVICE) private readonly queue: QueueService,
  ) {}

  /** Stage 1 (`erasure-hide`). */
  async hide(job: ErasureHideJob, now = new Date()): Promise<void> {
    const db = this.prisma.unfiltered;
    const user = await db.user.findUnique({
      where: { id: job.userId },
      select: { id: true, email: true, deletedAt: true },
    });
    if (!user) {
      this.logger.warn(`Erasure hide skipped: user ${job.userId} not found`);
      return;
    }

    const hiddenAt = user.deletedAt ?? now;
    if (!user.deletedAt)
      await db.user.update({
        where: { id: user.id },
        data: { deletedAt: hiddenAt },
      });
    await this.users.revokeSessions(user.id);

    const sessionIds = await this.sessionIdsOf(user.id);
    // Cancel queued pipeline work first so it can't write new audio after the delete below.
    for (const id of sessionIds)
      await this.queue.removeByPrefix('attempt', `attempt-${id}`);
    const objects = await this.deleteAudio(sessionIds);

    const graceDays = (await this.settings.get()).erasureGraceDays;
    const open = await db.erasureReceipt.findFirst({
      where: { subjectId: user.id, purgedAt: null },
      orderBy: { hiddenAt: 'desc' },
    });
    const receipt = open
      ? await db.erasureReceipt.update({
          where: { id: open.id },
          data: { s3ObjectsDeleted: (open.s3ObjectsDeleted ?? 0) + objects },
        })
      : await db.erasureReceipt.create({
          data: {
            subjectId: user.id,
            emailSha256: sha256Hex(user.email.toLowerCase()),
            requestedBy: job.requestedBy,
            requestedAt: job.requestedAt ? new Date(job.requestedAt) : now,
            hiddenAt,
            purgeAfter: new Date(hiddenAt.getTime() + graceDays * DAY_MS),
            s3ObjectsDeleted: objects,
          },
        });

    await this.queue.add<ErasurePurgeJob>(
      'erasure-purge',
      { userId: user.id },
      {
        jobId: erasurePurgeJobId(user.id),
        delayMs: Math.max(0, receipt.purgeAfter.getTime() - now.getTime()),
      },
    );
    this.logger.log(
      `Erasure stage 1 done for user ${user.id} (${objects} objects deleted)`,
    );
  }

  /** Stage 2 (`erasure-purge`). A run with no user left is a no-op that still finalises the receipt. */
  async purge(userId: string, now = new Date()): Promise<void> {
    const db = this.prisma.unfiltered;
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { email: true, deletedAt: true },
    });
    if (user && !user.deletedAt) {
      this.logger.warn(`Erasure purge skipped: user ${userId} is not hidden`);
      return;
    }
    const receipt = await db.erasureReceipt.findFirst({
      where: { subjectId: userId },
      orderBy: { hiddenAt: 'desc' },
    });

    let objects = 0;
    if (user)
      objects += await this.deleteAudio(await this.sessionIdsOf(userId));
    objects += await this.deleteExports(userId, receipt?.hiddenAt ?? now);

    if (user) {
      // Cascades: invites, auth sessions, assignments, card views, sessions → attempts, consents,
      // flags; activity, privacy requests, saved filters. ai_call_logs keep their rows with ids nulled.
      await db.user.deleteMany({ where: { id: userId } });
      await db.authCode.deleteMany({ where: { email: user.email } });
      await db.invite.deleteMany({ where: { email: user.email } });
    }
    await this.audit.redactSubject(userId);

    if (receipt && !receipt.purgedAt) {
      await db.erasureReceipt.update({
        where: { id: receipt.id },
        data: {
          purgedAt: now,
          s3ObjectsDeleted: (receipt.s3ObjectsDeleted ?? 0) + objects,
        },
      });
    }
    // When run early (safety net, tests), drop the delayed job so it doesn't run again.
    await this.queue.removeByPrefix('erasure-purge', erasurePurgeJobId(userId));

    if (user) {
      await this.email.send({
        template: 'erasure-complete',
        to: user.email,
        vars: {},
      });
    }
    this.logger.log(
      `Erasure stage 2 done for user ${userId} (${objects} objects deleted)`,
    );
  }

  private async sessionIdsOf(userId: string): Promise<string[]> {
    const sessions = await this.prisma.unfiltered.session.findMany({
      where: { userId },
      select: { id: true },
    });
    return sessions.map((s) => s.id);
  }

  /**
   * Deletes everything under `audio/<sessionId>/` (answers, and feedback audio stored per session),
   * plus feedback audio stored elsewhere that no one else uses, then nulls the attempts' keys.
   */
  private async deleteAudio(sessionIds: string[]): Promise<number> {
    if (sessionIds.length === 0) return 0;
    const db = this.prisma.unfiltered;
    let count = 0;
    for (const id of sessionIds)
      count += await this.storage.deletePrefix(`audio/${id}/`);

    const attempts = await db.attempt.findMany({
      where: { sessionId: { in: sessionIds }, feedbackAudioKey: { not: null } },
      select: { id: true, feedbackAudioKey: true },
    });
    const outside = attempts
      .map((a) => a.feedbackAudioKey!)
      .filter((k) => !sessionIds.some((id) => k.startsWith(`audio/${id}/`)));
    const deletable = await unsharedAudioKeys(
      db,
      outside,
      attempts.map((a) => a.id),
    );
    await Promise.all(deletable.map((k) => this.storage.delete(k)));
    count += deletable.length;

    await db.attempt.updateMany({
      where: {
        sessionId: { in: sessionIds },
        OR: [{ audioKey: { not: null } }, { feedbackAudioKey: { not: null } }],
      },
      data: { audioKey: null, feedbackAudioKey: null },
    });
    return count;
  }

  /**
   * The user's own export jobs and files go entirely. Workspace CSV exports made before they were
   * hidden list them too, so those files are deleted (the job rows stay, with no file).
   */
  private async deleteExports(userId: string, hiddenAt: Date): Promise<number> {
    const db = this.prisma.unfiltered;
    let count = 0;
    const own = await db.exportJob.findMany({
      where: { OR: [{ subjectId: userId }, { requestedBy: userId }] },
      select: { id: true, fileKey: true },
    });
    for (const job of own)
      if (job.fileKey)
        count += await deleteExportFiles(this.storage, job.fileKey);
    if (own.length > 0)
      await db.exportJob.deleteMany({
        where: { id: { in: own.map((j) => j.id) } },
      });

    const workspace = await db.exportJob.findMany({
      where: {
        kind: 'workspace_csv',
        fileKey: { not: null },
        createdAt: { lte: hiddenAt },
      },
      select: { id: true, fileKey: true },
    });
    for (const job of workspace)
      count += await deleteExportFiles(this.storage, job.fileKey!);
    if (workspace.length > 0)
      await db.exportJob.updateMany({
        where: { id: { in: workspace.map((j) => j.id) } },
        data: { fileKey: null },
      });
    return count;
  }
}
