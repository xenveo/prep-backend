import type { AuditService } from '../../common/audit/audit.service.js';
import type { QueueService } from '../../common/queue/queue.types.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { DrafterService } from '../ai/drafter.service.js';
import { AiDraftProcessor } from './ai-draft.processor.js';
import type { RolesService } from './roles.service.js';

const role = {
  id: 'role-1',
  title: 'Support',
  descriptionHtml: '<p>Help &amp; care</p>',
  keySkills: ['empathy'],
  seniority: 'entry',
};
const job = {
  roleId: 'role-1',
  count: 2,
  adminId: 'admin-1',
  ip: null,
};

function setup() {
  let n = 0;
  const prisma: any = {
    flashCard: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'c1',
          position: 1,
          question: 'Card Q',
          category: 'behavioural',
        },
      ]),
      aggregate: vi.fn().mockResolvedValue({ _max: { position: 4 } }),
      create: vi.fn((args: any) =>
        Promise.resolve({ id: `new-${++n}`, ...args.data }),
      ),
    },
    question: {
      findMany: vi.fn().mockResolvedValue([{ text: 'Existing question' }]),
      create: vi.fn((args: any) =>
        Promise.resolve({ id: `q-${++n}`, ...args.data }),
      ),
    },
    jobRole: { update: vi.fn().mockResolvedValue(role) },
  };
  prisma.$transaction = vi.fn((fn: (tx: unknown) => unknown) => fn(prisma));
  const drafter = {
    draftCards: vi.fn().mockResolvedValue([
      {
        category: 'motivation',
        question: 'Why us?',
        strongAnswerPoints: ['a', 'b', 'c'],
        commonMistakes: ['x', 'y'],
        tip: 'Be specific.',
        sampleAnswerOutline: null,
      },
    ]),
    draftQuestions: vi.fn().mockResolvedValue([
      {
        text: 'Q?',
        category: 'behavioural',
        difficulty: 'easy',
        cardPosition: 1,
        rubric: { keyPoints: [], redFlags: [], expectedStructure: 'star' },
      },
      {
        text: 'Q2?',
        category: 'behavioural',
        difficulty: 'easy',
        cardPosition: null,
        rubric: { keyPoints: [], redFlags: [], expectedStructure: 'star' },
      },
    ]),
  };
  const roles = { getEditableRow: vi.fn().mockResolvedValue(role) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const processor = new AiDraftProcessor(
    { process: vi.fn() } as unknown as QueueService,
    prisma as PrismaService,
    drafter as unknown as DrafterService,
    roles as unknown as RolesService,
    audit as unknown as AuditService,
  );
  return { processor, prisma, drafter, audit };
}

describe('AiDraftProcessor', () => {
  it('drafts cards as ai_draft rows appended after the last position', async () => {
    const { processor, prisma, drafter, audit } = setup();
    const cards = await processor.handle({ ...job, kind: 'cards' });
    expect(drafter.draftCards).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptionText: 'Help & care',
        existingQuestions: ['Card Q', 'Existing question'],
        count: 2,
      }),
    );
    expect(cards).toEqual([
      expect.objectContaining({
        position: 5,
        status: 'ai_draft',
        createdBy: 'ai',
      }),
    ]);
    expect(
      prisma.jobRole.update.mock.calls[0][0].data.lastAiDraftAt,
    ).toBeInstanceOf(Date);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'Drafted flash cards with AI',
        actorId: 'admin-1',
      }),
      expect.anything(),
    );
  });

  it('drafts questions linked to cards by position', async () => {
    const { processor, prisma } = setup();
    const questions = await processor.handle({ ...job, kind: 'questions' });
    expect(
      prisma.question.create.mock.calls.map((c: any) => c[0].data.flashCardId),
    ).toEqual(['c1', null]);
    expect(questions).toHaveLength(2);
    expect(questions[0]).toMatchObject({ status: 'ai_draft', cardId: 'c1' });
  });
});
