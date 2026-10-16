// Admin UI response shapes for the read models (../prep-admin-ui/src/lib/types.ts). Field names and
// enum spellings are the admin UI's; canonical DB values are mapped in the services.
import type {
  AdminAppliedState,
  AdminBand,
} from '../../common/mapping/enums.js';
import type { RoleStatus, UserStatus } from '../../generated/prisma/client.js';
import type {
  Dimension,
  DimensionScores,
  SessionWeights,
} from '../interview/types.js';

export type CandidateSortColumn =
  'name' | 'status' | 'sessions' | 'score' | 'change' | 'lastActive';

export type RoleRef = { id: string; title: string; status: RoleStatus };

export type CandidateRow = {
  id: string;
  name: string;
  email: string;
  status: UserStatus;
  roles: RoleRef[];
  sessions: number;
  latestScore: number | null;
  band: AdminBand | null;
  change: number | null;
  lastActiveAt: string | null;
  lastActiveLabel: string;
  lastActiveNote?: string;
};

export type CandidateList = {
  rows: CandidateRow[];
  total: number;
  totalUnfiltered: number;
};

export type RoleAssignmentView = {
  roleId: string;
  roleTitle: string;
  roleStatus: RoleStatus;
  assignedAt: string;
  maxSessions: number | null;
  sessionsUsed: number;
  baselineScore: number | null;
  latestScore: number | null;
  latestBand: AdminBand | null;
  changeSinceBaseline: number | null;
};

export type SessionSummaryView = {
  id: string;
  candidateId: string;
  roleId: string;
  roleTitle: string;
  number: number;
  date: string;
  score: number;
  band: AdminBand;
  durationMin: number;
};

export type CandidateDetail = {
  id: string;
  name: string;
  email: string;
  status: UserStatus;
  invitedAt: string;
  invitedBy: string;
  invitedByName: string;
  firstLoginAt?: string;
  lastActiveAt: string | null;
  accessUntil: string | null;
  assignments: RoleAssignmentView[];
  sessions: SessionSummaryView[];
  activity: { text: string; at: string }[];
  progress: { label: string; date: string; score: number }[];
  changeSinceFirst: number | null;
};

export type Highlight = { text: string; kind: 'match' | 'issue'; note: string };

export type AdminDelivery = {
  wpm: number;
  paceLabel?: string;
  fillerWords: number;
  /** Null when pauses were not measured. */
  longestPauseSec: number | null;
};

export type Try = {
  attempt: 1 | 2;
  score: number;
  band: AdminBand;
  audioSeconds: number;
  audioLabel: string;
  subScores: DimensionScores;
  transcript: string;
  highlights: Highlight[];
  worked: string;
  improve: string;
  /** null for a typed answer (no voice metrics). */
  delivery: AdminDelivery | null;
  appliedFromFeedback?: {
    text: string;
    state: AdminAppliedState;
    detail?: string;
  }[];
  /** Signed URL while the recording is retained, else null. Not in the UI type yet. */
  audioUrl: string | null;
};

export type ReviewQuestion = {
  n: number;
  text: string;
  category?: string;
  firstScore: number;
  /** null without an attempt 2, whether the retry was skipped or never answered. */
  secondScore: number | null;
  /** session_questions.retry_skipped. Not in the UI type yet. */
  retrySkipped: boolean;
  /** One element without an attempt 2 (the UI type says `[Try, Try]`). */
  tries: Try[];
};

export type SessionReview = {
  sessionId: string;
  candidateId: string;
  candidateName: string;
  roleId: string;
  roleTitle: string;
  sessionNumber: number;
  date: string;
  durationMin: number;
  score: number;
  band: AdminBand;
  changeVsPrevious: number | null;
  firstTryAvg: number | null;
  secondTryAvg: number | null;
  learningScore: number | null;
  hasDetail: boolean;
  questions: ReviewQuestion[];
  weights: SessionWeights;
  formulaText: string;
};

export type FlagDimension = Dimension | 'overall' | 'feedback';
export type FlagIssue =
  'too_high' | 'too_low' | 'feedback_inaccurate' | 'transcript_wrong';

export type EvaluationFlagView = {
  id: string;
  sessionId: string;
  title: string;
  questionNumber: number;
  dimension: FlagDimension;
  issue?: FlagIssue;
  note: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  status: 'open' | 'resolved';
  resolution?: string;
};

export type BandCounts = Record<AdminBand, number>;

export type HardestQuestion = {
  questionId?: string;
  question: string;
  timesAsked: number;
  avgFirst: number;
  avgSecond: number;
  avgLearning: number | null;
};

export type NeedsAttention = {
  candidateId?: string;
  name: string;
  email: string;
  why: string;
  sessions: number;
  latestScore: number | null;
  lastActiveLabel: string;
  lastActiveAt?: string;
};

export type Weakest = { id: Dimension; label: string; value: number };

export type Report = {
  roleId: string;
  roleTitle: string;
  range: { from: string; to: string; label: string };
  hasData: boolean;
  stats: {
    invited: number;
    active: number;
    completedSession: number;
    avgBaseline: number | null;
    avgLatest: number | null;
    /** avgLatest − avgBaseline; null until some candidate in the report has 2 sessions. */
    change: number | null;
  };
  bandsLatest: BandCounts;
  bandsBaseline: BandCounts;
  hardestQuestions: HardestQuestion[];
  dimensionAverages: DimensionScores | null;
  weakest: Weakest | null;
  weakestNote: string | null;
  needsAttention: NeedsAttention[];
  illustrative: string[];
};
