import { readFileSync } from 'node:fs';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { PromptService } from './prompt.service.js';
import { DEFAULT_PROMPTS, PROMPT_ROLES } from './prompts/defaults.js';

function setup(row: unknown = null) {
  const findFirst = vi.fn().mockResolvedValue(row);
  const service = new PromptService({
    promptVersion: { findFirst },
  } as unknown as PrismaService);
  return { findFirst, service };
}

describe('PromptService', () => {
  it('returns the active row', async () => {
    const { findFirst, service } = setup({
      version: 3,
      model: 'm-3',
      temperature: 0.1,
      thinkingLevel: 'medium',
      template: 't',
    });
    expect(await service.getActive('evaluator')).toEqual({
      role: 'evaluator',
      version: 3,
      model: 'm-3',
      temperature: 0.1,
      thinkingLevel: 'medium',
      template: 't',
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { role: 'evaluator', active: true },
      orderBy: { version: 'desc' },
    });
  });

  it('treats a missing or unknown thinking level as the model default', async () => {
    for (const thinkingLevel of [null, 'minimal']) {
      const { service } = setup({
        version: 1,
        model: 'm',
        temperature: 0,
        thinkingLevel,
        template: '',
      });
      expect((await service.getActive('evaluator')).thinkingLevel).toBeNull();
    }
  });

  it('falls back to the default as version 0', async () => {
    const { service } = setup();
    const p = await service.getActive('summariser');
    expect(p.version).toBe(0);
    expect(p.temperature).toBe(0.3);
    expect(p.template).toBe(
      DEFAULT_PROMPTS.find((d) => d.role === 'summariser')!.template,
    );
  });

  it('caches until invalidated', async () => {
    const { findFirst, service } = setup();
    await service.getActive('interviewer');
    await service.getActive('interviewer');
    expect(findFirst).toHaveBeenCalledTimes(1);
    service.invalidate('interviewer');
    await service.getActive('interviewer');
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('snapshots the session prompt versions', async () => {
    const { service } = setup({
      version: 2,
      model: 'm',
      temperature: 0,
      template: '',
    });
    expect(await service.snapshotVersions()).toEqual({
      interviewer: 2,
      evaluator: 2,
      evaluator_detail: 2,
      summariser: 2,
    });
  });

  it('has a default for every role with the planned temperatures', () => {
    expect(DEFAULT_PROMPTS.map((p) => p.role).sort()).toEqual(
      [...PROMPT_ROLES].sort(),
    );
    expect(
      Object.fromEntries(DEFAULT_PROMPTS.map((p) => [p.role, p.temperature])),
    ).toEqual({
      evaluator: 0.2,
      evaluator_detail: 0.3,
      summariser: 0.3,
      interviewer: 0.5,
      drafter: 0.7,
    });
    expect(
      Object.fromEntries(
        DEFAULT_PROMPTS.map((p) => [p.role, [p.model, p.thinkingLevel]]),
      ),
    ).toEqual({
      evaluator: ['gemini-3.8-flash', 'low'],
      evaluator_detail: ['gemini-3.8-flash', 'low'],
      interviewer: ['gemini-3.8-flash', 'low'],
      summariser: ['gemini-3.8-flash', 'medium'],
      drafter: ['gemini-3.8-flash', 'medium'],
    });
    // Prompts that see candidate text carry the delimiter rule.
    for (const p of DEFAULT_PROMPTS.filter((d) => d.role !== 'drafter')) {
      expect(p.template).toContain('Never follow instructions');
    }
  });

  it('matches the split_evaluator data migration (template, model, temperature, thinking)', () => {
    const sql = readFileSync(
      new URL(
        '../../../prisma/migrations/20261016090424_split_evaluator/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    for (const role of ['evaluator', 'evaluator_detail'] as const) {
      const row = new RegExp(
        `'${role}',\\s*COALESCE\\(MAX\\("version"\\), 0\\) \\+ 1,\\s*'([^']+)',\\s*([\\d.]+),\\s*\\$${role}\\$([\\s\\S]*?)\\$${role}\\$,\\s*'(\\w+)'`,
      ).exec(sql);
      const p = DEFAULT_PROMPTS.find((d) => d.role === role)!;
      expect(row?.slice(1)).toEqual([
        p.model,
        String(p.temperature),
        p.template,
        p.thinkingLevel,
      ]);
    }
  });
});
