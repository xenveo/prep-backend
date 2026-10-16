import {
  calibrationFixtureSchema,
  estimateCallUsd,
  renderMarkdown,
  summarise,
  verdictText,
  type ItemResult,
  type Levels,
  type RunInfo,
} from './calibration.js';

const all = (n: number): Levels => ({
  content: n,
  structure: n,
  delivery: n,
  relevance: n,
});

const result = (
  human: Levels,
  model: Levels | null,
  roleSlug = 'role-a',
  index = 0,
): ItemResult => ({
  index,
  id: null,
  roleSlug,
  questionId: 'q1',
  mode: 'typed',
  human,
  model,
  promptVersion: model ? 3 : null,
  error: model ? null : 'ai_unavailable',
});

const item = {
  roleSlug: 'role-a',
  questionText: 'Tell me about yourself.',
  answerText: 'An answer.',
  mode: 'typed',
  humanScores: all(3),
};

describe('calibrationFixtureSchema', () => {
  it('accepts a bare array or {description, items}', () => {
    expect(calibrationFixtureSchema.parse([item]).items).toHaveLength(1);
    expect(
      calibrationFixtureSchema.parse({ description: 'd', items: [item] }),
    ).toMatchObject({ description: 'd', items: [item] });
  });

  it('needs exactly one of questionId or questionText', () => {
    const { questionText: _, ...neither } = item;
    for (const bad of [
      neither,
      { ...item, questionId: '6f1c1f0e-3b7a-4c1e-9a43-0d1d3c3b2a10' },
    ])
      expect(calibrationFixtureSchema.safeParse([bad]).success).toBe(false);
  });

  it('rejects levels outside 1–5, unknown dimensions and typed delivery metrics', () => {
    for (const bad of [
      { ...item, humanScores: { ...all(3), content: 6 } },
      { ...item, humanScores: { ...all(3), tone: 3 } },
      {
        ...item,
        delivery: {
          wpm: 140,
          fillerCount: 1,
          pauseCount: 0,
          longestPauseS: 0,
          durationS: 30,
        },
      },
    ])
      expect(calibrationFixtureSchema.safeParse([bad]).success).toBe(false);
  });
});

describe('summarise', () => {
  it('computes exact, within ±1, MAE, bias, buckets and the confusion matrix', () => {
    const r = summarise([
      result(all(3), all(3)),
      result(all(3), all(4)),
      result(all(2), all(5)),
      result(all(5), all(4)),
      result(all(1), null),
    ]);
    const c = r.overall.dimensions.content;
    expect(r.scored).toBe(4);
    expect(r.failed).toBe(1);
    expect(c).toMatchObject({
      n: 4,
      exact: 0.25,
      within1: 0.75,
      mae: 5 / 4,
      bias: 3 / 4,
      diffs: [0, 1, 1, 1, 1],
    });
    expect(c.confusion[2]).toEqual([0, 0, 1, 1, 0]);
    expect(c.confusion[1][4]).toBe(1);
    expect(c.confusion[4][3]).toBe(1);
  });

  it('meets agreement at exactly 80% within ±1, not below', () => {
    const eight = Array.from({ length: 8 }, () => result(all(3), all(4)));
    const at = summarise([
      ...eight,
      result(all(1), all(5)),
      result(all(5), all(1)),
    ]);
    expect(at.overall.dimensions.relevance.within1).toBe(0.8);
    expect(at.overall.agreementMet).toBe(true);
    const below = summarise([
      ...eight.slice(1),
      result(all(1), all(5)),
      result(all(5), all(1)),
      result(all(5), all(1)),
    ]);
    expect(below.overall.agreementMet).toBe(false);
  });

  it('passes only with ≥ 30 scored answers and agreement in every role', () => {
    const role = (slug: string, n: number) =>
      Array.from({ length: n }, (_, i) => result(all(3), all(3), slug, i));
    expect(summarise([...role('a', 30), ...role('b', 30)]).pass).toBe(true);
    const short = summarise([...role('a', 30), ...role('b', 29)]);
    expect(short.sampleSufficient).toBe(false);
    expect(short.pass).toBe(false);
    expect(verdictText(short)).toBe(
      'FAIL: fewer than 30 scored answers (b 29)',
    );
    const failedOnly = summarise([
      ...role('a', 30),
      ...Array.from({ length: 30 }, () => result(all(3), null, 'b')),
    ]);
    expect(failedOnly.roles.b.agreementMet).toBe(false);
    expect(failedOnly.pass).toBe(false);
  });
});

describe('estimateCallUsd', () => {
  it('prices known Gemini models and returns null for unknown ones', () => {
    expect(estimateCallUsd('gemini-3.8-flash', 4000)).toBeGreaterThan(0);
    expect(estimateCallUsd('unknown-model', 4000)).toBeNull();
  });
});

describe('renderMarkdown', () => {
  it('reports the prompt version, cost, verdict and per-item scores', () => {
    const info: RunInfo = {
      fixture: 'sample.json',
      description: 'Illustrative sample',
      provider: 'fake',
      evaluatorPrompt: {
        version: 3,
        model: 'gemini-3.8-flash',
        temperature: 0.2,
        thinkingLevel: 'low',
      },
      promptVersionsSeen: [3],
      selected: 2,
      limit: null,
      maxUsd: 1,
      estimatedUsd: 0.004,
      actualUsd: 0.003,
      calls: 2,
      unpricedCalls: 0,
      aborted: null,
    };
    const results = [result(all(3), all(4)), result(all(2), null)];
    const md = renderMarkdown(info, summarise(results), results);
    expect(md).toContain('prompt version 3 (gemini-3.8-flash');
    expect(md).toContain('estimated $0.0040, actual $0.0030');
    expect(md).toContain('**Verdict: FAIL: fewer than 30 scored answers');
    expect(md).toContain(
      '| 0 |  | role-a | q1 | typed | 3/3/3/3 | 4/4/4/4 | ok |',
    );
    expect(md).toContain('ai_unavailable');
  });
});
