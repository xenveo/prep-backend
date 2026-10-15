import type { AuditService } from '../../common/audit/audit.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { CardsService, renumberCards } from './cards.service.js';
import type { RolesService } from './roles.service.js';

const actor = { id: 'admin-1', ip: null };

function card(over: Record<string, unknown> = {}) {
  return {
    id: 'card-1',
    jobRoleId: 'role-1',
    position: 1,
    category: 'behavioural',
    question: 'Q',
    strongAnswerPoints: [],
    sampleAnswerOutline: null,
    commonMistakes: [],
    tip: 't',
    status: 'ai_draft',
    createdBy: null,
    approvedBy: null,
    approvedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function setup(cards: { id: string }[] = [], found: unknown = card()) {
  const prisma: any = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    flashCard: {
      findMany: vi.fn().mockResolvedValue(cards),
      findUnique: vi.fn().mockResolvedValue(found),
      update: vi.fn().mockResolvedValue(card({ status: 'approved' })),
      delete: vi.fn().mockResolvedValue(found),
    },
  };
  prisma.$transaction = vi.fn((fn: (tx: unknown) => unknown) => fn(prisma));
  const roles = {
    getRow: vi.fn().mockResolvedValue({ id: 'role-1' }),
    getEditableRow: vi
      .fn()
      .mockResolvedValue({ id: 'role-1', title: 'Support' }),
    touch: vi.fn().mockResolvedValue(undefined),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new CardsService(
    prisma as PrismaService,
    roles as unknown as RolesService,
    audit as unknown as AuditService,
  );
  return { service, prisma, audit };
}

describe('renumberCards', () => {
  it('negates positions first, then sets 1..n in order', async () => {
    const { prisma } = setup();
    await renumberCards(prisma, 'role-1', ['b', 'a']);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.flashCard.update.mock.calls.map((c: any) => c[0])).toEqual([
      { where: { id: 'b' }, data: { position: 1 } },
      { where: { id: 'a' }, data: { position: 2 } },
    ]);
  });
});

describe('CardsService.reorder', () => {
  const cards = [{ id: 'a' }, { id: 'b' }];

  it.each([
    ['a missing card', ['a']],
    ['a duplicate', ['a', 'a']],
    ['an unknown card', ['a', 'c']],
  ])('rejects %s', async (_label, ids) => {
    const { service, prisma } = setup(cards);
    await expect(service.reorder('role-1', ids, actor)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('renumbers and audits a valid order', async () => {
    const { service, audit } = setup(cards);
    await service.reorder('role-1', ['b', 'a'], actor);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'Reordered flash cards' }),
      expect.anything(),
    );
  });
});

describe('CardsService.discard', () => {
  it('only discards AI drafts', async () => {
    const { service, prisma } = setup([], card({ status: 'approved' }));
    await expect(service.discard('card-1', actor)).rejects.toMatchObject({
      status: 409,
    });
    expect(prisma.flashCard.delete).not.toHaveBeenCalled();
  });

  it('deletes and renumbers the rest', async () => {
    const { service, prisma } = setup([{ id: 'x' }, { id: 'y' }]);
    await service.discard('card-1', actor);
    expect(prisma.flashCard.delete).toHaveBeenCalledWith({
      where: { id: 'card-1' },
    });
    expect(prisma.flashCard.update).toHaveBeenCalledTimes(2);
  });

  it('404s for an unknown card', async () => {
    const { service } = setup([], null);
    await expect(service.discard('nope', actor)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('CardsService.approve', () => {
  it('sets approvedBy and audits', async () => {
    const { service, prisma, audit } = setup();
    const result = await service.approve('card-1', actor);
    expect(prisma.flashCard.update.mock.calls[0][0].data).toMatchObject({
      status: 'approved',
      approvedBy: 'admin-1',
    });
    expect(result.status).toBe('approved');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'Approved flash card',
        itemLabel: 'Support · card 1',
      }),
      expect.anything(),
    );
  });
});
