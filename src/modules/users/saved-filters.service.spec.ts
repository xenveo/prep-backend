import type { AuditService } from '../../common/audit/audit.service.js';
import type { AuthUser } from '../../common/auth/auth.types.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { SavedFiltersService } from './saved-filters.service.js';

function setup() {
  const prisma = { savedFilter: { findMany: vi.fn(), create: vi.fn() } };
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
      { id: 'f1', label: 'All candidates', query: {}, isDefault: true },
      {
        id: 'f2',
        label: 'Not ready',
        query: { bands: ['not_ready'] },
        isDefault: false,
      },
      { id: 'f3', label: 'Broken', query: { nope: 1 }, isDefault: false },
    ]);
    await expect(service.list('adm-1')).resolves.toEqual([
      { id: 'f1', label: 'All candidates', query: {}, isDefault: true },
      { id: 'f2', label: 'Not ready', query: { bands: ['not_ready'] } },
      { id: 'f3', label: 'Broken', query: {} },
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
      label: 'Saved filter',
      query: { statuses: ['active'] },
    });
    expect(prisma.savedFilter.create.mock.calls[0][0].data.adminId).toBe(
      'adm-1',
    );
    expect(audit.record.mock.calls[0][0].action).toBe('Saved a filter');
  });
});
