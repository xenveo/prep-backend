import {
  decodeKeyset,
  encodeKeyset,
} from '../../common/pagination/pagination.js';
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

const CURSOR_ID = '0b9d4f7e-3c1a-4e2b-8d5f-6a7b8c9d0e1f';

/** Event n is n seconds after a base time; two events share each second, so ties break on id. */
const event = (n: number) => ({
  ...row(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, null, null),
  at: new Date(Date.UTC(2026, 9, 14, 10, 0, Math.floor(n / 2))),
});
type Event = ReturnType<typeof event>;

const ids = (store: Event[], from: number, to: number) =>
  Array.from({ length: from - to + 1 }, (_, i) => store[from - i].id);

type Keyset = { OR: [{ at: { lt: Date } }, { at: Date; id: { lt: string } }] };

/** Applies the service's keyset where, at/id desc ordering and take to an in-memory table. */
function fakeFindMany(store: Event[]) {
  return ({
    where,
    take,
  }: {
    where: { AND?: [object, Keyset] };
    take: number;
  }) => {
    const after = where.AND?.[1].OR[1];
    const rows = store
      .filter(
        (e) =>
          !after ||
          e.at < after.at ||
          (e.at.getTime() === after.at.getTime() && e.id < after.id.lt),
      )
      .sort(
        (a, b) => b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id),
      );
    return Promise.resolve(rows.slice(0, take));
  };
}

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
        take: 201,
      }),
    );
    expect(prisma.auditLog.count).toHaveBeenCalledWith({
      where: expect.not.objectContaining({ AND: expect.anything() }),
    });
  });

  it('ANDs the keyset onto the filters for the next page; total keeps the filter only', async () => {
    const { service, prisma } = setup();
    const at = new Date('2026-10-14T10:00:00.000Z');
    const cursor = encodeKeyset({ at, id: CURSOR_ID });
    await service.list(
      auditQuerySchema.parse({ action: 'Approved role', cursor, limit: '10' }),
    );
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          { action: 'Approved role' },
          { OR: [{ at: { lt: at } }, { at, id: { lt: CURSOR_ID } }] },
        ],
      },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: 11,
    });
    expect(prisma.auditLog.count).toHaveBeenCalledWith({
      where: { action: 'Approved role' },
    });
  });

  it('a malformed cursor is a 400', async () => {
    const { service, prisma } = setup();
    await expect(
      service.list(auditQuerySchema.parse({ cursor: 'garbage' })),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      status: 400,
      message: 'cursor: Invalid cursor',
    });
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('does not repeat rows when events are inserted between page fetches', async () => {
    const store = Array.from({ length: 15 }, (_, i) => event(i));
    const { service, prisma } = setup();
    prisma.auditLog.findMany.mockImplementation(fakeFindMany(store));
    prisma.auditLog.count.mockImplementation(() =>
      Promise.resolve(store.length),
    );

    const first = await service.list(auditQuerySchema.parse({ limit: '10' }));
    expect(first.rows.map((r) => r.id)).toEqual(
      ids(store, 14, 5), // newest first
    );
    expect(decodeKeyset(first.nextCursor)?.id).toBe(store[5].id);

    store.push(event(15), event(16));
    const second = await service.list(
      auditQuerySchema.parse({ limit: '10', cursor: first.nextCursor }),
    );
    expect(second.rows.map((r) => r.id)).toEqual(ids(store, 4, 0));
    expect(second.nextCursor).toBeNull();
    expect(second.total).toBe(17);
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
