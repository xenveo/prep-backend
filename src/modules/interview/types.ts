// Stored JSON shapes (jsonb columns) and the candidate UI response types the serializers produce.
// Candidate shapes copy ../prep-candidate-ui/lib/types.ts plus the spec's added fields ("Candidate API").
import type {
  AppliedStatus,
  CandidateAppliedStatus,
  CandidateBand,
} from '../../common/mapping/enums.js';

// ---------------------------------------------------------------------------
// Scoring config
// ---------------------------------------------------------------------------

export type Dimension = 'content' | 'structure' | 'delivery' | 'relevance';
export const DIMENSIONS: readonly Dimension[] = [
  'content',
  'structure',
  'delivery',
  'relevance',
];

/** 0..100 per dimension (Attempt.dimensionScores, Session.skills, the UI's subScores). */
export type DimensionScores = Record<Dimension, number>;
/** Percent per dimension; sums to 100. */
export type DimensionWeights = Record<Dimension, number>;
/** Percent per component; sums to 100. */
export type SessionWeights = {
  firstTry: number;
  secondTry: number;
  learning: number;
};

/** Session.weightsSnapshot */
export type WeightsSnapshot = {
  sessionWeights: SessionWeights;
  dimensionWeights: DimensionWeights;
};

/** JobRole.settings (admin UI RoleSettings). */
export type RoleSettings = {
  questionsPerSession: number;
  questionOrder: 'fixed' | 'random';
  answerGuideSeconds: number;
  requireAllCards: boolean;
  /** null = no limit */
  maxSessionsPerCandidate: number | null;
  sessionWeights: SessionWeights;
  dimensionWeights: DimensionWeights;
};

export const DEFAULT_ROLE_SETTINGS: RoleSettings = {
  questionsPerSession: 5,
  questionOrder: 'fixed',
  answerGuideSeconds: 120,
  requireAllCards: true,
  maxSessionsPerCandidate: 5,
  sessionWeights: { firstTry: 20, secondTry: 55, learning: 25 },
  dimensionWeights: { content: 45, structure: 20, delivery: 20, relevance: 15 },
};

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export type ExpectedStructure = 'star' | 'problem_solution' | 'free';

/** Question.rubric */
export type Rubric = {
  keyPoints: { id: string; point: string; example: string }[];
  redFlags: string[];
  expectedStructure: ExpectedStructure;
};

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export type Word = { w: string; start: number; end: number };

/** Voice metrics computed in code (scoring/metrics.ts), stored on Attempt columns. */
export type VoiceMetrics = {
  wpm: number;
  fillerCount: number;
  pauseCount: number;
  longestPauseS: number;
  durationS: number;
};

/** Candidate UI DeliveryMetric. */
export type DeliveryMetric = {
  key: 'pace' | 'fillers' | 'pauses';
  label: string;
  valueText: string;
  value: number;
  scale: { min: number; max: number };
  target: { min: number; max: number };
  targetText: string;
  note: string;
  inTarget: boolean;
};

// ---------------------------------------------------------------------------
// Stored attempt JSON
// ---------------------------------------------------------------------------

export type StoredAppliedItem = {
  point: string;
  status: AppliedStatus;
  evidence: string;
};

export type StoredHighlight = {
  quote: string;
  kind: 'match' | 'issue';
  note: string;
  rubricPointId?: string;
};

/** Attempt.feedback */
export type StoredFeedback = {
  worked: string[];
  improve: string[];
  opener: string;
  /** Focus chips for the second try (= improvementPoints). */
  focus: string[];
  improvementPoints: string[];
  deliveryNotes: string;
  spokenSummary: string;
  followUp: string | null;
  /** Attempt 2 only; [] on attempt 1. */
  applied: StoredAppliedItem[];
  highlights: StoredHighlight[];
  /** [] for typed answers. */
  delivery: DeliveryMetric[];
  /** Spoken feedback length in seconds. */
  audioSeconds: number;
};

/** Attempt.evidence */
export type StoredEvidence = {
  dimension: Dimension;
  quote: string;
  note: string;
}[];

/** Session.strengths / Session.focusAreas, and the candidate UI ReportPoint. */
export type ReportPoint = { text: string; cardId: number };

// ---------------------------------------------------------------------------
// Candidate UI response types
// ---------------------------------------------------------------------------

export type CandidateInterviewQuestion = {
  id: string;
  /** 1-based position in the interview */
  index: number;
  text: string;
  /** Study card position this question is drawn from (0 when unlinked). */
  cardId: number;
  /** Display label, e.g. "Behavioural". */
  category: string;
};

export type CandidateFeedback = {
  score: number;
  subScores: DimensionScores;
  worked: string[];
  improve: string[];
  opener: string;
  delivery: DeliveryMetric[];
  audioSeconds: number;
  focus: string[];
};

export type CandidateAttempt = {
  id: string;
  attemptNo: 1 | 2;
  mode: 'voice' | 'typed';
  transcript: string;
  durationSec: number;
  feedback: CandidateFeedback;
  audioUrl: string | null;
  feedbackAudioUrl: string | null;
  /** ISO 8601 */
  submittedAt: string;
};

export type AppliedItem = {
  label: string;
  status: CandidateAppliedStatus;
  evidence: string;
};

export type QuestionResult = {
  question: CandidateInterviewQuestion;
  first: CandidateAttempt;
  /** null = second try skipped */
  second: CandidateAttempt | null;
  /** [] when second is null */
  applied: AppliedItem[];
};

export type CandidateSession = {
  id: string;
  roleId: string;
  number: number;
  startedAt: string;
  completedAt: string;
  score: number;
  band: CandidateBand;
  bandMessage: string;
  skills: DimensionScores;
  strengths: ReportPoint[];
  focus: ReportPoint[];
  results: QuestionResult[];
  firstAttemptAvg: number;
  retryAvg: number;
  learningAvg: number;
};

export type SessionSummary = {
  id: string;
  number: number;
  startedAt: string;
  score: number;
  band: CandidateBand;
};

/** Job data on the `attempt` queue (attempts.service produces, the pipeline consumes). */
export type AttemptJob = { attemptId: string };
