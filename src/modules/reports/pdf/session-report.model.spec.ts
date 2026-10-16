import type {
  CandidateAttempt,
  CandidateSession,
} from '../../interview/types.js';
import type { SessionReview, Try } from '../reports.types.js';
import {
  fromCandidateSession,
  fromSessionReview,
} from './session-report.model.js';

const scores = { content: 70, structure: 60, delivery: 80, relevance: 75 };

const attempt = (
  attemptNo: 1 | 2,
  over: Partial<CandidateAttempt['feedback']> = {},
): CandidateAttempt => ({
  id: `a${attemptNo}`,
  attemptNo,
  mode: attemptNo === 1 ? 'voice' : 'typed',
  transcript: `Answer ${attemptNo}`,
  durationSec: 90,
  feedback: {
    score: attemptNo === 1 ? 62 : 81,
    subScores: scores,
    worked: ['Clear opening', '  '],
    improve: ['Add a result'],
    opener: '',
    delivery: [
      {
        key: 'pace',
        label: 'Pace',
        valueText: '172 wpm · a bit fast',
        value: 172,
        scale: { min: 60, max: 240 },
        target: { min: 120, max: 160 },
        targetText: 'Target 120–160',
        note: '',
        inTarget: false,
      },
    ],
    audioSeconds: 0,
    focus: [],
    ...over,
  },
  audioUrl: null,
  feedbackAudioUrl: null,
  submittedAt: '2026-10-16T05:00:00.000Z',
});

const question = (index: number) => ({
  id: `q${index}`,
  index,
  text: `Question text ${index}`,
  cardId: 0,
  category: 'Behavioural',
});

const candidateSession = (
  over: Partial<CandidateSession> = {},
): CandidateSession => ({
  id: 's1',
  roleId: 'customer-support',
  number: 3,
  mode: 'voice',
  startedAt: '2026-10-16T05:00:00.000Z',
  completedAt: '2026-10-16T05:24:20.000Z',
  score: 78,
  band: 'nearly-ready',
  bandMessage: 'Solid base; fix the listed focus areas',
  skills: scores,
  strengths: [{ text: 'Empathy', cardId: 1 }],
  focus: [{ text: 'Quantify results', cardId: 2 }],
  results: [
    {
      question: question(1),
      first: attempt(1),
      second: attempt(2),
      applied: [
        { label: 'Add a result', status: 'not-yet', evidence: 'No number' },
      ],
    },
    { question: question(2), first: attempt(1), second: null, applied: [] },
  ],
  firstAttemptAvg: 62,
  retryAvg: 71.5,
  learningAvg: 50,
  ...over,
});

const adminTry = (attempt: 1 | 2, over: Partial<Try> = {}): Try => ({
  attempt,
  mode: 'voice',
  score: attempt === 1 ? 60 : 75,
  band: 'developing',
  audioSeconds: 98,
  audioLabel: '1:38',
  subScores: scores,
  transcript: 'Answer',
  highlights: [],
  worked: 'Clear. Specific.',
  improve: '',
  delivery: {
    wpm: 142,
    paceLabel: 'steady',
    fillerWords: 2,
    longestPauseSec: 1.5,
  },
  audioUrl: null,
  ...over,
});

const review = (over: Partial<SessionReview> = {}): SessionReview => ({
  sessionId: 's2',
  candidateId: 'c1',
  candidateName: 'Alpha Rao',
  roleId: 'r1',
  roleTitle: 'Support Associate',
  sessionNumber: 2,
  date: '2026-10-11T10:00:00.000Z',
  durationMin: 24,
  score: 72,
  band: 'nearly',
  changeVsPrevious: 27,
  firstTryAvg: 55,
  secondTryAvg: 62.5,
  learningScore: 50,
  hasDetail: true,
  questions: [
    {
      n: 1,
      text: 'Handle an upset customer',
      category: 'behavioural',
      firstScore: 70,
      secondScore: null,
      retrySkipped: true,
      tries: [adminTry(1, { score: 70 })],
    },
    {
      n: 2,
      text: 'Explain a refund',
      category: 'role_knowledge',
      firstScore: 60,
      secondScore: 75,
      retrySkipped: false,
      tries: [
        adminTry(1),
        adminTry(2, {
          mode: 'typed',
          delivery: null,
          appliedFromFeedback: [
            { text: 'Add a result', state: 'partial', detail: 'Mentioned it' },
            { text: 'Name the policy', state: 'done' },
            { text: 'Close the loop', state: 'missed' },
          ],
        }),
      ],
    },
  ],
  weights: { firstTry: 20, secondTry: 55, learning: 25 },
  formulaText: '20% first try + 55% second try + 25% learning = 72',
  ...over,
});

