import type { GeminiClient } from '../../adapters/gemini/gemini.client.js';
import { GeminiError } from '../../adapters/gemini/gemini.errors.js';
import { Logger } from '@nestjs/common';
import type { AuditService } from '../../common/audit/audit.service.js';
import { AppError } from '../../common/errors/app-error.js';
import type { AppConfig } from '../../config/app-config.js';
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
  thinkingLevel: 'low' as string | null,
  template,
  outputSchema: null,
  active,
  createdBy: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
});

function setup(
  rows: ReturnType<typeof version>[],
  {
    provider = 'fake',
    ensureModel = vi.fn().mockResolvedValue(undefined),
  } = {},
) {
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
    { env: { LLM_PROVIDER: provider } } as unknown as AppConfig,
    { ensureModel } as unknown as GeminiClient,
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
      'evaluator_detail',
      'summariser',
      'drafter',
    ]);
    const evaluator = config.roles[1];
    expect(evaluator.active.version).toBe(0);
    expect(evaluator.active.thinkingLevel).toBe('low');
    expect(evaluator.active.template).toBe(
      DEFAULT_PROMPTS.find((p) => p.role === 'evaluator')!.template,
    );
    expect(evaluator.versions).toEqual([]);
  });

  it('GET lists versions without templates', async () => {
    const { service } = setup([version(2, true), version(1, false)]);
    const evaluator = (await service.get()).roles[1];
    expect(evaluator.active).toMatchObject({
      version: 2,
      template: 't2',
      thinkingLevel: 'low',
    });
    expect(evaluator.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(evaluator.versions[0].thinkingLevel).toBe('low');
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
        thinkingLevel: 'low',
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

  it('PUT accepts the evaluator_detail role and falls back to its default template', async () => {
    expect(
      aiConfigUpdateSchema.safeParse({
        role: 'evaluator_detail',
        model: 'm',
        temperature: 0.3,
      }).success,
    ).toBe(true);
    const { service, tx, prompts } = setup([]);
    await service.update(
      { role: 'evaluator_detail', model: 'm', temperature: 0.3 },
      'sa1',
      null,
    );
    expect(tx.promptVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        role: 'evaluator_detail',
        version: 1,
        thinkingLevel: 'low',
        template: DEFAULT_PROMPTS.find((p) => p.role === 'evaluator_detail')!
          .template,
      }),
    });
    expect(prompts.invalidate).toHaveBeenCalledWith('evaluator_detail');
  });

  it('PUT stores the requested thinking level and audits the change', async () => {
    const { service, tx, audit } = setup([version(2, true)]);
    await service.update(
      {
        role: 'evaluator',
        model: 'm',
        temperature: 0.2,
        thinkingLevel: 'high',
      },
      'sa1',
      null,
    );
    expect(tx.promptVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ thinkingLevel: 'high' }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        before: expect.objectContaining({ thinkingLevel: 'low' }),
        after: expect.objectContaining({ thinkingLevel: 'high' }),
      }),
      tx,
    );
  });

  it('GET reports an unknown stored thinking level as null', async () => {
    const row = { ...version(1, true), thinkingLevel: 'extreme' };
    const { service } = setup([row]);
    expect((await service.get()).roles[1].active.thinkingLevel).toBeNull();
  });

  describe('model check (LLM_PROVIDER=gemini)', () => {
    const put = {
      role: 'evaluator' as const,
      model: 'gemini-x',
      temperature: 0.2,
    };

    it('is skipped for other providers', async () => {
      const ensureModel = vi.fn();
      const { service } = setup([], { ensureModel });
      await service.update(put, 'sa1', null);
      expect(ensureModel).not.toHaveBeenCalled();
    });

    it('saves a model Gemini serves', async () => {
      const ensureModel = vi.fn().mockResolvedValue(undefined);
      const { service, tx } = setup([], { provider: 'gemini', ensureModel });
      await service.update(put, 'sa1', null);
      expect(ensureModel).toHaveBeenCalledWith('gemini-x');
      expect(tx.promptVersion.create).toHaveBeenCalled();
    });

    it.each([['model_not_found', 404]] as const)(
      'rejects with 400 validation_failed on a definitive %s',
      async (code, status) => {
        const ensureModel = vi
          .fn()
          .mockRejectedValue(new GeminiError(code, 'no', false, status));
        const { service, tx, audit } = setup([], {
          provider: 'gemini',
          ensureModel,
        });
        const err = await service.update(put, 'sa1', null).catch((e) => e);
        expect(err).toBeInstanceOf(AppError);
        expect(err).toMatchObject({
          code: 'validation_failed',
          status: 400,
          message: 'Model gemini-x is not available',
        });
        expect(tx.promptVersion.create).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
      },
    );

    it('saves anyway when the check fails transiently', async () => {
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const ensureModel = vi
        .fn()
        .mockRejectedValue(new GeminiError('unavailable', 'down', true, 503));
      const { service, tx, audit } = setup([], {
        provider: 'gemini',
        ensureModel,
      });
      await service.update(put, 'sa1', null);
      expect(tx.promptVersion.create).toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        'Model check failed (unavailable); saving unverified',
      );
      warn.mockRestore();
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
    expect(
      aiConfigUpdateSchema.safeParse({
        role: 'evaluator',
        model: 'm',
        temperature: 0,
        thinkingLevel: 'minimal',
      }).success,
    ).toBe(false);
  });
});
