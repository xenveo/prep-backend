import { AppError } from '../../common/errors/app-error.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { DEFAULT_WORKSPACE_SETTINGS } from './settings.schema.js';
import { SettingsService } from './settings.service.js';

function mockPrisma(data: unknown) {
  return {
    workspaceSettings: {
      findUnique: vi
        .fn()
        .mockResolvedValue(data === undefined ? null : { id: 1, data }),
      upsert: vi.fn().mockResolvedValue({}),
    },
  };
}

describe('SettingsService', () => {
  it('defaults match the admin UI sample data and backend targets', () => {
    expect(DEFAULT_WORKSPACE_SETTINGS).toEqual({
      voice: 'Calm, mid-pitch',
      feedbackLength: 'standard',
      language: 'en',
      audioRetentionDays: 30,
      transcriptRetention: '12m',
      candidatesCanDeleteData: true,
      senderName: 'PrepPilot for [Company]',
      replyTo: '[reply-to@company.com]',
      inviteLinkExpiryDays: 7,
      lastExportAt: null,
      erasureGraceDays: 7,
      deliveryTargets: {
        pace: { min: 120, max: 160, scaleMin: 80, scaleMax: 200 },
        fillers: { min: 0, max: 4, scaleMin: 0, scaleMax: 12 },
        pauses: { min: 3, max: 6, scaleMin: 0, scaleMax: 8 },
      },
    });
  });

  it('returns defaults when no row exists', async () => {
    const service = new SettingsService(
      mockPrisma(undefined) as unknown as PrismaService,
    );
    await expect(service.get()).resolves.toEqual(DEFAULT_WORKSPACE_SETTINGS);
  });

  it('merges stored values over defaults, including partial delivery targets', async () => {
    const prisma = mockPrisma({
      audioRetentionDays: 90,
      deliveryTargets: {
        pace: { min: 110, max: 150, scaleMin: 80, scaleMax: 200 },
      },
    });
    const settings = await new SettingsService(
      prisma as unknown as PrismaService,
    ).get();
    expect(settings.audioRetentionDays).toBe(90);
    expect(settings.voice).toBe('Calm, mid-pitch');
    expect(settings.deliveryTargets.pace.min).toBe(110);
    expect(settings.deliveryTargets.fillers).toEqual(
      DEFAULT_WORKSPACE_SETTINGS.deliveryTargets.fillers,
    );
  });

  it('falls back to the default for an invalid stored field', async () => {
    const prisma = mockPrisma({ audioRetentionDays: 45, senderName: 'Acme' });
    const settings = await new SettingsService(
      prisma as unknown as PrismaService,
    ).get();
    expect(settings.audioRetentionDays).toBe(30);
    expect(settings.senderName).toBe('Acme');
  });

  it('caches reads for about 30 seconds', async () => {
    vi.useFakeTimers();
    const prisma = mockPrisma({});
    const service = new SettingsService(prisma as unknown as PrismaService);
    await service.get();
    await service.get();
    expect(prisma.workspaceSettings.findUnique).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    await service.get();
    expect(prisma.workspaceSettings.findUnique).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('update validates, upserts, returns before/after and clears the cache', async () => {
    const prisma = mockPrisma({ audioRetentionDays: 90 });
    const service = new SettingsService(prisma as unknown as PrismaService);
    await service.get();
    const { before, after } = await service.update({
      audioRetentionDays: 7,
      replyTo: 'hr@acme.com',
    });
    expect(before.audioRetentionDays).toBe(90);
    expect(after).toMatchObject({
      audioRetentionDays: 7,
      replyTo: 'hr@acme.com',
      language: 'en',
    });
    expect(prisma.workspaceSettings.upsert).toHaveBeenCalledWith({
      where: { id: 1 },
      create: { id: 1, data: after },
      update: { data: after },
    });
    await service.get();
    expect(prisma.workspaceSettings.findUnique).toHaveBeenCalledTimes(3);
  });

  it('update rejects invalid values with validation_failed', async () => {
    const service = new SettingsService(
      mockPrisma({}) as unknown as PrismaService,
    );
    await expect(
      service.update({ replyTo: 'not-an-email' }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      service.update({ audioRetentionDays: 14 as never }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('toAdminView drops backend-only fields', () => {
    const service = new SettingsService(
      mockPrisma({}) as unknown as PrismaService,
    );
    const view = service.toAdminView(DEFAULT_WORKSPACE_SETTINGS);
    expect(view).not.toHaveProperty('erasureGraceDays');
    expect(view).not.toHaveProperty('deliveryTargets');
    expect(view.senderName).toBe('PrepPilot for [Company]');
  });
});
