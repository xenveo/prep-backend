import { AppError } from '../../common/errors/app-error.js';
import type { AuditService } from '../../common/audit/audit.service.js';
import type { QueueService } from '../../common/queue/queue.types.js';
import type { AppConfig } from '../../config/app-config.js';
import type { EmailService } from '../../jobs/email/email.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { DEFAULT_ROLE_SETTINGS } from '../interview/types.js';
import {
  assertWeights,
  RolesService,
  slugify,
  uniqueSlug,
} from './roles.service.js';

const actor = { id: 'admin-1', ip: '127.0.0.1' };
const rubric = (n: number) => ({
  keyPoints: Array.from({ length: n }, (_, i) => ({
    id: `kp${i + 1}`,
    point: 'p',
    example: '',
  })),
  redFlags: [],
  expectedStructure: 'star',
});

function role(over: Record<string, unknown> = {}) {
  return {
    id: 'role-1',
    slug: 'support',
    title: 'Support',
    status: 'draft',
    settings: DEFAULT_ROLE_SETTINGS,
    ...over,
  };
}

function setup(opts: {
  role?: Record<string, unknown> | null;
  questions?: { rubric: unknown; card: { status: string } | null }[];
  approvedCards?: number;
  notify?: number;
}) {
  const prisma: any = {
    jobRole: {
      findUnique: vi
        .fn()
        .mockResolvedValue(opts.role === null ? null : role(opts.role)),
      update: vi.fn().mockResolvedValue(role({ status: 'approved' })),
    },
    question: { findMany: vi.fn().mockResolvedValue(opts.questions ?? []) },
    flashCard: { count: vi.fn().mockResolvedValue(opts.approvedCards ?? 0) },
    roleAssignment: {
      count: vi.fn().mockResolvedValue(opts.notify ?? 0),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  prisma.$transaction = vi.fn((fn: (tx: unknown) => unknown) => fn(prisma));
  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
    recordMerged: vi.fn().mockResolvedValue(undefined),
  };
  const queue = { add: vi.fn().mockResolvedValue({ jobId: 'j' }) };
  const email = { send: vi.fn().mockResolvedValue(undefined) };
  const config = { env: { APP_CANDIDATE_ORIGIN: 'http://c.test' } };
  const service = new RolesService(
    prisma as PrismaService,
    audit as unknown as AuditService,
    email as unknown as EmailService,
    config as AppConfig,
    queue as unknown as QueueService,
  );
  return { service, prisma, audit, queue, email };
}

const ready = (n: number) =>
  Array.from({ length: n }, () => ({
    rubric: rubric(1),
    card: { status: 'approved' },
  }));

describe('slugify / uniqueSlug', () => {
  it('kebab-cases titles', () => {
    expect(slugify('Customer Support Associate')).toBe(
      'customer-support-associate',
    );
    expect(slugify('  C++ / Go dev! ')).toBe('c-go-dev');
    expect(slugify('***')).toBe('role');
  });

  it('suffixes taken slugs', () => {
    expect(uniqueSlug('a', [])).toBe('a');
    expect(uniqueSlug('a', ['a', 'a-2'])).toBe('a-3');
  });
});

describe('assertWeights', () => {
  it('accepts the defaults', () => {
    expect(() => assertWeights(DEFAULT_ROLE_SETTINGS)).not.toThrow();
  });

  it('rejects groups that do not add up to 100', () => {
    expect(() =>
      assertWeights({
        ...DEFAULT_ROLE_SETTINGS,
        sessionWeights: { firstTry: 20, secondTry: 50, learning: 25 },
      }),
    ).toThrow('Session score weights must add up to 100%');
    expect(() =>
      assertWeights({
        ...DEFAULT_ROLE_SETTINGS,
        dimensionWeights: {
          content: 40,
          structure: 20,
          delivery: 20,
          relevance: 15,
        },
      }),
    ).toThrow('Answer dimension weights must add up to 100%');
  });
});

describe('RolesService.requirements', () => {
  it('needs max(5, questionsPerSession) linked questions with key points', async () => {
    const { service } = setup({
      role: {
        settings: { ...DEFAULT_ROLE_SETTINGS, questionsPerSession: 6 },
      },
      questions: [
        ...ready(5),
        { rubric: rubric(0), card: { status: 'approved' } },
        { rubric: rubric(2), card: null },
      ],
      approvedCards: 2,
      notify: 4,
    });
    const req = await service.requirements('role-1');
    expect(req.canApprove).toBe(false);
    expect(req.firstUnmet).toBe(
      'Add at least 6 questions with rubrics and a linked flash card',
    );
    // Only the 5 linked questions with key points count, not all 7 approved ones.
    expect(req.approvedQuestions).toBe(5);
    expect(req.approvedFlashCards).toBe(2);
    expect(req.candidatesToNotify).toBe(4);
  });

  it('does not count questions linked to an ai_draft card', async () => {
    const { service } = setup({
      questions: [
        ...ready(4),
        { rubric: rubric(1), card: { status: 'ai_draft' } },
      ],
      approvedCards: 1,
    });
    const req = await service.requirements('role-1');
    expect(req.canApprove).toBe(false);
    expect(req.requirements[0]).toMatchObject({ id: 'questions', met: false });
    expect(req.approvedQuestions).toBe(4);
  });

  it('needs an approved card', async () => {
    const { service } = setup({ questions: ready(5), approvedCards: 0 });
    const req = await service.requirements('role-1');
    expect(req.firstUnmet).toBe('Approve at least 1 flash card');
  });

  it('can approve when everything is met', async () => {
    const { service } = setup({ questions: ready(5), approvedCards: 1 });
    const req = await service.requirements('role-1');
    expect(req).toMatchObject({ canApprove: true, firstUnmet: null });
    expect(req.requirements.map((r) => r.id)).toEqual([
      'questions',
      'cards',
      'session-weights',
      'dimension-weights',
    ]);
  });

  it('404s for an unknown role', async () => {
    const { service } = setup({ role: null });
    await expect(service.requirements('x')).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('RolesService.approve', () => {
  it('rejects a role that is not a draft', async () => {
    const { service } = setup({ role: { status: 'approved' } });
    await expect(service.approve('role-1', actor)).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });
  });

  it('rejects unmet requirements with the first unmet label', async () => {
    const { service, audit } = setup({ questions: ready(2), approvedCards: 1 });
    const err = await service.approve('role-1', actor).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toBe(
      'Add at least 5 questions with rubrics and a linked flash card',
    );
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('RolesService.update', () => {
  it('rejects edits to archived roles', async () => {
    const { service } = setup({ role: { status: 'archived' } });
    await expect(
      service.update('role-1', { title: 'New' }, actor),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects bad weights before writing', async () => {
    const { service, prisma } = setup({});
    await expect(
      service.update(
        'role-1',
        {
          settings: {
            ...DEFAULT_ROLE_SETTINGS,
            sessionWeights: { firstTry: 0, secondTry: 0, learning: 0 },
          },
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(prisma.jobRole.update).not.toHaveBeenCalled();
  });
});
