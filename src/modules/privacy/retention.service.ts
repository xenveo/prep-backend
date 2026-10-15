import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  STORAGE_ADAPTER,
  type StorageAdapter,
} from '../../adapters/storage/storage.adapter.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { WorkspaceSettingsData } from '../settings/settings.schema.js';
import { SettingsService } from '../settings/settings.service.js';
import { unsharedAudioKeys } from './audio-cleanup.js';
import { ErasureService } from './erasure.service.js';
import { deleteExportFiles, EXPORT_LINK_TTL_SEC } from './export-files.js';

const BATCH = 500;
const AUTH_CODE_MAX_AGE_MS = 24 * 3600 * 1000;

export type PurgeResult = {
  audioAttempts: number;
  objectsDeleted: number;
  transcriptsCleared: number;
  invitesExpired: number;
  authCodesDeleted: number;
  exportsExpired: number;
  erasuresPurged: number;
};

/** Attempts submitted before this lose their transcript; null keeps transcripts until the candidate is removed. */
export function transcriptCutoff(
  retention: WorkspaceSettingsData['transcriptRetention'],
  now: Date,
): Date | null {
  if (retention === 'until_removed') return null;
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - (retention === '6m' ? 6 : 12));
  return cutoff;
}

/** Nightly retention purge and audio re-dating (NFR-06, plan §8 `purge` / `retention-update`). */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly erasure: ErasureService,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
  ) {}

  /** The `purge` job. */
  async purge(now = new Date()): Promise<PurgeResult> {
    const db = this.prisma.unfiltered;
    const settings = await this.settings.get();
    const audio = await this.purgeExpiredAudio(now);

    const cutoff = transcriptCutoff(settings.transcriptRetention, now);
    const transcriptsCleared = cutoff ? await this.clearAnswerText(cutoff) : 0;

    const invites = await db.invite.updateMany({
      where: { status: 'pending', expiresAt: { lt: now } },
      data: { status: 'expired' },
    });
    const codes = await db.authCode.deleteMany({
      where: {
        createdAt: { lt: new Date(now.getTime() - AUTH_CODE_MAX_AGE_MS) },
      },
    });
    const exportsExpired = await this.expireExportFiles(now);

    // Safety net: erasures whose delayed purge job was lost (Redis flush, restore from backup).
    const overdue = await db.erasureReceipt.findMany({
      where: { purgeAfter: { lt: now }, purgedAt: null },
      select: { subjectId: true },
    });
    for (const r of overdue) await this.erasure.purge(r.subjectId, now);

    const result: PurgeResult = {
      ...audio,
      transcriptsCleared,
      invitesExpired: invites.count,
      authCodesDeleted: codes.count,
      exportsExpired,
      erasuresPurged: overdue.length,
    };
    this.logger.log(`Retention purge done ${JSON.stringify(result)}`);
    return result;
  }

  /**
   * The `retention-update` job: re-dates audio still stored to `submittedAt + days`. A shorter
   * period makes some audio already expired; the next nightly purge deletes it.
   */
  async updateAudioExpiry(days: number): Promise<number> {
    const updated = await this.prisma.$executeRaw`
      UPDATE "attempts"
      SET "audio_expires_at" = "submitted_at" + make_interval(days => ${days}::int)
      WHERE "audio_key" IS NOT NULL OR "feedback_audio_key" IS NOT NULL`;
    this.logger.log(
      `Audio expiry re-dated for ${updated} attempts (${days} days)`,
    );
    return updated;
  }

  /**
   * Transcript retention: drops everything that repeats the answer verbatim, in one statement.
   * `transcript`, `words` and `evidence` become NULL; in `feedback`, `highlights` becomes [] and
   * each `applied[].evidence` becomes "". Scores and the coaching text (worked, improve, opener,
   * focus, improvementPoints, applied point/status) stay. Rows already stripped are not touched.
   */
  async clearAnswerText(cutoff: Date): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE "attempts"
      SET "transcript" = NULL,
          "words" = NULL,
          "evidence" = NULL,
          "feedback" = CASE
            WHEN jsonb_typeof("feedback") <> 'object' THEN "feedback"
            ELSE ("feedback" || '{"highlights": []}'::jsonb)
              || CASE WHEN jsonb_typeof("feedback"->'applied') = 'array'
                   THEN jsonb_build_object('applied', COALESCE((
                     SELECT jsonb_agg(CASE WHEN jsonb_typeof(e) = 'object'
                                           THEN e || '{"evidence": ""}'::jsonb ELSE e END
                                      ORDER BY i)
                     FROM jsonb_array_elements("feedback"->'applied') WITH ORDINALITY AS a(e, i)
                   ), '[]'::jsonb))
                   ELSE '{}'::jsonb END
          END
      WHERE "submitted_at" < ${cutoff}
        AND ("transcript" IS NOT NULL
          OR "words" IS NOT NULL
          OR "evidence" IS NOT NULL
          OR COALESCE(jsonb_array_length(
               CASE WHEN jsonb_typeof("feedback"->'highlights') = 'array'
                    THEN "feedback"->'highlights' END), 0) > 0
          OR (jsonb_typeof("feedback"->'applied') = 'array' AND EXISTS (
               SELECT 1 FROM jsonb_array_elements("feedback"->'applied') AS a(e)
               WHERE jsonb_typeof(e) = 'object' AND COALESCE(e->>'evidence', '') <> '')))`;
  }

  /** Deletes answer and feedback audio past `audioExpiresAt` and nulls the keys, in batches. */
  private async purgeExpiredAudio(
    now: Date,
  ): Promise<{ audioAttempts: number; objectsDeleted: number }> {
    const db = this.prisma.unfiltered;
    let audioAttempts = 0;
    let objectsDeleted = 0;
    for (;;) {
      const batch = await db.attempt.findMany({
        where: {
          audioExpiresAt: { lt: now },
          OR: [
            { audioKey: { not: null } },
            { feedbackAudioKey: { not: null } },
          ],
        },
        select: { id: true, audioKey: true, feedbackAudioKey: true },
        take: BATCH,
      });
      if (batch.length === 0) break;

      const ids = batch.map((a) => a.id);
      const answers = batch.flatMap((a) => (a.audioKey ? [a.audioKey] : []));
      const feedback = await unsharedAudioKeys(
        db,
        batch.flatMap((a) => (a.feedbackAudioKey ? [a.feedbackAudioKey] : [])),
        ids,
      );
      const keys = [...new Set([...answers, ...feedback])];
      await Promise.all(keys.map((k) => this.storage.delete(k)));
      await db.attempt.updateMany({
        where: { id: { in: ids } },
        data: { audioKey: null, feedbackAudioKey: null },
      });
      audioAttempts += batch.length;
      objectsDeleted += keys.length;
      if (batch.length < BATCH) break;
    }
    return { audioAttempts, objectsDeleted };
  }

  /** Export downloads are promised for 24 hours; after that the files (personal data) are deleted. */
  private async expireExportFiles(now: Date): Promise<number> {
    const db = this.prisma.unfiltered;
    const stale = await db.exportJob.findMany({
      where: {
        fileKey: { not: null },
        finishedAt: {
          lt: new Date(now.getTime() - EXPORT_LINK_TTL_SEC * 1000),
        },
      },
      select: { id: true, fileKey: true },
    });
    for (const job of stale)
      await deleteExportFiles(this.storage, job.fileKey!);
    if (stale.length > 0)
      await db.exportJob.updateMany({
        where: { id: { in: stale.map((j) => j.id) } },
        data: { fileKey: null },
      });
    return stale.length;
  }
}
