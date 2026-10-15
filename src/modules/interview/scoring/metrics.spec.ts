import type { Word } from '../types.js';
import { FILLER_LEXICON, computeMetrics, countFillers } from './metrics.js';

/** Words spaced evenly, 0.3 s each with 0.1 s gaps. */
function words(text: string, start = 0): Word[] {
  return text
    .split(' ')
    .map((w, i) => ({ w, start: start + i * 0.4, end: start + i * 0.4 + 0.3 }));
}

describe('countFillers', () => {
  it('counts single-word fillers', () => {
    expect(
      countFillers(
        words('um I think uh the answer is er basically yes actually'),
      ),
    ).toBe(5);
  });

  it('counts multi-word fillers once', () => {
    expect(
      countFillers(
        words(
          'so you know I was sort of nervous and I mean it was kind of hard',
        ),
      ),
    ).toBe(4);
  });

  it('skips literal "you know", "kind of" and "sort of"', () => {
    expect(
      countFillers(words('do you know what kind of tool and a sort of plan')),
    ).toBe(0);
  });

  it('applies the "like" heuristic', () => {
    expect(countFillers(words('I like helping people'))).toBe(0);
    expect(countFillers(words('it looks like a bug'))).toBe(0);
    expect(countFillers(words('something like that'))).toBe(0);
    expect(countFillers(words('it was like really busy'))).toBe(1);
    expect(countFillers(words('and like we fixed it'))).toBe(1);
    expect(countFillers(words('Like, I fixed it'))).toBe(1);
    expect(countFillers(words('we were, like, stuck'))).toBe(1);
  });

  it('ignores case and punctuation', () => {
    expect(countFillers(words('Um, the customer... Uh. Basically!'))).toBe(3);
  });

  it('exports the plan §6 lexicon', () => {
    expect(FILLER_LEXICON).toContain('you know');
    expect(FILLER_LEXICON).toHaveLength(10);
  });
});

describe('computeMetrics', () => {
  it('computes wpm over first start → last end', () => {
    // 10 words, first start 0, last end 3.9 → 10 / 3.9 × 60 ≈ 154
    const m = computeMetrics(
      words('one two three four five six seven eight nine ten'),
      5,
    );
    expect(m.wpm).toBe(154);
    expect(m.durationS).toBe(5);
    expect(m.pauseCount).toBe(0);
  });

  it('counts gaps over 1.0 s as pauses and keeps the longest gap', () => {
    const w: Word[] = [
      { w: 'first', start: 0, end: 0.5 },
      { w: 'second', start: 1.5, end: 2 }, // 1.0 s: not a pause
      { w: 'third', start: 3.2, end: 3.6 }, // 1.2 s
      { w: 'fourth', start: 6.1, end: 6.5 }, // 2.5 s
    ];
    const m = computeMetrics(w, 7);
    expect(m.pauseCount).toBe(2);
    expect(m.longestPauseS).toBe(2.5);
  });

  it('handles no words', () => {
    expect(computeMetrics([], 3)).toEqual({
      wpm: 0,
      fillerCount: 0,
      pauseCount: 0,
      longestPauseS: 0,
      durationS: 3,
    });
  });
});
