import type { AuditService } from '../../common/audit/audit.service.js';
import { encodeKeyset } from '../../common/pagination/pagination.js';
import type { QueueService } from '../../common/queue/queue.types.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { DEFAULT_WORKSPACE_SETTINGS } from '../settings/settings.schema.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { ExportService } from './export.service.js';
import { PrivacyService } from './privacy.service.js';

const ID = '6f1c2b8e-1d2a-4c3b-9a4e-5f6a7b8c9d0e';
const CREATED = new Date('2026-10-14T09:00:00Z');

function setup(opts: {
  canDelete?: boolean;
  pending?: { id: string } | null;
  request?: Record<string, unknown> | null;
  /** The in-flight candidate export job, if any. */
  exportJob?: { id: string } | null;
  /** Rows updated by the pending → completed transition (0 = another admin won the race). */
  updatedCount?: number;
}) {
  const tx = {
    privacyRequest: {
      updateMany: vi.fn().mockResolvedValue({ count: opts.updatedCount ?? 1 }),
    },
  };
  const prisma = {
    privacyRequest: {
      findFirst: vi.fn().mockResolvedValue(opts.pending ?? null),
      findUnique: vi.fn().mockResolvedValue(opts.request ?? null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({ id: 'p-new' }),
    },
    exportJob: {
      findFirst: vi.fn().mockResolvedValue(opts.exportJob ?? null),
    },
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const settings = {
    get: vi.fn().mockResolvedValue({
      ...DEFAULT_WORKSPACE_SETTINGS,
      candidatesCanDeleteData: opts.canDelete ?? true,
    }),
  };
  const exports = { startCandidateExport: vi.fn().mockResolvedValue('e1') };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const queue = { add: vi.fn().mockResolvedValue({ jobId: 'j' }) };
  const service = new PrivacyService(
    prisma as unknown as PrismaService,
    settings as unknown as SettingsService,
    exports as unknown as ExportService,
    audit as unknown as AuditService,
    queue as unknown as QueueService,
  );
  return { service, prisma, exports, audit, queue, tx };
}

describe('PrivacyService', () => {
  it('deletion request is forbidden when the workspace turned it off', async () => {
    const { service, prisma } = setup({ canDelete: false });
    await expect(service.requestDeletion('u1')).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
    });
    expect(prisma.privacyRequest.create).not.toHaveBeenCalled();
  });

  it('deletion request is idempotent while one is pending', async () => {
    const fresh = setup({});
    await expect(fresh.service.requestDeletion('u1')).resolves.toEqual({
      requestId: 'p-new',
    });
    expect(fresh.prisma.privacyRequest.create).toHaveBeenCalledWith({
      data: { userId: 'u1', kind: 'deletion', status: 'pending' },
    });

    const again = setup({ pending: { id: 'p-old' } });
    await expect(again.service.requestDeletion('u1')).resolves.toEqual({
      requestId: 'p-old',
    });
    expect(again.prisma.privacyRequest.create).not.toHaveBeenCalled();
  });

  it('export request queues the candidate bundle once', async () => {
    const { service, exports } = setup({});
    await expect(service.requestExport('u1')).resolves.toEqual({
      requestId: 'p-new',
    });
    expect(exports.startCandidateExport).toHaveBeenCalledWith(
      'u1',
      'u1',
      'p-new',
    );

    const again = setup({ pending: { id: 'p-old' } });
    await again.service.requestExport('u1');
    expect(again.exports.startCandidateExport).not.toHaveBeenCalled();
  });

  const request = (kind: string, status = 'pending') => ({
    id: ID,
    userId: 'u1',
    kind,
    status,
    createdAt: CREATED,
    completedAt: null,
    completedBy: null,
    user: { name: 'Asha', email: 'asha@example.test' },
  });

  it('completing a deletion starts erasure stage 1 and audits it', async () => {
    const { service, queue, audit, tx } = setup({
      request: request('deletion'),
    });
    const view = await service.complete(ID, 'sa1', '1.1.1.1');
    expect(tx.privacyRequest.updateMany).toHaveBeenCalledWith({
      where: { id: ID, status: 'pending' },
      data: expect.objectContaining({
        status: 'completed',
        completedBy: 'sa1',
      }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      {
        actorId: 'sa1',
        action: 'Completed deletion request',
        entity: 'user',
        entityId: 'u1',
        itemLabel: 'Asha',
        ip: '1.1.1.1',
      },
      tx,
    );
    expect(queue.add).toHaveBeenCalledWith(
      'erasure-hide',
      { userId: 'u1', requestedBy: 'sa1', requestedAt: CREATED.toISOString() },
      { jobId: 'erasure-hide-u1', attempts: 3 },
    );
    expect(view).toMatchObject({
      status: 'completed',
      email: 'asha@example.test',
    });
  });

  it('completing an export runs the candidate export', async () => {
    const { service, exports, queue, prisma } = setup({
      request: request('export'),
    });
    await service.complete(ID, 'sa1', null);
    expect(prisma.exportJob.findFirst).toHaveBeenCalledWith({
      where: {
        subjectId: 'u1',
        kind: 'candidate_json',
        status: { in: ['queued', 'running'] },
      },
      select: { id: true },
    });
    expect(exports.startCandidateExport).toHaveBeenCalledWith('u1', 'sa1');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('409 and no state change when the candidate export is already in flight', async () => {
    const { service, exports, audit, prisma, tx } = setup({
      request: request('export'),
      exportJob: { id: 'e-running' },
    });
    await expect(service.complete(ID, 'sa1', null)).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      message: 'An export for this candidate is already in progress',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.privacyRequest.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(exports.startCandidateExport).not.toHaveBeenCalled();
  });

  it.each(['deletion', 'export'])(
    'a concurrent %s completion loses the race with a 409 and no side effects',
    async (kind) => {
      const { service, exports, audit, queue } = setup({
        request: request(kind),
        updatedCount: 0,
      });
      await expect(service.complete(ID, 'sa1', null)).rejects.toMatchObject({
        code: 'conflict',
        message: 'This request has already been handled',
      });
      expect(audit.record).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
      expect(exports.startCandidateExport).not.toHaveBeenCalled();
    },
  );

  it('lists newest first and ANDs the keyset onto the pending-or-recent OR', async () => {
    const { service, prisma } = setup({});
    const now = new Date('2026-10-16T00:00:00Z');
    const since = new Date('2026-09-16T00:00:00Z');
    const filter = {
      OR: [{ status: 'pending' }, { createdAt: { gte: since } }],
    };
    const cursor = encodeKeyset({ at: CREATED, id: ID });
    await service.list({ limit: 10, cursor }, now);
    expect(prisma.privacyRequest.findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          filter,
          {
            OR: [
              { createdAt: { lt: CREATED } },
              { createdAt: CREATED, id: { lt: ID } },
            ],
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 11,
      include: { user: { select: { name: true, email: true } } },
    });
    expect(prisma.privacyRequest.count).toHaveBeenCalledWith({ where: filter });
  });

  it('pages with a cursor past the last row only when more rows exist', async () => {
    const rows = [0, 1, 2].map((n) => ({
      ...request('export'),
      id: `00000000-0000-4000-8000-00000000000${n}`,
      createdAt: new Date(CREATED.getTime() - n * 1000),
    }));
    const { service, prisma } = setup({});
    prisma.privacyRequest.findMany.mockResolvedValue(rows);
    prisma.privacyRequest.count.mockResolvedValue(3);
    const first = await service.list({ limit: 2 });
    expect(first.rows.map((r) => r.id)).toEqual([rows[0].id, rows[1].id]);
    expect(first.total).toBe(3);
    expect(first.nextCursor).toBe(
      encodeKeyset({ at: rows[1].createdAt, id: rows[1].id }),
    );

    prisma.privacyRequest.findMany.mockResolvedValue(rows.slice(2));
    const last = await service.list({ limit: 2, cursor: first.nextCursor! });
    expect(last.rows).toHaveLength(1);
    expect(last.nextCursor).toBeNull();
  });

  it('a malformed list cursor is a 400', async () => {
    const { service, prisma } = setup({});
    await expect(
      service.list({ limit: 10, cursor: 'garbage' }),
    ).rejects.toMatchObject({ code: 'validation_failed', status: 400 });
    expect(prisma.privacyRequest.findMany).not.toHaveBeenCalled();
  });

  it('404 for unknown or malformed ids, 409 when already handled', async () => {
    await expect(
      setup({}).service.complete(ID, 'sa1', null),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      setup({}).service.complete('x', 'sa1', null),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      setup({ request: request('deletion', 'completed') }).service.complete(
        ID,
        'sa1',
        null,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});
