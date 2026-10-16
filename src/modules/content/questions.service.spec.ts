import type { AuditService } from '../../common/audit/audit.service.js';
import { AppError } from '../../common/errors/app-error.js';
import type { QueueService } from '../../common/queue/queue.types.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { EvaluatorService } from '../ai/evaluator.service.js';
import type { EvaluatorOutput } from '../ai/schemas.js';
import { DEFAULT_ROLE_SETTINGS, type Rubric } from '../interview/types.js';
import type { AiQuotaService } from './ai-quota.service.js';
import {
  QuestionsService,
  toStoredRubric,
  toTestEvaluation,
} from './questions.service.js';
import type { RolesService } from './roles.service.js';

const actor = { id: 'admin-1', ip: null };
const rubric: Rubric = {
  keyPoints: [
    { id: 'kp1', point: 'Names the problem', example: '' },
    { id: 'kp2', point: 'Ends with a result', example: '' },
  ],
  redFlags: [],
  expectedStructure: 'star',
};

const output = {
  worked: ['Real example.'],
  improve: ['End with the result.'],
  highlights: [
    {
      quote: 'a',
      kind: 'match',
      note: 'Clear opening.',
      rubric_point_id: 'kp1',
    },
    { quote: 'b', kind: 'match', note: 'Good tone.' },
    { quote: 'c', kind: 'issue', note: 'No result.' },
  ],
} as unknown as EvaluatorOutput;

function question(over: Record<string, unknown> = {}) {
  return {
    id: 'q1',
    jobRoleId: 'role-1',
    flashCardId: 'card-1',
    text: 'Tell me about a time…',
    category: 'behavioural',
    difficulty: 'medium',
    rubric,
    status: 'approved',
    sampleEvaluation: null,
    audioKey: 'tts/x.mp3',
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function setup(opts: { found?: unknown; roleStatus?: string } = {}) {
  const prisma: any = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    question: {
      findUnique: vi.fn().mockResolvedValue(opts.found ?? question()),
      update: vi.fn((args: any) => Promise.resolve(question({ ...args.data }))),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    sessionQuestion: { count: vi.fn().mockResolvedValue(0) },
    flashCard: { findFirst: vi.fn().mockResolvedValue({ id: 'card-1' }) },
  };
  prisma.$transaction = vi.fn((fn: (tx: unknown) => unknown) => fn(prisma));
  const roleRow = {
    id: 'role-1',
    title: 'Support',
    status: opts.roleStatus ?? 'approved',
    settings: DEFAULT_ROLE_SETTINGS,
  };
  const roles = {
    getRow: vi.fn().mockResolvedValue(roleRow),
    getEditableRow: vi.fn().mockResolvedValue(roleRow),
    touch: vi.fn().mockResolvedValue(undefined),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const evaluator = {
    evaluate: vi.fn().mockResolvedValue({
      output,
      score: 72,
      dimensionScores: {
        content: 75,
        structure: 50,
        delivery: 75,
        relevance: 100,
      },
    }),
  };
  const quota = { consume: vi.fn().mockResolvedValue(undefined) };
  const queue = { add: vi.fn().mockResolvedValue({ jobId: 'j' }) };
  const service = new QuestionsService(
    prisma as PrismaService,
    roles as unknown as RolesService,
    audit as unknown as AuditService,
    evaluator as unknown as EvaluatorService,
    quota as unknown as AiQuotaService,
    queue as unknown as QueueService,
  );
  return { service, prisma, roles, audit, evaluator, quota, queue };
}

const input = {
  text: 'Tell me about a time…',
  category: 'behavioural' as const,
  difficulty: 'medium' as const,
  rubric: {
    keyPoints: [{ point: 'A', example: '' }],
    redFlags: [],
    expectedStructure: 'star' as const,
  },
};

describe('toStoredRubric', () => {
  it('numbers key points kp1..', () => {
    expect(
      toStoredRubric({
        keyPoints: [
          { point: 'A', example: 'a' },
          { point: 'B', example: '' },
        ],
        redFlags: ['x'],
        expectedStructure: 'free',
      }).keyPoints.map((k) => k.id),
    ).toEqual(['kp1', 'kp2']);
  });
});

describe('toTestEvaluation', () => {
  it('maps highlights to rubric points, with worked/improve after', () => {
    const e = toTestEvaluation(
      'answer',
      72,
      { content: 75, structure: 50, delivery: 75, relevance: 100 },
      output,
      rubric,
    );
    expect(e).toMatchObject({
      answer: 'answer',
      score: 72,
      band: 'nearly',
      matched: ['Names the problem', 'Good tone.', 'Real example.'],
      issues: ['No result.', 'End with the result.'],
      candidateFeedback: 'Real example. End with the result.',
      isTest: true,
    });
  });

  it('uses the admin band spelling at the edges', () => {
    const band = (s: number) =>
      toTestEvaluation('a', s, {} as never, output, rubric).band;
    expect([
      band(49),
      band(50),
      band(69),
      band(70),
      band(84),
      band(85),
    ]).toEqual([
      'not_ready',
      'developing',
      'developing',
      'nearly',
      'nearly',
      'ready',
    ]);
  });
});

describe('QuestionsService.test', () => {
  it("evaluates with the role's weights as typed attempt 1 and caches the result", async () => {
    const { service, evaluator, prisma, quota } = setup();
    const result = await service.test('q1', 'My answer', actor);
    expect(quota.consume).toHaveBeenCalledWith('admin-1');
    expect(evaluator.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'typed',
        attemptNo: 1,
        transcript: 'My answer',
        dimensionWeights: DEFAULT_ROLE_SETTINGS.dimensionWeights,
      }),
    );
    expect(prisma.question.update).toHaveBeenCalledWith({
      where: { id: 'q1' },
      data: { sampleEvaluation: result },
    });
  });

  it('does not evaluate when rate limited', async () => {
    const { service, evaluator, quota } = setup();
    quota.consume.mockRejectedValue(
      new AppError('rate_limited', 429, 'Too many'),
    );
    await expect(service.test('q1', 'a', actor)).rejects.toMatchObject({
      status: 429,
    });
    expect(evaluator.evaluate).not.toHaveBeenCalled();
  });

  it('rejects a question on an archived role before consuming quota', async () => {
    const { service, roles, evaluator, prisma, quota } = setup();
    roles.getEditableRow.mockRejectedValue(
      new AppError('conflict', 409, "Archived roles can't be edited"),
    );
    await expect(service.test('q1', 'a', actor)).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });
    expect(roles.getEditableRow).toHaveBeenCalledWith('role-1');
    expect(quota.consume).not.toHaveBeenCalled();
    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(prisma.question.update).not.toHaveBeenCalled();
  });
});

