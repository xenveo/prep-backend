import type { AuditService } from '../../common/audit/audit.service.js';
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
}) {
  const tx = {
    privacyRequest: {
      update: vi
        .fn()
        .mockImplementation(({ data }) =>
          Promise.resolve({ ...opts.request, ...data }),
        ),
    },
  };
  const prisma = {
    privacyRequest: {
      findFirst: vi.fn().mockResolvedValue(opts.pending ?? null),
      findUnique: vi.fn().mockResolvedValue(opts.request ?? null),
      create: vi.fn().mockResolvedValue({ id: 'p-new' }),
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
    expect(tx.privacyRequest.update).toHaveBeenCalledWith({
      where: { id: ID },
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
    const { service, exports, queue } = setup({ request: request('export') });
    await service.complete(ID, 'sa1', null);
    expect(exports.startCandidateExport).toHaveBeenCalledWith('u1', 'sa1');
    expect(queue.add).not.toHaveBeenCalled();
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
