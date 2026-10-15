import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import { notFound } from '../../common/errors/app-error.js';
import {
  QUEUE_SERVICE,
  type QueueService,
} from '../../common/queue/queue.types.js';
import { TtsCacheService } from '../content/tts-cache.service.js';
import {
  SETTINGS_FIELD_AUDIT,
  VOICE_OPTIONS,
  VOICE_SAMPLE_TEXT,
  type AdminWorkspaceSettings,
  type SettingsPatch,
} from './settings.schema.js';
import { SettingsService } from './settings.service.js';

/** `retention-update` job: recompute `audioExpiresAt` for attempts that still hold audio. */
export type RetentionUpdateJob = { audioRetentionDays: number };

/** Admin settings screen (spec "Workspace settings", plan §7 "Settings"). */
@Injectable()
export class SettingsAdminService {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly tts: TtsCacheService,
    @Inject(QUEUE_SERVICE) private readonly queue: QueueService,
  ) {}

  async view(): Promise<AdminWorkspaceSettings> {
    return this.settings.toAdminView(await this.settings.get());
  }

  /** Saves the patch, logs one audit row per changed field and re-dates stored audio if retention changed. */
  async update(
    patch: SettingsPatch,
    actorId: string,
    ip: string | null,
  ): Promise<AdminWorkspaceSettings> {
    const { before, after } = await this.settings.update(patch);
    await this.audit.recordFieldChanges(
      { actorId, entity: 'workspace_settings', entityId: null, ip },
      SETTINGS_FIELD_AUDIT,
      before,
      after,
    );
    if (before.audioRetentionDays !== after.audioRetentionDays) {
      await this.queue.add<RetentionUpdateJob>('retention-update', {
        audioRetentionDays: after.audioRetentionDays,
      });
    }
    return this.settings.toAdminView(after);
  }

  /** Signed URL of the sample sentence in a known voice; 404 for any other voice. */
  async voiceSampleUrl(voice: string): Promise<string> {
    if (!(VOICE_OPTIONS as readonly string[]).includes(voice))
      throw notFound('Unknown voice');
    const { key } = await this.tts.getOrCreate(VOICE_SAMPLE_TEXT, { voice });
    return this.tts.signedUrl(key);
  }
}
