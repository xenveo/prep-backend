import {
  draftCardsOutputSchema,
  draftQuestionsOutputSchema,
  evaluatorOutputSchema,
  summariserOutputSchema,
} from '../../modules/ai/schemas.js';
import { FakeLlmAdapter } from './fake-llm.adapter.js';
import type { LlmJsonRequest } from './llm.adapter.js';

const req = (tag: string, user: string): LlmJsonRequest => ({
  tag,
  model: 'm',
  temperature: 0,
  system: 's',
  messages: [{ role: 'user', content: user }],
  jsonSchema: {},
});

const answer = (n: number) =>
  `<candidate_answer>\n${Array(n).fill('word').join(' ')}\n</candidate_answer>`;

describe('FakeLlmAdapter', () => {
  it('returns schema-valid evaluator output that varies with answer length', async () => {
    const llm = new FakeLlmAdapter();
    const short = await llm.json(req('evaluator', answer(5)));
    const long = await llm.json(req('evaluator', answer(130)));
    const s = evaluatorOutputSchema.parse(short.output);
    const l = evaluatorOutputSchema.parse(long.output);
    expect(s.dimension_scores.content).toBeLessThan(l.dimension_scores.content);
    expect(s.applied).toBeUndefined();
    expect(llm.calls).toHaveLength(2);
    expect(short.provider).toBe('fake');
    expect(short.usage.costUsd).toBe(0);
  });

  it('echoes improvement points as applied on attempt 2', async () => {
    const llm = new FakeLlmAdapter();
    const res = await llm.json(
      req(
        'evaluator',
        `<improvement_point>Say &apos;I&apos;</improvement_point>\n<improvement_point>End with the result</improvement_point>\n${answer(70)}`,
      ),
    );
    expect(evaluatorOutputSchema.parse(res.output).applied).toEqual([
      {
        point: "Say 'I'",
        status: 'applied',
        evidence: 'You did this clearly.',
      },
      {
        point: 'End with the result',
        status: 'applied',
        evidence: 'You did this clearly.',
      },
    ]);
  });

  it('returns schema-valid summariser and drafter output', async () => {
    const llm = new FakeLlmAdapter();
    const sum = summariserOutputSchema.parse(
      (
        await llm.json(
          req('summariser', '<question position="1">\n<question position="2">'),
        )
      ).output,
    );
    expect(sum.strengths.map((p) => p.question_position)).toEqual([1, 2, 1]);
    const cards = draftCardsOutputSchema.parse(
      (await llm.json(req('draft-cards', 'Number to draft: 4'))).output,
    );
    expect(cards.cards).toHaveLength(4);
    const qs = draftQuestionsOutputSchema.parse(
      (
        await llm.json(
          req(
            'draft-questions',
            'Number to draft: 2\n<card position="7" category="x">',
          ),
        )
      ).output,
    );
    expect(qs.questions.map((q) => q.card_position)).toEqual([7, 7]);
  });

  it('uses queued outputs and errors first', async () => {
    const llm = new FakeLlmAdapter();
    llm.setNext('interviewer', { text: 'queued' });
    llm.setNext('interviewer', new Error('down'));
    expect((await llm.json(req('interviewer', ''))).output).toEqual({
      text: 'queued',
    });
    await expect(llm.json(req('interviewer', ''))).rejects.toThrow('down');
    expect((await llm.json(req('interviewer', ''))).output).toEqual({
      text: "Let's begin with the first question.",
    });
    llm.reset();
    expect(llm.calls).toHaveLength(0);
  });
});