describe('fromCandidateSession', () => {
  it('maps the summary with the human band label and duration', () => {
    const m = fromCandidateSession(
      candidateSession(),
      ' Neha Kapoor ',
      'Customer Support',
    );
    expect(m).toMatchObject({
      candidateName: 'Neha Kapoor',
      roleTitle: 'Customer Support',
      sessionNumber: 3,
      date: '2026-10-16T05:24:20.000Z',
      durationMin: 24,
      score: 78,
      bandLabel: 'Nearly ready',
      bandMessage: 'Solid base; fix the listed focus areas',
      firstTryAvg: 62,
      secondTryAvg: 71.5,
      learningScore: 50,
      formulaText: null,
      strengths: ['Empathy'],
      focus: ['Quantify results'],
    });
  });

  it.each([
    ['not-ready', 'Not ready yet'],
    ['developing', 'Developing'],
    ['nearly-ready', 'Nearly ready'],
    ['interview-ready', 'Interview ready'],
  ] as const)('labels band %s as "%s"', (band, label) => {
    expect(
      fromCandidateSession(candidateSession({ band }), null, 'R').bandLabel,
    ).toBe(label);
  });

  it('maps tries, applied items and a skipped retry', () => {
    const [q1, q2] = fromCandidateSession(
      candidateSession(),
      null,
      'R',
    ).questions;
    expect(q1).toMatchObject({
      position: 1,
      text: 'Question text 1',
      category: 'Behavioural',
      retrySkipped: false,
      first: {
        mode: 'voice',
        score: 62,
        subScores: scores,
        worked: ['Clear opening'],
        improve: ['Add a result'],
        transcript: 'Answer 1',
        delivery: [
          {
            label: 'Pace',
            value: '172 wpm · a bit fast',
            note: 'Target 120–160',
          },
        ],
      },
      second: { mode: 'typed', score: 81, delivery: null },
      applied: [
        { label: 'Add a result', status: 'not_yet', evidence: 'No number' },
      ],
    });
    expect(q2).toMatchObject({ second: null, retrySkipped: true, applied: [] });
  });

  it('has no delivery for a voice try without metrics', () => {
    const s = candidateSession();
    s.results[0].first = attempt(1, { delivery: [] });
    expect(
      fromCandidateSession(s, null, 'R').questions[0].first.delivery,
    ).toBeNull();
  });

  it('treats a blank name as no name', () => {
    expect(
      fromCandidateSession(candidateSession(), '  ', 'R').candidateName,
    ).toBeNull();
  });
});

describe('fromSessionReview', () => {
  it('maps the summary; the band message comes from the band', () => {
    const m = fromSessionReview(review());
    expect(m).toMatchObject({
      candidateName: 'Alpha Rao',
      roleTitle: 'Support Associate',
      sessionNumber: 2,
      date: '2026-10-11T10:00:00.000Z',
      durationMin: 24,
      score: 72,
      bandLabel: 'Nearly ready',
      bandMessage: 'Solid base; fix the listed focus areas',
      firstTryAvg: 55,
      secondTryAvg: 62.5,
      learningScore: 50,
      formulaText: '20% first try + 55% second try + 25% learning = 72',
      strengths: [],
      focus: [],
    });
    expect(fromSessionReview(review({ band: 'not_ready' })).bandLabel).toBe(
      'Not ready yet',
    );
  });

  it('normalises string feedback to lists and maps applied states', () => {
    const [q1, q2] = fromSessionReview(review()).questions;
    expect(q1).toMatchObject({
      position: 1,
      category: 'Behavioural',
      retrySkipped: true,
      second: null,
      applied: [],
      first: { score: 70, worked: ['Clear. Specific.'], improve: [] },
    });
    expect(q1.first.delivery).toEqual([
      { label: 'Pace', value: '142 wpm, steady' },
      { label: 'Filler words', value: '2' },
      { label: 'Longest pause', value: '1.5 s' },
    ]);
    expect(q2.category).toBe('Role knowledge');
    expect(q2.second?.delivery).toBeNull();
    expect(q2.second).toMatchObject({ mode: 'typed', score: 75 });
    expect(q2.applied).toEqual([
      { label: 'Add a result', status: 'partly', evidence: 'Mentioned it' },
      { label: 'Name the policy', status: 'applied', evidence: '' },
      { label: 'Close the loop', status: 'not_yet', evidence: '' },
    ]);
  });

  it('words missing pace labels and unmeasured pauses like the review page', () => {
    const r = review();
    r.questions[0].tries[0] = adminTry(1, {
      delivery: { wpm: 120, fillerWords: 0, longestPauseSec: null },
    });
    expect(fromSessionReview(r).questions[0].first.delivery).toEqual([
      { label: 'Pace', value: '120 wpm' },
      { label: 'Filler words', value: '0' },
      { label: 'Longest pause', value: 'Not measured' },
    ]);
  });

  it('keeps only the summary without detail', () => {
    const m = fromSessionReview(review({ hasDetail: false }));
    expect(m.questions).toEqual([]);
    expect(m.score).toBe(72);
  });
});