describe('QuestionsService.update', () => {
  it('re-renders audio when an approved question on an approved role changes text', async () => {
    const { service, prisma, queue } = setup();
    await service.update('q1', { ...input, text: 'New text' }, actor);
    expect(prisma.question.update.mock.calls[0][0].data).toMatchObject({
      text: 'New text',
      audioKey: null,
    });
    expect(queue.add).toHaveBeenCalledWith(
      'tts-pregen',
      { questionId: 'q1' },
      expect.objectContaining({ jobId: 'tts-q1' }),
    );
  });

  it('does not pre-generate audio for a draft role', async () => {
    const { service, queue } = setup({ roleStatus: 'draft' });
    await service.update('q1', { ...input, text: 'New text' }, actor);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('audits approval', async () => {
    const { service, audit } = setup({
      found: question({ status: 'ai_draft' }),
    });
    await service.update('q1', { ...input, status: 'approved' }, actor);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'Approved question' }),
      expect.anything(),
    );
  });

  it('rejects a card from another role', async () => {
    const { service, prisma } = setup();
    prisma.flashCard.findFirst.mockResolvedValue(null);
    await expect(
      service.update(
        'q1',
        { ...input, cardId: '00000000-0000-4000-8000-000000000000' },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('QuestionsService.remove', () => {
  it('deletes a question that was never asked', async () => {
    const { service, prisma, audit } = setup();
    await service.remove('q1', actor);
    expect(prisma.question.delete).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'Deleted question' }),
      expect.anything(),
    );
  });

  it('archives a question that was asked', async () => {
    const { service, prisma } = setup();
    prisma.sessionQuestion.count.mockResolvedValue(3);
    await service.remove('q1', actor);
    expect(prisma.question.delete).not.toHaveBeenCalled();
    expect(prisma.question.update).toHaveBeenCalledWith({
      where: { id: 'q1' },
      data: { status: 'archived' },
    });
  });
});
