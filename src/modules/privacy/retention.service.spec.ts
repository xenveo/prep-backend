import type { StorageAdapter } from '../../adapters/storage/storage.adapter.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { DEFAULT_WORKSPACE_SETTINGS } from '../settings/settings.schema.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { ErasureService } from './erasure.service.js';
import { RetentionService, transcriptCutoff } from './retention.service.js';

const NOW = new Date('2026-10-15T02:00:00Z');

function setup(opts: {
  expired?: {
    id: string;
    audioKey: string | null;
    feedbackAudioKey: string | null;
  }[];
  sharedFeedback?: string[];
  transcriptRetention?: '6m' | '12m' | 'until_removed';
  overdue?: string[];
  staleExports?: { id: string; fileKey: string }[];
}) {
  const attempt = {
    findMany: vi
      .fn()
      // 1st call: the expired batch; 2nd: other attempts sharing a tts key; then empty.
      .mockResolvedValueOnce(opts.expired ?? [])
      .mockResolvedValueOnce(
        (opts.sharedFeedback ?? []).map((k) => ({ feedbackAudioKey: k })),
      )
      .mockResolvedValue([]),
    updateMany: vi.fn().mockResolvedValue({ count: 4 }),
  };
  const db = {
    attempt,
    question: { findMany: vi.fn().mockResolvedValue([]) },
    invite: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    authCode: { deleteMany: vi.fn().mockResolvedValue({ count: 5 }) },
    exportJob: {
      findMany: vi.fn().mockResolvedValue(opts.staleExports ?? []),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    erasureReceipt: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          (opts.overdue ?? []).map((subjectId) => ({ subjectId })),
        ),
    },
    $executeRaw: vi.fn().mockResolvedValue(12),
  };
  const prisma = { ...db, unfiltered: db };
  const settings = {
    get: vi.fn().mockResolvedValue({
      ...DEFAULT_WORKSPACE_SETTINGS,
      transcriptRetention: opts.transcriptRetention ?? '12m',
    }),
  };
  const storage = {
    delete: vi.fn().mockResolvedValue(undefined),
    deletePrefix: vi.fn().mockResolvedValue(3),
  };
  const erasure = { purge: vi.fn().mockResolvedValue(undefined) };
  const service = new RetentionService(
    prisma as unknown as PrismaService,
    settings as unknown as SettingsService,
    erasure as unknown as ErasureService,
    storage as unknown as StorageAdapter,
  );
  return { service, db, storage, erasure };
}

describe('transcriptCutoff', () => {
  it('is 6 or 12 calendar months back, or none', () => {
    expect(transcriptCutoff('6m', NOW)).toEqual(
      new Date('2026-04-15T02:00:00Z'),
    );
    expect(transcriptCutoff('12m', NOW)).toEqual(
      new Date('2025-10-15T02:00:00Z'),
    );
    expect(transcriptCutoff('until_removed', NOW)).toBeNull();
  });
});

describe('RetentionService.purge', () => {
  it('deletes expired answer audio and unshared feedback audio, then nulls the keys', async () => {
    const { service, db, storage } = setup({
      expired: [
        {
          id: 'a1',
          audioKey: 'audio/s1/a1.webm',
          feedbackAudioKey: 'tts/x.mp3',
        },
        { id: 'a2', audioKey: null, feedbackAudioKey: 'tts/shared.mp3' },
      ],
      sharedFeedback: ['tts/shared.mp3'],
    });
    const result = await service.purge(NOW);
    expect(db.attempt.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          audioExpiresAt: { lt: NOW },
          OR: [
            { audioKey: { not: null } },
            { feedbackAudioKey: { not: null } },
          ],
        },
      }),
    );
    expect(storage.delete.mock.calls.map((c) => c[0]).sort()).toEqual([
      'audio/s1/a1.webm',
      'tts/x.mp3',
    ]);
    expect(db.attempt.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a1', 'a2'] } },
      data: { audioKey: null, feedbackAudioKey: null },
    });
    expect(result).toMatchObject({ audioAttempts: 2, objectsDeleted: 2 });
  });

  it('clears transcripts and verbatim quotes older than the retention period', async () => {
    const { service, db } = setup({ transcriptRetention: '6m' });
    const result = await service.purge(NOW);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = db.$executeRaw.mock.calls[0] as [
      string[],
      ...unknown[],
    ];
    const sql = strings.join('?');
    expect(values).toEqual([new Date('2026-04-15T02:00:00Z')]);
    expect(sql).toContain('"submitted_at" < ?');
    for (const set of [
      '"transcript" = NULL',
      '"words" = NULL',
      '"evidence" = NULL',
      `'{"highlights": []}'`,
      `'{"evidence": ""}'`,
    ])
      expect(sql).toContain(set);
    // Coaching text and scores are left alone.
    expect(sql).not.toMatch(
      /worked|improvementPoints|dimension_scores|"score"/,
    );
    expect(result.transcriptsCleared).toBe(12);
  });

  it('keeps transcripts when retention is "until removed"', async () => {
    const { service, db } = setup({ transcriptRetention: 'until_removed' });
    const result = await service.purge(NOW);
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(result.transcriptsCleared).toBe(0);
  });

  it('expires invites, deletes day-old auth codes and stale export files', async () => {
    const { service, db, storage } = setup({
      staleExports: [{ id: 'e1', fileKey: 'exports/e1/' }],
    });
    const result = await service.purge(NOW);
    expect(db.invite.updateMany).toHaveBeenCalledWith({
      where: { status: 'pending', expiresAt: { lt: NOW } },
      data: { status: 'expired' },
    });
    expect(db.authCode.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date('2026-10-14T02:00:00Z') } },
    });
    expect(storage.deletePrefix).toHaveBeenCalledWith('exports/e1/');
    expect(db.exportJob.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['e1'] } },
      data: { fileKey: null },
    });
    expect(result).toMatchObject({
      invitesExpired: 2,
      authCodesDeleted: 5,
      exportsExpired: 1,
    });
  });

  it('runs erasure-purge for overdue receipts as a safety net', async () => {
    const { service, erasure, db } = setup({ overdue: ['u1', 'u2'] });
    const result = await service.purge(NOW);
    expect(db.erasureReceipt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { purgeAfter: { lt: NOW }, purgedAt: null },
      }),
    );
    expect(erasure.purge).toHaveBeenCalledWith('u1', NOW);
    expect(erasure.purge).toHaveBeenCalledWith('u2', NOW);
    expect(result.erasuresPurged).toBe(2);
  });
});

describe('RetentionService.updateAudioExpiry', () => {
  it('re-dates stored audio from submittedAt', async () => {
    const { service, db } = setup({});
    await expect(service.updateAudioExpiry(7)).resolves.toBe(12);
    const sql = (db.$executeRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toContain('"submitted_at" + make_interval(days => ?::int)');
    expect(sql).toContain('"audio_key" IS NOT NULL');
    expect(db.$executeRaw.mock.calls[0][1]).toBe(7);
  });
});
