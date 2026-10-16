import type { Word } from '../types.js';
import {
  FILLER_LEXICON,
  computeMetrics,
  countFillers,
  pausesFromWords,
  type MetricsInput,
} from './metrics.js';

describe('countFillers', () => {
  it('counts single-word fillers', () => {
    expect(
      countFillers('um I think uh the answer is er basically yes actually'),
    ).toBe(5);
  });

  it('counts multi-word fillers once', () => {
    expect(
      countFillers(
        'so you know I was sort of nervous and I mean it was kind of hard',
      ),
    ).toBe(4);
  });

  it('skips literal "you know", "kind of" and "sort of"', () => {
    expect(
      countFillers('do you know what kind of tool and a sort of plan'),
    ).toBe(0);
  });

  it('applies the "like" heuristic', () => {
    expect(countFillers('I like helping people')).toBe(0);
    expect(countFillers('it looks like a bug')).toBe(0);
    expect(countFillers('something like that')).toBe(0);
    expect(countFillers('it was like really busy')).toBe(1);
    expect(countFillers('and like we fixed it')).toBe(1);
    expect(countFillers('Like, I fixed it')).toBe(1);
    expect(countFillers('we were, like, stuck')).toBe(1);
  });

  it('ignores case and punctuation', () => {
    expect(countFillers('Um, the customer... Uh. Basically!')).toBe(3);
  });

  it('exports the plan §6 lexicon', () => {
    expect(FILLER_LEXICON).toContain('you know');
    expect(FILLER_LEXICON).toHaveLength(10);
  });
});

describe('pausesFromWords', () => {
  it('counts gaps over 1.0 s as pauses and keeps the longest gap', () => {
    const w: Word[] = [
      { w: 'first', start: 0, end: 0.5 },
      { w: 'second', start: 1.5, end: 2 }, // 1.0 s: not a pause
      { w: 'third', start: 3.2, end: 3.6 }, // 1.2 s
      { w: 'fourth', start: 6.1, end: 6.5 }, // 2.5 s
    ];
    expect(pausesFromWords(w)).toEqual({ pauseCount: 2, longestPauseS: 2.5 });
  });

  it('is null without timestamps', () => {
    expect(pausesFromWords([])).toBeNull();
    expect(pausesFromWords([{ w: ' ', start: 0, end: 1 }])).toBeNull();
  });
});

describe('computeMetrics', () => {
  const TEXT = 'Um, I listened first, and like we fixed it the same day.';
  const input = (over: Partial<MetricsInput> = {}): MetricsInput => ({
    text: TEXT,
    words: [],
    durationS: 30,
    speakingS: 6,
    pauses: { pauseCount: 3, longestPauseS: 2.36 },
    ...over,
  });

  it('wpm = transcript words ÷ speaking time; fillers from the text; pauses from the upload', () => {
    // 12 words over 6 s of speech → 120 wpm
    expect(computeMetrics(input())).toEqual({
      wpm: 120,
      fillerCount: 2,
      pauseCount: 3,
      longestPauseS: 2.4,
      durationS: 30,
    });
  });

  it('falls back to the answer duration without speaking time', () => {
    // 12 words over 30 s → 24 wpm
    expect(computeMetrics(input({ speakingS: null })).wpm).toBe(24);
    expect(computeMetrics(input({ speakingS: null, durationS: 0 })).wpm).toBe(
      0,
    );
  });

  it('does not count stray punctuation as words', () => {
    expect(
      computeMetrics(input({ text: 'one — two , three', speakingS: 3 })).wpm,
    ).toBe(60);
  });

  it('prefers upload pauses over word timestamps', () => {
    const words: Word[] = [
      { w: 'a', start: 0, end: 0.3 },
      { w: 'b', start: 5, end: 5.3 },
    ];
    expect(computeMetrics(input({ words })).pauseCount).toBe(3);
  });

  it('falls back to word timestamps, then to not measured', () => {
    const words: Word[] = [
      { w: 'a', start: 0, end: 0.3 },
      { w: 'b', start: 1.8, end: 2.1 },
    ];
    expect(computeMetrics(input({ pauses: null, words }))).toMatchObject({
      pauseCount: 1,
      longestPauseS: 1.5,
    });
    expect(computeMetrics(input({ pauses: null }))).toMatchObject({
      pauseCount: null,
      longestPauseS: null,
    });
  });

  it('handles an empty transcript', () => {
    expect(computeMetrics(input({ text: '', pauses: null }))).toEqual({
      wpm: 0,
      fillerCount: 0,
      pauseCount: null,
      longestPauseS: null,
      durationS: 30,
    });
  });
});
