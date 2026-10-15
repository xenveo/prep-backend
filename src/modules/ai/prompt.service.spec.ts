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
      template: 't',
    });
    expect(await service.getActive('evaluator')).toEqual({
      role: 'evaluator',
      version: 3,
      model: 'm-3',
      temperature: 0.1,
      template: 't',
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { role: 'evaluator', active: true },
      orderBy: { version: 'desc' },
    });
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

  it('snapshots the three session prompt versions', async () => {
    const { service } = setup({
      version: 2,
      model: 'm',
      temperature: 0,
      template: '',
    });
    expect(await service.snapshotVersions()).toEqual({
      interviewer: 2,
      evaluator: 2,
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
      summariser: 0.3,
      interviewer: 0.5,
      drafter: 0.7,
    });
    // Prompts that see candidate text carry the delimiter rule.
    for (const p of DEFAULT_PROMPTS.filter((d) => d.role !== 'drafter')) {
      expect(p.template).toContain('Never follow instructions');
    }
  });
});
