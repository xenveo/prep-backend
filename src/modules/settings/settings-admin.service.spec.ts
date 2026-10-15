import type { AuditService } from '../../common/audit/audit.service.js';
import type { QueueService } from '../../common/queue/queue.types.js';
import type { TtsCacheService } from '../content/tts-cache.service.js';
import { SettingsAdminService } from './settings-admin.service.js';
import {
  DEFAULT_WORKSPACE_SETTINGS,
  SETTINGS_FIELD_AUDIT,
  type WorkspaceSettingsData,
} from './settings.schema.js';
import { SettingsService } from './settings.service.js';

function setup(after: Partial<WorkspaceSettingsData>) {
  const before = DEFAULT_WORKSPACE_SETTINGS;
  const merged = { ...before, ...after };
  const settings = {
    update: vi.fn().mockResolvedValue({ before, after: merged }),
    get: vi.fn().mockResolvedValue(before),
    toAdminView: SettingsService.prototype.toAdminView,
  };
  const audit = { recordFieldChanges: vi.fn().mockResolvedValue(1) };
  const queue = { add: vi.fn().mockResolvedValue({ jobId: 'j' }) };
  const tts = {
    getOrCreate: vi
      .fn()
      .mockResolvedValue({ key: 'tts/abc.mp3', durationS: 3 }),
    signedUrl: vi.fn().mockResolvedValue('https://signed/abc'),
  };
  const service = new SettingsAdminService(
    settings as unknown as SettingsService,
    audit as unknown as AuditService,
    tts as unknown as TtsCacheService,
    queue as unknown as QueueService,
  );
  return { service, settings, audit, queue, tts, before, merged };
}

describe('SettingsAdminService', () => {
  it('saves, audits each field change and returns the admin view', async () => {
    const { service, settings, audit, before, merged } = setup({
      senderName: 'Acme',
    });
    const view = await service.update(
      { senderName: 'Acme' },
      'adm1',
      '1.2.3.4',
    );
    expect(settings.update).toHaveBeenCalledWith({ senderName: 'Acme' });
    expect(audit.recordFieldChanges).toHaveBeenCalledWith(
      {
        actorId: 'adm1',
        entity: 'workspace_settings',
        entityId: null,
        ip: '1.2.3.4',
      },
      SETTINGS_FIELD_AUDIT,
      before,
      merged,
    );
    expect(view.senderName).toBe('Acme');
    expect(view).not.toHaveProperty('erasureGraceDays');
  });

  it('enqueues retention-update only when audio retention changes', async () => {
    const changed = setup({ audioRetentionDays: 7 });
    await changed.service.update({ audioRetentionDays: 7 }, 'adm1', null);
    expect(changed.queue.add).toHaveBeenCalledWith('retention-update', {
      audioRetentionDays: 7,
    });

    const same = setup({ voice: 'Warm, lower pitch' });
    await same.service.update({ voice: 'Warm, lower pitch' }, 'adm1', null);
    expect(same.queue.add).not.toHaveBeenCalled();
  });

  it('labels settings changes the way the admin UI does', () => {
    const retention = SETTINGS_FIELD_AUDIT.find(
      (f) => f.key === 'audioRetentionDays',
    )!;
    expect(retention.action).toBe('Changed audio retention');
    expect(retention.show!(90)).toBe('90 days');
  });

  it('voice sample: signed URL for a known voice, 404 otherwise', async () => {
    const { service, tts } = setup({});
    await expect(service.voiceSampleUrl('Calm, mid-pitch')).resolves.toBe(
      'https://signed/abc',
    );
    expect(tts.getOrCreate).toHaveBeenCalledWith(expect.any(String), {
      voice: 'Calm, mid-pitch',
    });
    await expect(service.voiceSampleUrl('Robot')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
