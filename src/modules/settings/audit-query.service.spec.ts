import type { PrismaService } from '../../prisma/prisma.service.js';
import { AuditQueryService, auditQuerySchema } from './audit-query.service.js';

const row = (id: string, actorId: string | null, entityId: string | null) => ({
  id,
  actorId,
  action: 'Approved role',
  entity: 'job_role',
  entityId,
  itemLabel: 'Data analyst',
  before: null,
  after: null,
  ip: null,
  at: new Date('2026-10-14T10:00:00Z'),
});

function setup() {
  const prisma = {
    auditLog: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          row('a1', 'u1', 'r1'),
          row('a2', null, null),
          row('a3', 'gone', null),
        ]),
      count: vi.fn().mockResolvedValue(3),
      groupBy: vi
        .fn()
        .mockResolvedValue([
          { action: 'Approved role' },
          { action: 'Sent 3 invites' },
        ]),
    },
    user: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: 'u1', name: 'Arjun', email: 'a@x.test' }]),
    },
  };
  return {
    prisma,
    service: new AuditQueryService(prisma as unknown as PrismaService),
  };
}

describe('AuditQueryService', () => {
  it('filters by actor, action and an inclusive date range, newest first', async () => {
    const { service, prisma } = setup();
    const query = auditQuerySchema.parse({
      actorId: '6f1c2b8e-1d2a-4c3b-9a4e-5f6a7b8c9d0e',
      action: 'Approved role',
      from: '2026-10-01',
      to: '2026-10-14',
    });
    await service.list(query);
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          actorId: '6f1c2b8e-1d2a-4c3b-9a4e-5f6a7b8c9d0e',
          action: 'Approved role',
          at: {
            gte: new Date('2026-10-01T00:00:00.000Z'),
            lt: new Date('2026-10-15T00:00:00.000Z'),
          },
        },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        skip: 0,
        take: 200,
      }),
    );
  });

  it('maps rows to AuditEvent with actor names, "System" otherwise', async () => {
    const { service } = setup();
    const page = await service.list(auditQuerySchema.parse({}));
    expect(page.total).toBe(3);
    expect(page.rows[0]).toEqual({
      id: 'a1',
      actorId: 'u1',
      actor: 'Arjun',
      action: 'Approved role',
      itemLabel: 'Data analyst',
      itemRef: 'r1',
      at: '2026-10-14T10:00:00.000Z',
    });
    expect(page.rows[1].actor).toBe('System');
    expect(page.rows[1]).not.toHaveProperty('itemRef');
    expect(page.rows[2].actor).toBe('System');
  });

  it('rejects malformed dates', () => {
    expect(auditQuerySchema.safeParse({ to: '14/10/2026' }).success).toBe(
      false,
    );
  });

  it('lists distinct actions', async () => {
    const { service } = setup();
    await expect(service.actions()).resolves.toEqual([
      'Approved role',
      'Sent 3 invites',
    ]);
  });
});
