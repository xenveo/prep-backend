import type { StoredFeedback } from '../types.js';
import {
  toAppliedItems,
  toCandidateAttempt,
  toInterviewQuestion,
  toQuestionResult,
  toSessionReport,
  toSessionSummary,
  type AttemptRow,
  type SessionQuestionRow,
  type SessionReportRow,
} from './candidate.serializer.js';

const sq = (over: Partial<SessionQuestionRow> = {}): SessionQuestionRow => ({
  position: 2,
  retrySkipped: false,
  question: {
    id: 'q-1',
    text: 'Tell me about a time…',
    category: 'behavioural',
    card: { position: 4 },
  },
  ...over,
});

const feedback = (over: Partial<StoredFeedback> = {}): StoredFeedback => ({
  worked: ['Clear example'],
  improve: ['End with the result'],
  opener: 'In my last role…',
  focus: ['End with the result', "Say 'I'"],
  improvementPoints: ['End with the result', "Say 'I'"],
  deliveryNotes: 'Steady.',
  spokenSummary: 'Nice work.',
  followUp: null,
  applied: [],
  highlights: [],
  delivery: [],
  audioSeconds: 12,
  ...over,
});

const attempt = (over: Partial<AttemptRow> = {}): AttemptRow => ({
  id: 'a-1',
  attemptNo: 1,
  mode: 'voice',
  transcript: 'I helped a customer.',
  durationS: 61.6,
  score: 62,
  dimensionScores: { content: 75, structure: 50, delivery: 50, relevance: 50 },
  feedback: feedback(),
  audioKey: 'audio/s/a-1.webm',
  feedbackAudioKey: null,
  submittedAt: new Date('2026-10-15T10:00:00Z'),
  ...over,
});

describe('toInterviewQuestion', () => {
  it('maps position, card position and the category label', () => {
    expect(toInterviewQuestion(sq())).toEqual({
      id: 'q-1',
      index: 2,
      text: 'Tell me about a time…',
      cardId: 4,
      category: 'Behavioural',
    });
  });

  it('uses card 0 when the question has no card', () => {
    expect(
      toInterviewQuestion(sq({ question: { ...sq().question, card: null } }))
        .cardId,
    ).toBe(0);
  });
});

describe('toCandidateAttempt', () => {
  it('maps the stored evaluation to the candidate shape', () => {
    expect(toCandidateAttempt(attempt())).toEqual({
      id: 'a-1',
      attemptNo: 1,
      mode: 'voice',
      transcript: 'I helped a customer.',
      durationSec: 62,
      feedback: {
        score: 62,
        subScores: { content: 75, structure: 50, delivery: 50, relevance: 50 },
        worked: ['Clear example'],
        improve: ['End with the result'],
        opener: 'In my last role…',
        delivery: [],
        audioSeconds: 12,
        focus: ['End with the result', "Say 'I'"],
      },
      audioUrl: '/api/attempts/a-1/audio',
      feedbackAudioUrl: null,
      submittedAt: '2026-10-15T10:00:00.000Z',
    });
  });

  it('links feedback audio and omits answer audio when absent', () => {
    const a = toCandidateAttempt(
      attempt({ audioKey: null, feedbackAudioKey: 'tts/x.mp3' }),
    );
    expect(a.audioUrl).toBeNull();
    expect(a.feedbackAudioUrl).toBe('/api/attempts/a-1/feedback-audio');
  });

  it('rejects an attempt without an evaluation', () => {
    expect(() =>
      toCandidateAttempt(attempt({ feedback: null, score: null })),
    ).toThrow();
  });
});

describe('toAppliedItems', () => {
  it('uses the candidate spelling', () => {
    expect(
      toAppliedItems([
        {
          point: 'End with the result',
          status: 'not_applied',
          evidence: 'Not yet.',
        },
        { point: "Say 'I'", status: 'partly', evidence: 'In places.' },
      ]),
    ).toEqual([
      { label: 'End with the result', status: 'not-yet', evidence: 'Not yet.' },
      { label: "Say 'I'", status: 'partly', evidence: 'In places.' },
    ]);
  });
});

describe('toQuestionResult', () => {
  const second = attempt({
    id: 'a-2',
    attemptNo: 2,
    score: 80,
    feedback: feedback({
      applied: [
        { point: 'End with the result', status: 'applied', evidence: 'Done.' },
      ],
    }),
  });

  it('includes the retry and its applied items', () => {
    const r = toQuestionResult(sq(), attempt(), second);
    expect(r.second?.id).toBe('a-2');
    expect(r.applied).toEqual([
      { label: 'End with the result', status: 'applied', evidence: 'Done.' },
    ]);
  });

  it('returns second: null and no applied items when the retry was skipped', () => {
    const r = toQuestionResult(sq({ retrySkipped: true }), attempt(), null);
    expect(r.second).toBeNull();
    expect(r.applied).toEqual([]);
  });
});

const session: SessionReportRow = {
  id: 's-1',
  jobRoleId: 'r-1',
  number: 2,
  mode: 'typed',
  startedAt: new Date('2026-10-15T09:00:00Z'),
  completedAt: new Date('2026-10-15T09:30:00Z'),
  score: 78,
  band: 'nearly_ready',
  bandMessage: null,
  skills: { content: 70, structure: 60, delivery: 65, relevance: 80 },
  strengths: [{ text: 'Clear examples', cardId: 3 }],
  focusAreas: [{ text: 'End with the result', cardId: 5 }],
  firstTryAvg: 62,
  retryAvg: 80,
  learningAvg: 86,
};

describe('toSessionReport', () => {
  it('maps a completed session', () => {
    const r = toSessionReport(session, []);
    expect(r).toMatchObject({
      id: 's-1',
      roleId: 'r-1',
      number: 2,
      mode: 'typed',
      startedAt: '2026-10-15T09:00:00.000Z',
      completedAt: '2026-10-15T09:30:00.000Z',
      score: 78,
      band: 'nearly-ready',
      bandMessage: 'Solid base; fix the listed focus areas',
      focus: [{ text: 'End with the result', cardId: 5 }],
      firstAttemptAvg: 62,
      retryAvg: 80,
      learningAvg: 86,
      results: [],
    });
  });

  it('rejects an incomplete session', () => {
    expect(() =>
      toSessionReport(
        { ...session, completedAt: null, score: null, band: null },
        [],
      ),
    ).toThrow();
  });
});

describe('toSessionSummary', () => {
  it('maps the summary row', () => {
    expect(toSessionSummary(session)).toEqual({
      id: 's-1',
      number: 2,
      startedAt: '2026-10-15T09:00:00.000Z',
      score: 78,
      band: 'nearly-ready',
    });
  });
});
