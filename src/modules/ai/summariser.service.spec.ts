import { FakeLlmAdapter } from '../../adapters/llm/fake-llm.adapter.js';
import { LlmUnavailableError } from '../../adapters/llm/llm.adapter.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AiCallLogService } from './ai-call-log.service.js';
import { PromptService } from './prompt.service.js';
import {
  SummariserService,
  fallbackSummary,
  type SummariseQuestion,
} from './summariser.service.js';

function setup() {
  const llm = new FakeLlmAdapter();
  const prisma = {
    promptVersion: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  const service = new SummariserService(
    llm,
    new PromptService(prisma as unknown as PrismaService),
    {
      log: vi.fn().mockResolvedValue(undefined),
    } as unknown as AiCallLogService,
  );
  return { llm, service };
}

const q = (
  position: number,
  firstScore: number,
  secondScore: number | null,
): SummariseQuestion => ({
  position,
  text: `Question ${position}`,
  firstScore,
  secondScore,
  improvementPoints: [`Improve ${position}`],
  worked: [`Worked ${position}`],
});

const questions = [
  q(1, 50, 70),
  q(2, 80, 90),
  q(3, 40, null),
  q(4, 60, 65),
  q(5, 70, 85),
];

describe('SummariserService', () => {
  it('maps the LLM output', async () => {
    const { llm, service } = setup();
    const r = await service.summarise({
      roleTitle: 'Support',
      questions,
      sessionId: 's-1',
    });
    expect(r.source).toBe('llm');
    expect(r.strengths).toHaveLength(3);
    expect(r.focusAreas[0]).toEqual({
      text: 'End each answer with the result (1).',
      questionPosition: 5,
    });
    expect(llm.calls[0].messages[0].content).toContain(
      'second try score: skipped',
    );
  });

  it('rejects positions that are not in the session, then falls back', async () => {
    const { llm, service } = setup();
    const bad = {
      strengths: [1, 2, 9].map((p) => ({ text: 'x', question_position: p })),
      focus_areas: [1, 2, 3].map((p) => ({ text: 'y', question_position: p })),
    };
    llm.setNext('summariser', bad);
    llm.setNext('summariser', bad);
    const r = await service.summarise({
      roleTitle: 'Support',
      questions,
      sessionId: 's-1',
    });
    expect(llm.calls).toHaveLength(2);
    expect(r.source).toBe('fallback');
  });

  it('falls back when the LLM is unavailable', async () => {
    const { llm, service } = setup();
    llm.setNext('summariser', new LlmUnavailableError('down'));
    const r = await service.summarise({
      roleTitle: 'Support',
      questions,
      sessionId: 's-1',
    });
    expect(r).toEqual({
      strengths: [
        { text: 'Worked 2', questionPosition: 2 },
        { text: 'Worked 5', questionPosition: 5 },
        { text: 'Worked 1', questionPosition: 1 },
      ],
      focusAreas: [
        { text: 'Improve 3', questionPosition: 3 },
        { text: 'Improve 4', questionPosition: 4 },
        { text: 'Improve 1', questionPosition: 1 },
      ],
      source: 'fallback',
    });
  });
});

describe('fallbackSummary', () => {
  it('cycles when there are fewer than 3 questions', () => {
    const r = fallbackSummary([
      { ...q(1, 60, 70), worked: [], improvementPoints: ['A', 'B'] },
    ]);
    expect(r.strengths.map((p) => p.questionPosition)).toEqual([1, 1, 1]);
    expect(r.strengths[0].text).toBe(
      'Your answer to question 1 was one of your strongest.',
    );
    expect(r.focusAreas.map((p) => p.text)).toEqual(['A', 'B', 'A']);
  });
});
