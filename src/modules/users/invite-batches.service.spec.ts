import type { PrismaService } from '../../prisma/prisma.service.js';
import { InviteBatchesService } from './invite-batches.service.js';

function setup() {
  const prisma = {
    inviteBatch: { findUnique: vi.fn() },
    invite: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const service = new InviteBatchesService(prisma as unknown as PrismaService);
  return { prisma, service };
}

describe('InviteBatchesService', () => {
  afterEach(() => vi.useRealTimers());

  it('returns 404 for an unknown batch before querying invitations', async () => {
    const { prisma, service } = setup();
    prisma.inviteBatch.findUnique.mockResolvedValue(null);
    await expect(service.status('missing')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
    expect(prisma.invite.findMany).not.toHaveBeenCalled();
  });

  it('counts lifecycle by expiry, excludes erased candidates and never selects secrets', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const { prisma, service } = setup();
    prisma.inviteBatch.findUnique.mockResolvedValue({
      id: 'batch-1',
      createdAt: new Date('2026-11-01T12:00:00Z'),
      source: 'csv',
      fileName: 'candidates.csv',
      createdBy: 'admin-1',
      sent: 6,
      skipped: 2,
    });
    prisma.invite.findMany.mockResolvedValue([
      { status: 'pending', expiresAt: new Date('2026-11-03T12:00:00Z') },
      { status: 'pending', expiresAt: new Date('2026-11-02T12:00:00Z') },
      { status: 'accepted', expiresAt: new Date('2026-11-01T12:00:00Z') },
      { status: 'revoked', expiresAt: new Date('2026-11-01T12:00:00Z') },
      { status: 'expired', expiresAt: new Date('2026-11-01T12:00:00Z') },
    ]);

    const result = await service.status('batch-1');
    expect(result).toMatchObject({
      batchId: 'batch-1',
      createdAt: '2026-11-01T12:00:00.000Z',
      created: 6,
      skipped: 2,
      lifecycle: { pending: 1, accepted: 1, expired: 2, revoked: 1 },
      delivery: { status: 'unavailable' },
    });
    expect(prisma.invite.findMany).toHaveBeenCalledWith({
      where: { batchId: 'batch-1', user: { deletedAt: null } },
      select: { status: true, expiresAt: true },
    });
    expect(
      prisma.inviteBatch.findUnique.mock.calls[0][0].select,
    ).not.toHaveProperty('invites');
    expect(JSON.stringify(result)).not.toContain('token');
  });
});
