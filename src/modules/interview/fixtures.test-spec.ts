// Shared unit-test builders for interview sessions and attempts. The -spec.ts suffix keeps it out of the build.
import type { Attempt } from '../../generated/prisma/client.js';
import type { LoadedSession } from './session-state.js';
import type { DimensionScores, StoredFeedback } from './types.js';

export const SESSION_ID = '11111111-1111-4111-8111-111111111111';
export const ROLE_ID = '22222222-2222-4222-8222-222222222222';
export const USER_ID = '33333333-3333-4333-8333-333333333333';
export const qid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

export function feedback(over: Partial<StoredFeedback> = {}): StoredFeedback {
  return {
    worked: ['Clear opening'],
    improve: ['Add a result'],
    opener: 'Start with the situation',
    focus: ['Result'],
    improvementPoints: ['Add a result'],
    deliveryNotes: '',
    spokenSummary: 'Nice work.',
    followUp: null,
    applied: [],
    highlights: [],
    delivery: [],
    audioSeconds: 20,
    ...over,
  };
}

const dims = (v: number): DimensionScores => ({
  content: v,
  structure: v,
  delivery: v,
  relevance: v,
});

export function attempt(
  questionNo: number,
  attemptNo: 1 | 2,
  over: Partial<Attempt> = {},
): Attempt {
  const score = over.score ?? 50;
  return {
    id: `a${questionNo}${attemptNo}aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    sessionId: SESSION_ID,
    questionId: qid(questionNo),
    attemptNo,
    mode: 'typed',
    status: 'done',
    idempotencyKey: `key-${questionNo}-${attemptNo}`,
    transcript: 'My answer',
    words: null,
    audioKey: null,
    audioExpiresAt: null,
    durationS: 30,
    wpm: null,
    fillerCount: null,
    pauseCount: null,
    longestPauseS: null,
    speakingS: null,
    dimensionScores: dims(score),
    score,
    learningScore: null,
    feedback: feedback(),
    feedbackText: null,
    feedbackAudioKey: null,
    evidence: null,
    error: null,
    submittedAt: new Date('2026-10-15T10:00:00Z'),
    updatedAt: new Date('2026-10-15T10:00:00Z'),
    ...over,
  };
}

export function loadedSession(
  questionCount: number,
  attempts: Attempt[],
  over: Partial<LoadedSession> = {},
  skipped: number[] = [],
): LoadedSession {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    jobRoleId: ROLE_ID,
    number: 1,
    status: 'in_progress',
    mode: 'typed',
    isPreview: false,
    currentQuestion: 1,
    startedAt: new Date('2026-10-15T09:50:00Z'),
    completedAt: null,
    durationS: null,
    firstTryAvg: null,
    retryAvg: null,
    learningAvg: null,
    score: null,
    band: null,
    skills: null,
    strengths: null,
    focusAreas: null,
    bandMessage: null,
    weightsSnapshot: {
      sessionWeights: { firstTry: 20, secondTry: 55, learning: 25 },
      dimensionWeights: {
        content: 45,
        structure: 20,
        delivery: 20,
        relevance: 15,
      },
    },
    promptVersions: { interviewer: 1, evaluator: 1, summariser: 1 },
    createdAt: new Date('2026-10-15T09:50:00Z'),
    updatedAt: new Date('2026-10-15T09:50:00Z'),
    role: { slug: 'store-manager', title: 'Store Manager' },
    questions: Array.from({ length: questionCount }, (_, i) => ({
      sessionId: SESSION_ID,
      questionId: qid(i + 1),
      position: i + 1,
      retrySkipped: skipped.includes(i + 1),
      followUpText: null,
      question: {
        id: qid(i + 1),
        text: `Question ${i + 1}`,
        category: 'behavioural' as const,
        card: { position: i + 3 },
      },
    })),
    attempts,
    ...over,
  };
}
