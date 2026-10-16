import type { AuditService } from '../../common/audit/audit.service.js';
import type { AuthUser } from '../../common/auth/auth.types.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { SavedFiltersService } from './saved-filters.service.js';

function setup() {
  const prisma = {
    savedFilter: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const audit = { record: vi.fn() };
  const service = new SavedFiltersService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );
  return { service, prisma, audit };
}

describe('SavedFiltersService', () => {
  it('lists system rows and the caller’s own', async () => {
    const { service, prisma } = setup();
    prisma.savedFilter.findMany.mockResolvedValue([
      {
        id: 'f1',
        adminId: null,
        label: 'All candidates',
        query: {},
        isDefault: true,
      },
      {
        id: 'f2',
        adminId: 'adm-1',
        label: 'Not ready',
        query: { bands: ['not_ready'] },
        isDefault: false,
      },
      {
        id: 'f3',
        adminId: 'adm-1',
        label: 'Broken',
        query: { nope: 1 },
        isDefault: false,
      },
    ]);
    await expect(service.list('adm-1')).resolves.toEqual([
      {
        id: 'f1',
        adminId: null,
        label: 'All candidates',
        query: {},
        isDefault: true,
      },
      {
        id: 'f2',
        adminId: 'adm-1',
        label: 'Not ready',
        query: { bands: ['not_ready'] },
      },
      { id: 'f3', adminId: 'adm-1', label: 'Broken', query: {} },
    ]);
    expect(prisma.savedFilter.findMany.mock.calls[0][0].where).toEqual({
      OR: [{ adminId: null }, { adminId: 'adm-1' }],
    });
  });

  it('saves a filter for the caller with a fallback label', async () => {
    const { service, prisma, audit } = setup();
    prisma.savedFilter.create.mockImplementation(({ data }) => ({
      id: 'f9',
      isDefault: false,
      ...data,
    }));
    const res = await service.create(
      { id: 'adm-1' } as AuthUser,
      { label: '  ', query: { statuses: ['active'] } },
      null,
    );
    expect(res).toEqual({
      id: 'f9',
      adminId: 'adm-1',
      label: 'Saved filter',
      query: { statuses: ['active'] },
    });
    expect(prisma.savedFilter.create.mock.calls[0][0].data.adminId).toBe(
      'adm-1',
    );
    expect(audit.record.mock.calls[0][0].action).toBe('Saved a filter');
  });

  it('deletes the caller’s own filter and audits it', async () => {
    const { service, prisma, audit } = setup();
    prisma.savedFilter.findFirst.mockResolvedValue({
      id: 'f9',
      adminId: 'adm-1',
      label: 'Not ready',
    });
    await service.remove({ id: 'adm-1' } as AuthUser, 'f9', '1.2.3.4');
    expect(prisma.savedFilter.findFirst).toHaveBeenCalledWith({
      where: { id: 'f9', adminId: 'adm-1' },
    });
    expect(prisma.savedFilter.deleteMany).toHaveBeenCalledWith({
      where: { id: 'f9', adminId: 'adm-1' },
    });
    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'adm-1',
      action: 'Deleted a saved filter',
      entity: 'saved_filter',
      entityId: 'f9',
      itemLabel: 'Not ready',
      ip: '1.2.3.4',
    });
  });

  it('404 for system rows, other admins’ filters and unknown ids', async () => {
    const { service, prisma, audit } = setup();
    // The owner-scoped lookup finds nothing for a row with adminId null or another admin's id.
    prisma.savedFilter.findFirst.mockResolvedValue(null);
    await expect(
      service.remove({ id: 'adm-1' } as AuthUser, 'f1', null),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect(prisma.savedFilter.deleteMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('404 without an audit row when a concurrent delete won', async () => {
    const { service, prisma, audit } = setup();
    prisma.savedFilter.findFirst.mockResolvedValue({
      id: 'f9',
      adminId: 'adm-1',
      label: 'x',
    });
    prisma.savedFilter.deleteMany.mockResolvedValue({ count: 0 });
    await expect(
      service.remove({ id: 'adm-1' } as AuthUser, 'f9', null),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(audit.record).not.toHaveBeenCalled();
  });
});
