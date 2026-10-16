import { flagTitle } from './flags.service.js';
import {
  type ReviewAttempt,
  sessionFormulaText,
  toReviewQuestion,
  toTry,
} from './session-review.mapper.js';
import type { Try } from './reports.types.js';

const attempt = (over: Partial<ReviewAttempt> = {}): ReviewAttempt => ({
  attemptNo: 1,
  score: 69,
  durationS: 98.4,
  dimensionScores: { content: 75, structure: 50, delivery: 75, relevance: 75 },
  transcript: 'I listened first.',
  feedback: {
    worked: ['Clear opening.', 'Good example.'],
    improve: ['Add the result.'],
    highlights: [{ quote: 'listened first', kind: 'match', note: 'Empathy' }],
    applied: [],
  },
  wpm: 172,
  fillerCount: 3,
  pauseCount: 4,
  longestPauseS: 2.1,
  ...over,
});

describe('sessionFormulaText', () => {
  it('matches the admin UI sentence', () => {
    expect(
      sessionFormulaText(78, { firstTry: 20, secondTry: 55, learning: 25 }),
    ).toBe('20% first try + 55% second try + 25% learning = 78');
  });
});

describe('toTry', () => {
  it('maps an attempt to the admin Try shape', () => {
    expect(toTry(attempt(), 'https://signed')).toEqual({
      attempt: 1,
      score: 69,
      band: 'developing',
      audioSeconds: 98,
      audioLabel: '1:38',
      subScores: { content: 75, structure: 50, delivery: 75, relevance: 75 },
      transcript: 'I listened first.',
      highlights: [{ text: 'listened first', kind: 'match', note: 'Empathy' }],
      worked: 'Clear opening. Good example.',
      improve: 'Add the result.',
      delivery: {
        wpm: 172,
        paceLabel: 'fast',
        fillerWords: 3,
        longestPauseSec: 2.1,
      },
      audioUrl: 'https://signed',
    });
  });

  it('maps applied points on the second try and has no delivery for typed answers', () => {
    const t = toTry(
      attempt({
        attemptNo: 2,
        score: 70,
        wpm: null,
        fillerCount: null,
        pauseCount: null,
        longestPauseS: null,
        feedback: {
          worked: [],
          improve: [],
          highlights: [],
          applied: [
            {
              point: 'State the result',
              status: 'applied',
              evidence: 'Said 20%',
            },
            { point: 'Shorter intro', status: 'not_applied', evidence: '' },
          ],
        },
      }),
      null,
    );
    expect(t.band).toBe('nearly');
    expect(t.delivery).toBeNull();
    expect(t.appliedFromFeedback).toEqual([
      { text: 'State the result', state: 'done', detail: 'Said 20%' },
      { text: 'Shorter intro', state: 'missed' },
    ]);
  });
});

describe('toReviewQuestion', () => {
  const question = (retrySkipped: boolean, second: Try | null) =>
    toReviewQuestion({
      position: 2,
      text: 'Q',
      category: 'behavioural',
      retrySkipped,
      first: toTry(attempt(), null),
      second,
    });

  it('a skipped retry has one try and a null second score, not A2 = A1', () => {
    const q = question(true, null);
    expect(q).toMatchObject({
      n: 2,
      firstScore: 69,
      secondScore: null,
      retrySkipped: true,
    });
    expect(q.tries).toHaveLength(1);
  });

  it('a retry that was never answered also has a null second score', () => {
    const q = question(false, null);
    expect(q).toMatchObject({ secondScore: null, retrySkipped: false });
    expect(q.tries).toHaveLength(1);
  });

  it('an answered retry reports both scores and both tries', () => {
    const second = toTry(attempt({ attemptNo: 2, score: 80 }), null);
    const q = question(false, second);
    expect(q).toMatchObject({
      firstScore: 69,
      secondScore: 80,
      retrySkipped: false,
    });
    expect(q.tries).toEqual([q.tries[0], second]);
  });

  it('ignores a stray attempt 2 on a skipped retry', () => {
    const second = toTry(attempt({ attemptNo: 2, score: 80 }), null);
    const q = question(true, second);
    expect(q).toMatchObject({ secondScore: null, retrySkipped: true });
    expect(q.tries).toHaveLength(1);
  });
});

describe('flagTitle', () => {
  it('reads like the admin UI', () => {
    expect(flagTitle(2, 4, 'delivery')).toBe('Session 2 · Q4 · Delivery');
  });
});
