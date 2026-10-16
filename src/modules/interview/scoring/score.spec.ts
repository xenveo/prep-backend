import { DEFAULT_ROLE_SETTINGS } from '../types.js';
import {
  BAND_MESSAGES,
  SKIPPED_RETRY_LEARNING,
  attemptScore,
  bandFor,
  dimensionScoresFromLevels,
  learningScore,
  levelToScore,
  sessionScore,
  skillsAverage,
} from './score.js';

const { dimensionWeights, sessionWeights } = DEFAULT_ROLE_SETTINGS;

describe('levelToScore', () => {
  it('maps 1..5 to 0..100 in steps of 25', () => {
    expect([1, 2, 3, 4, 5].map(levelToScore)).toEqual([0, 25, 50, 75, 100]);
  });

  it('rejects levels outside 1..5', () => {
    expect(() => levelToScore(0)).toThrow(RangeError);
    expect(() => levelToScore(2.5)).toThrow(RangeError);
  });

  it('maps a full level set', () => {
    expect(
      dimensionScoresFromLevels({
        content: 4,
        structure: 3,
        delivery: 5,
        relevance: 1,
      }),
    ).toEqual({ content: 75, structure: 50, delivery: 100, relevance: 0 });
  });
});

describe('attemptScore', () => {
  it("reproduces the admin UI's 52 example", () => {
    expect(
      attemptScore(
        { content: 52, structure: 40, delivery: 58, relevance: 60 },
        dimensionWeights,
      ),
    ).toBe(52);
  });

  it('applies custom weights', () => {
    expect(
      attemptScore(
        { content: 100, structure: 0, delivery: 0, relevance: 0 },
        { content: 25, structure: 25, delivery: 25, relevance: 25 },
      ),
    ).toBe(25);
  });
});

describe('learningScore', () => {
  it('credits applied 1, partly 0.5, not applied 0', () => {
    expect(
      learningScore([
        { status: 'applied' },
        { status: 'partly' },
        { status: 'not_applied' },
      ]),
    ).toBe(50);
    expect(learningScore([{ status: 'applied' }, { status: 'applied' }])).toBe(
      100,
    );
    expect(
      learningScore([
        { status: 'partly' },
        { status: 'applied' },
        { status: 'applied' },
      ]),
    ).toBe(83);
  });

  it('is 0 with no points', () => {
    expect(learningScore([])).toBe(0);
  });
});

describe('sessionScore', () => {
  it("reproduces the admin UI's 78 example (62/80/86)", () => {
    const r = sessionScore(
      [{ first: 62, second: 80, learning: 86 }],
      sessionWeights,
    );
    expect(r.score).toBe(78);
    expect(r.band).toBe('nearly_ready');
  });

  it('counts a skipped retry as A2 = A1 and L = 50 (no change)', () => {
    const r = sessionScore(
      [{ first: 60, second: null, learning: null }],
      sessionWeights,
    );
    expect(SKIPPED_RETRY_LEARNING).toBe(50);
    expect(r.firstTryAvg).toBe(60);
    expect(r.retryAvg).toBe(60);
    expect(r.learningAvg).toBe(50);
    // 0.2·60 + 0.55·60 + 0.25·50 = 12 + 33 + 12.5 = 57.5 → 58
    expect(r.score).toBe(58);
  });

  it('scores a skipped retry like a retry with no improvement', () => {
    expect(
      sessionScore(
        [{ first: 60, second: null, learning: null }],
        sessionWeights,
      ),
    ).toEqual(
      sessionScore([{ first: 60, second: 60, learning: 50 }], sessionWeights),
    );
  });

  it('mixes skipped and retried questions', () => {
    const r = sessionScore(
      [
        { first: 60, second: 80, learning: 100 },
        { first: 40, second: null, learning: null },
      ],
      sessionWeights,
    );
    expect(r.firstTryAvg).toBe(50);
    expect(r.retryAvg).toBe(60);
    expect(r.learningAvg).toBe(75);
    // 0.2·50 + 0.55·60 + 0.25·75 = 10 + 33 + 18.75 = 61.75 → 62
    expect(r.score).toBe(62);
  });

  it('scores every retry skipped', () => {
    const r = sessionScore(
      [
        { first: 90, second: null, learning: null },
        { first: 80, second: null, learning: null },
      ],
      sessionWeights,
    );
    expect(r.firstTryAvg).toBe(85);
    expect(r.retryAvg).toBe(85);
    expect(r.learningAvg).toBe(50);
    // 0.2·85 + 0.55·85 + 0.25·50 = 17 + 46.75 + 12.5 = 76.25 → 76
    expect(r.score).toBe(76);
    expect(r.band).toBe('nearly_ready');
  });

  it.each([
    [49, 49, 'not_ready'],
    [50, 50, 'developing'],
    [75, 69, 'developing'],
    [77, 70, 'nearly_ready'],
    [95, 84, 'nearly_ready'],
    [97, 85, 'interview_ready'],
  ] as const)(
    'all skipped at first try %i → %i, %s (band edges)',
    (first, score, band) => {
      const r = sessionScore(
        [{ first, second: null, learning: null }],
        sessionWeights,
      );
      expect(r.score).toBe(score);
      expect(r.band).toBe(band);
    },
  );

  it('ignores a stale learning value on a skipped retry', () => {
    const r = sessionScore(
      [{ first: 70, second: null, learning: 90 }],
      sessionWeights,
    );
    expect(r.learningAvg).toBe(50);
    // 0.2·70 + 0.55·70 + 0.25·50 = 14 + 38.5 + 12.5 = 65
    expect(r.score).toBe(65);
  });

  it('is zero for no questions', () => {
    expect(sessionScore([], sessionWeights)).toEqual({
      firstTryAvg: 0,
      retryAvg: 0,
      learningAvg: 0,
      score: 0,
      band: 'not_ready',
    });
  });
});

describe('bandFor', () => {
  it.each([
    [0, 'not_ready'],
    [49, 'not_ready'],
    [50, 'developing'],
    [69, 'developing'],
    [70, 'nearly_ready'],
    [84, 'nearly_ready'],
    [85, 'interview_ready'],
    [100, 'interview_ready'],
  ] as const)('%i → %s', (score, band) => {
    expect(bandFor(score)).toBe(band);
  });

  it('has an SRS 5.4 message per band', () => {
    expect(BAND_MESSAGES.developing).toBe('Review flash cards and retake');
    expect(Object.keys(BAND_MESSAGES)).toHaveLength(4);
  });
});

describe('skillsAverage', () => {
  it('averages each dimension and rounds', () => {
    expect(
      skillsAverage([
        { content: 50, structure: 25, delivery: 75, relevance: 100 },
        { content: 75, structure: 50, delivery: 75, relevance: 50 },
        { content: 75, structure: 50, delivery: 50, relevance: 50 },
      ]),
    ).toEqual({ content: 67, structure: 42, delivery: 67, relevance: 67 });
  });
});
