import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  QUEUE_SERVICE,
  type QueueService,
} from '../../common/queue/queue.types.js';
import type { RetentionUpdateJob } from '../settings/settings-admin.service.js';
import {
  ErasureService,
  type ErasureHideJob,
  type ErasurePurgeJob,
} from './erasure.service.js';
import { ExportService, type ExportJobData } from './export.service.js';
import { RetentionService } from './retention.service.js';

/** The workspace runs on India time (data residency, plan §13). */
export const PURGE_TIME_ZONE = 'Asia/Kolkata';

/** One nightly purge per calendar day, e.g. `purge-20261015`, so several API pods enqueue it once. */
export function purgeJobId(now: Date): string {
  const day = now.toLocaleDateString('en-CA', { timeZone: PURGE_TIME_ZONE });
  return `purge-${day.replaceAll('-', '')}`;
}

/** Registers the privacy queues (plan §8) and schedules the nightly purge. */
@Injectable()
export class PrivacyProcessor implements OnModuleInit {
  constructor(
    @Inject(QUEUE_SERVICE) private readonly queue: QueueService,
    private readonly retention: RetentionService,
    private readonly exports: ExportService,
    private readonly erasure: ErasureService,
  ) {}

  onModuleInit(): void {
    this.queue.process('purge', () => this.retention.purge());
    this.queue.process<RetentionUpdateJob, number>('retention-update', (job) =>
      this.retention.updateAudioExpiry(job.audioRetentionDays),
    );
    this.queue.process<ExportJobData, void>(
      'export',
      (job) => this.exports.run(job),
      { concurrency: 2 },
    );
    this.queue.process<ErasureHideJob, void>('erasure-hide', (job) =>
      this.erasure.hide(job),
    );
    this.queue.process<ErasurePurgeJob, void>('erasure-purge', (job) =>
      this.erasure.purge(job.userId),
    );
  }

  @Cron('0 2 * * *', { name: 'retention-purge', timeZone: PURGE_TIME_ZONE })
  async schedulePurge(now = new Date()): Promise<void> {
    await this.queue.add('purge', {}, { jobId: purgeJobId(now) });
  }
}
