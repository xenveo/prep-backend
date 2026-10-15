import type { StorageAdapter } from '../../adapters/storage/storage.adapter.js';
import type { AuditService } from '../../common/audit/audit.service.js';
import { sha256Hex } from '../../common/crypto.js';
import type { QueueService } from '../../common/queue/queue.types.js';
import type { EmailService } from '../../jobs/email/email.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { DEFAULT_WORKSPACE_SETTINGS } from '../settings/settings.schema.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { UsersService } from '../users/users.service.js';
import { ErasureService } from './erasure.service.js';

const NOW = new Date('2026-10-15T10:00:00Z');
const DAY = 86_400_000;

type Receipt = {
  id: string;
  subjectId: string;
  hiddenAt: Date;
  purgeAfter: Date;
  purgedAt: Date | null;
  s3ObjectsDeleted: number | null;
};

function setup(opts: {
  user?: { id: string; email: string; deletedAt: Date | null } | null;
  sessions?: string[];
  feedback?: { id: string; feedbackAudioKey: string }[];
  receipt?: Receipt | null;
  ownExports?: { id: string; fileKey: string | null }[];
  workspaceExports?: { id: string; fileKey: string }[];
}) {
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue(opts.user ?? null),
      update: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    session: {
      findMany: vi
        .fn()
        .mockResolvedValue((opts.sessions ?? []).map((id) => ({ id }))),
    },
    attempt: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce(opts.feedback ?? [])
        .mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    question: { findMany: vi.fn().mockResolvedValue([]) },
    erasureReceipt: {
      findFirst: vi.fn().mockResolvedValue(opts.receipt ?? null),
      create: vi
        .fn()
        .mockImplementation(({ data }) =>
          Promise.resolve({ id: 'r1', ...data }),
        ),
      update: vi
        .fn()
        .mockImplementation(({ data }) =>
          Promise.resolve({ ...opts.receipt, ...data }),
        ),
    },
    exportJob: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce(opts.ownExports ?? [])
        .mockResolvedValueOnce(opts.workspaceExports ?? []),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    authCode: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    invite: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
  const prisma = { unfiltered: db };
  const settings = {
    get: vi
      .fn()
      .mockResolvedValue({
        ...DEFAULT_WORKSPACE_SETTINGS,
        erasureGraceDays: 7,
      }),
  };
  const users = { revokeSessions: vi.fn().mockResolvedValue(2) };
  const audit = { redactSubject: vi.fn().mockResolvedValue(3) };
  const email = { send: vi.fn().mockResolvedValue(undefined) };
  const storage = {
    deletePrefix: vi.fn().mockResolvedValue(2),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const queue = {
    add: vi.fn().mockResolvedValue({ jobId: 'j' }),
    removeByPrefix: vi.fn().mockResolvedValue(0),
  };
  const service = new ErasureService(
    prisma as unknown as PrismaService,
    settings as unknown as SettingsService,
    users as unknown as UsersService,
    audit as unknown as AuditService,
    email as unknown as EmailService,
    storage as unknown as StorageAdapter,
    queue as unknown as QueueService,
  );
  return { service, db, users, audit, email, storage, queue };
}

describe('ErasureService.hide (stage 1)', () => {
  const user = { id: 'u1', email: 'Asha@Example.test', deletedAt: null };

  it('hides the user, revokes logins, cancels jobs, deletes audio and writes a receipt', async () => {
    const { service, db, users, storage, queue } = setup({
      user,
      sessions: ['s1', 's2'],
      feedback: [
        { id: 'a1', feedbackAudioKey: 'tts/own.mp3' },
        { id: 'a2', feedbackAudioKey: 'audio/s1/a2-feedback.mp3' },
      ],
    });
    await service.hide(
      {
        userId: 'u1',
        requestedBy: 'sa1',
        requestedAt: '2026-10-14T09:00:00.000Z',
      },
      NOW,
    );

    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { deletedAt: NOW },
    });
    expect(users.revokeSessions).toHaveBeenCalledWith('u1');
    expect(queue.removeByPrefix).toHaveBeenCalledWith('attempt', 'attempt-s1');
    expect(queue.removeByPrefix).toHaveBeenCalledWith('attempt', 'attempt-s2');
    expect(storage.deletePrefix).toHaveBeenCalledWith('audio/s1/');
    expect(storage.deletePrefix).toHaveBeenCalledWith('audio/s2/');
    // Feedback outside the session folders, not shared with anyone: deleted.
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith('tts/own.mp3');
    expect(db.attempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { audioKey: null, feedbackAudioKey: null },
      }),
    );
    expect(db.erasureReceipt.create).toHaveBeenCalledWith({
      data: {
        subjectId: 'u1',
        emailSha256: sha256Hex('asha@example.test'),
        requestedBy: 'sa1',
        requestedAt: new Date('2026-10-14T09:00:00.000Z'),
        hiddenAt: NOW,
        purgeAfter: new Date(NOW.getTime() + 7 * DAY),
        s3ObjectsDeleted: 5,
      },
    });
    expect(queue.add).toHaveBeenCalledWith(
      'erasure-purge',
      { userId: 'u1' },
      { jobId: 'erasure-purge-u1', delayMs: 7 * DAY },
    );
  });

  it('keeps shared TTS cache objects that another attempt still uses', async () => {
    const { service, db, storage } = setup({
      user,
      sessions: ['s1'],
      feedback: [{ id: 'a1', feedbackAudioKey: 'tts/shared.mp3' }],
    });
    db.attempt.findMany
      .mockReset()
      .mockResolvedValueOnce([{ id: 'a1', feedbackAudioKey: 'tts/shared.mp3' }])
      .mockResolvedValueOnce([{ feedbackAudioKey: 'tts/shared.mp3' }]);
    await service.hide({ userId: 'u1', requestedBy: 'sa1' }, NOW);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('is idempotent: an existing open receipt is reused, not duplicated', async () => {
    const hiddenAt = new Date(NOW.getTime() - DAY);
    const receipt: Receipt = {
      id: 'r1',
      subjectId: 'u1',
      hiddenAt,
      purgeAfter: new Date(hiddenAt.getTime() + 7 * DAY),
      purgedAt: null,
      s3ObjectsDeleted: 4,
    };
    const { service, db, queue } = setup({
      user: { ...user, deletedAt: hiddenAt },
      receipt,
    });
    await service.hide({ userId: 'u1', requestedBy: 'sa1' }, NOW);
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.erasureReceipt.create).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      'erasure-purge',
      { userId: 'u1' },
      { jobId: 'erasure-purge-u1', delayMs: 6 * DAY },
    );
  });

  it('does nothing for an unknown user', async () => {
    const { service, users, queue } = setup({ user: null });
    await service.hide({ userId: 'nope', requestedBy: 'sa1' }, NOW);
    expect(users.revokeSessions).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('ErasureService.purge (stage 2)', () => {
  const hiddenAt = new Date('2026-10-08T10:00:00Z');
  const receipt: Receipt = {
    id: 'r1',
    subjectId: 'u1',
    hiddenAt,
    purgeAfter: NOW,
    purgedAt: null,
    s3ObjectsDeleted: 4,
  };

  it('hard-deletes the user, their codes, invites and exports, redacts audit, finalises the receipt, emails', async () => {
    const { service, db, audit, email, storage, queue } = setup({
      user: { id: 'u1', email: 'asha@example.test', deletedAt: hiddenAt },
      sessions: ['s1'],
      receipt,
      ownExports: [{ id: 'e1', fileKey: 'exports/e1.json' }],
      workspaceExports: [{ id: 'w1', fileKey: 'exports/w1/' }],
    });
    await service.purge('u1', NOW);

    expect(storage.deletePrefix).toHaveBeenCalledWith('audio/s1/');
    expect(storage.delete).toHaveBeenCalledWith('exports/e1.json');
    expect(db.exportJob.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['e1'] } },
    });
    expect(db.exportJob.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ createdAt: { lte: hiddenAt } }),
      }),
    );
    expect(storage.deletePrefix).toHaveBeenCalledWith('exports/w1/');
    expect(db.user.deleteMany).toHaveBeenCalledWith({ where: { id: 'u1' } });
    expect(db.authCode.deleteMany).toHaveBeenCalledWith({
      where: { email: 'asha@example.test' },
    });
    expect(db.invite.deleteMany).toHaveBeenCalledWith({
      where: { email: 'asha@example.test' },
    });
    expect(audit.redactSubject).toHaveBeenCalledWith('u1');
    expect(db.erasureReceipt.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { purgedAt: NOW, s3ObjectsDeleted: 4 + 2 + 1 + 2 },
    });
    expect(queue.removeByPrefix).toHaveBeenCalledWith(
      'erasure-purge',
      'erasure-purge-u1',
    );
    expect(email.send).toHaveBeenCalledWith({
      template: 'erasure-complete',
      to: 'asha@example.test',
      vars: {},
    });
  });

  it('a second run with no user left is a no-op that still finalises the receipt', async () => {
    const { service, db, audit, email } = setup({ user: null, receipt });
    await service.purge('u1', NOW);
    expect(db.user.deleteMany).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
    expect(audit.redactSubject).toHaveBeenCalledWith('u1');
    expect(db.erasureReceipt.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { purgedAt: NOW, s3ObjectsDeleted: 4 },
    });
  });

  it('leaves an already purged receipt alone', async () => {
    const { service, db } = setup({
      user: null,
      receipt: { ...receipt, purgedAt: NOW },
    });
    await service.purge('u1', NOW);
    expect(db.erasureReceipt.update).not.toHaveBeenCalled();
  });

  it('refuses to purge a user who was never hidden', async () => {
    const { service, db, audit } = setup({
      user: { id: 'u1', email: 'a@x.test', deletedAt: null },
    });
    await service.purge('u1', NOW);
    expect(db.user.deleteMany).not.toHaveBeenCalled();
    expect(audit.redactSubject).not.toHaveBeenCalled();
  });
});
