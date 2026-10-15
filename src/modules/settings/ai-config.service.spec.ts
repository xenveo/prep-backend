import type { AuditService } from '../../common/audit/audit.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { PromptService } from '../ai/prompt.service.js';
import { DEFAULT_PROMPTS } from '../ai/prompts/defaults.js';
import {
  AI_CONFIG_AUDIT_ACTION,
  AiConfigService,
  aiConfigUpdateSchema,
} from './ai-config.service.js';

const version = (v: number, active: boolean, template = `t${v}`) => ({
  id: `pv${v}`,
  role: 'evaluator',
  version: v,
  model: 'm',
  temperature: 0.2,
  template,
  outputSchema: null,
  active,
  createdBy: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
});

function setup(rows: ReturnType<typeof version>[]) {
  const tx = {
    promptVersion: {
      findFirst: vi
        .fn()
        .mockImplementation(({ where }: { where: { active?: boolean } }) =>
          Promise.resolve(
            where.active
              ? (rows.find((r) => r.active) ?? null)
              : (rows[0] ?? null),
          ),
        ),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi
        .fn()
        .mockImplementation(({ data }) =>
          Promise.resolve({ ...version(data.version, true), ...data }),
        ),
    },
  };
  const prisma = {
    promptVersion: { findMany: vi.fn().mockResolvedValue(rows) },
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const prompts = { invalidate: vi.fn() };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new AiConfigService(
    prisma as unknown as PrismaService,
    prompts as unknown as PromptService,
    audit as unknown as AuditService,
  );
  return { service, tx, prompts, audit };
}

describe('AiConfigService', () => {
  it('GET falls back to the built-in default as version 0', async () => {
    const { service } = setup([]);
    const config = await service.get();
    expect(config.roles.map((r) => r.role)).toEqual([
      'interviewer',
      'evaluator',
      'summariser',
      'drafter',
    ]);
    const evaluator = config.roles[1];
    expect(evaluator.active.version).toBe(0);
    expect(evaluator.active.template).toBe(
      DEFAULT_PROMPTS.find((p) => p.role === 'evaluator')!.template,
    );
    expect(evaluator.versions).toEqual([]);
  });

  it('GET lists versions without templates', async () => {
    const { service } = setup([version(2, true), version(1, false)]);
    const evaluator = (await service.get()).roles[1];
    expect(evaluator.active).toMatchObject({ version: 2, template: 't2' });
    expect(evaluator.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(evaluator.versions[0]).not.toHaveProperty('template');
  });

  it('PUT creates version N+1 as the only active one, copying the template', async () => {
    const { service, tx, prompts, audit } = setup([
      version(3, false),
      version(2, true),
    ]);
    await service.update(
      { role: 'evaluator', model: 'm2', temperature: 0.4 },
      'sa1',
      '1.1.1.1',
    );
    expect(tx.promptVersion.updateMany).toHaveBeenCalledWith({
      where: { role: 'evaluator', active: true },
      data: { active: false },
    });
    expect(tx.promptVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        role: 'evaluator',
        version: 4,
        model: 'm2',
        temperature: 0.4,
        template: 't2',
        active: true,
        createdBy: 'sa1',
      }),
    });
    expect(prompts.invalidate).toHaveBeenCalledWith('evaluator');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AI_CONFIG_AUDIT_ACTION,
        actorId: 'sa1',
        itemLabel: 'evaluator: v2 → v4',
      }),
      tx,
    );
  });

  it('PUT with a template and no stored versions starts at version 1', async () => {
    const { service, tx } = setup([]);
    await service.update(
      { role: 'evaluator', model: 'm', temperature: 0, template: 'new' },
      'sa1',
      null,
    );
    expect(tx.promptVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ version: 1, template: 'new' }),
    });
  });

  it('validates the body', () => {
    expect(
      aiConfigUpdateSchema.safeParse({
        role: 'judge',
        model: 'm',
        temperature: 0,
      }).success,
    ).toBe(false);
    expect(
      aiConfigUpdateSchema.safeParse({
        role: 'evaluator',
        model: 'm',
        temperature: 3,
      }).success,
    ).toBe(false);
  });
});
