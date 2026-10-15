// Pure builders for the export files (plan §8 `export`). Each maps fields explicitly, so audio keys
// and anything else not listed never reach a file. Workspace CSVs hold no transcripts either.
import { stringify } from 'csv-stringify/sync';

type Cell = string | number | boolean | Date | null | undefined;

/** Spreadsheet apps run cells starting with these as formulas; prefix them so they stay text. */
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: Cell): string | number | boolean {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && FORMULA_START.test(value))
    return `'${value}`;
  return value;
}

function csv(columns: readonly string[], rows: Cell[][]): string {
  return stringify(
    rows.map((r) => r.map(cell)),
    { header: true, columns: [...columns] },
  );
}

export type CandidateCsvRow = {
  id: string;
  name: string | null;
  email: string;
  status: string;
  roles: string[];
  invitedAt: Date | null;
  firstLoginAt: Date | null;
  lastActiveAt: Date | null;
  accessExpiresAt: Date | null;
};

export const candidatesCsv = (rows: CandidateCsvRow[]) =>
  csv(
    [
      'candidate_id',
      'name',
      'email',
      'status',
      'roles',
      'invited_at',
      'first_login_at',
      'last_active_at',
      'access_expires_at',
    ],
    rows.map((r) => [
      r.id,
      r.name,
      r.email,
      r.status,
      r.roles.join('; '),
      r.invitedAt,
      r.firstLoginAt,
      r.lastActiveAt,
      r.accessExpiresAt,
    ]),
  );

export type SessionCsvRow = {
  id: string;
  userId: string;
  role: string;
  number: number;
  status: string;
  mode: string;
  startedAt: Date;
  completedAt: Date | null;
  durationS: number | null;
  score: number | null;
  band: string | null;
  firstTryAvg: number | null;
  retryAvg: number | null;
  learningAvg: number | null;
};

export const sessionsCsv = (rows: SessionCsvRow[]) =>
  csv(
    [
      'session_id',
      'candidate_id',
      'role',
      'session_number',
      'status',
      'mode',
      'started_at',
      'completed_at',
      'duration_s',
      'score',
      'band',
      'first_try_avg',
      'retry_avg',
      'learning_avg',
    ],
    rows.map((r) => [
      r.id,
      r.userId,
      r.role,
      r.number,
      r.status,
      r.mode,
      r.startedAt,
      r.completedAt,
      r.durationS,
      r.score,
      r.band,
      r.firstTryAvg,
      r.retryAvg,
      r.learningAvg,
    ]),
  );

export type DimensionScores = Partial<
  Record<'content' | 'structure' | 'delivery' | 'relevance', number>
>;

export type ScoreCsvRow = {
  id: string;
  sessionId: string;
  userId: string;
  role: string;
  question: string;
  attemptNo: number;
  mode: string;
  status: string;
  score: number | null;
  learningScore: number | null;
  dimensionScores: DimensionScores | null;
  wpm: number | null;
  fillerCount: number | null;
  pauseCount: number | null;
  longestPauseS: number | null;
  durationS: number | null;
  submittedAt: Date;
};

export const scoresCsv = (rows: ScoreCsvRow[]) =>
  csv(
    [
      'attempt_id',
      'session_id',
      'candidate_id',
      'role',
      'question',
      'attempt_no',
      'mode',
      'status',
      'score',
      'learning_score',
      'content',
      'structure',
      'delivery',
      'relevance',
      'wpm',
      'filler_count',
      'pause_count',
      'longest_pause_s',
      'duration_s',
      'submitted_at',
    ],
    rows.map((r) => [
      r.id,
      r.sessionId,
      r.userId,
      r.role,
      r.question,
      r.attemptNo,
      r.mode,
      r.status,
      r.score,
      r.learningScore,
      r.dimensionScores?.content,
      r.dimensionScores?.structure,
      r.dimensionScores?.delivery,
      r.dimensionScores?.relevance,
      r.wpm,
      r.fillerCount,
      r.pauseCount,
      r.longestPauseS,
      r.durationS,
      r.submittedAt,
    ]),
  );

/** What the candidate JSON export reads from the database (see ExportService). */
export type CandidateExportSource = {
  id: string;
  email: string;
  name: string | null;
  title: string | null;
  role: string;
  status: string;
  accessExpiresAt: Date | null;
  firstLoginAt: Date | null;
  lastActiveAt: Date | null;
  createdAt: Date;
  assignments: {
    assignedAt: Date;
    maxAttempts: number | null;
    removedAt: Date | null;
    role: { title: string };
  }[];
  sessions: {
    id: string;
    number: number;
    status: string;
    mode: string;
    startedAt: Date;
    completedAt: Date | null;
    durationS: number | null;
    score: number | null;
    band: string | null;
    firstTryAvg: number | null;
    retryAvg: number | null;
    learningAvg: number | null;
    skills: unknown;
    strengths: unknown;
    focusAreas: unknown;
    bandMessage: string | null;
    role: { title: string };
    attempts: {
      id: string;
      attemptNo: number;
      mode: string;
      status: string;
      transcript: string | null;
      durationS: number | null;
      wpm: number | null;
      fillerCount: number | null;
      pauseCount: number | null;
      longestPauseS: number | null;
      dimensionScores: unknown;
      score: number | null;
      learningScore: number | null;
      feedback: unknown;
      feedbackText: string | null;
      submittedAt: Date;
      question: { text: string };
    }[];
  }[];
  consents: { kind: string; textVersion: string; givenAt: Date }[];
  activityEvents: { text: string; at: Date }[];
  cardViews: { viewedAt: Date; card: { position: number; question: string } }[];
  privacyRequests: {
    kind: string;
    status: string;
    createdAt: Date;
    completedAt: Date | null;
  }[];
};

/** The candidate's data bundle (NFR-06): profile, assignments, sessions with attempts, consents, activity. */
export function candidateBundle(u: CandidateExportSource, exportedAt: Date) {
  return {
    exportedAt,
    profile: {
      id: u.id,
      email: u.email,
      name: u.name,
      title: u.title,
      role: u.role,
      status: u.status,
      accessExpiresAt: u.accessExpiresAt,
      firstLoginAt: u.firstLoginAt,
      lastActiveAt: u.lastActiveAt,
      createdAt: u.createdAt,
    },
    assignments: u.assignments.map((a) => ({
      role: a.role.title,
      assignedAt: a.assignedAt,
      maxSessions: a.maxAttempts,
      removedAt: a.removedAt,
    })),
    sessions: u.sessions.map((s) => ({
      id: s.id,
      role: s.role.title,
      number: s.number,
      status: s.status,
      mode: s.mode,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      durationS: s.durationS,
      score: s.score,
      band: s.band,
      firstTryAvg: s.firstTryAvg,
      retryAvg: s.retryAvg,
      learningAvg: s.learningAvg,
      skills: s.skills,
      strengths: s.strengths,
      focusAreas: s.focusAreas,
      bandMessage: s.bandMessage,
      attempts: s.attempts.map((a) => ({
        id: a.id,
        question: a.question.text,
        attemptNo: a.attemptNo,
        mode: a.mode,
        status: a.status,
        transcript: a.transcript,
        durationS: a.durationS,
        wpm: a.wpm,
        fillerCount: a.fillerCount,
        pauseCount: a.pauseCount,
        longestPauseS: a.longestPauseS,
        dimensionScores: a.dimensionScores,
        score: a.score,
        learningScore: a.learningScore,
        feedback: a.feedback,
        feedbackText: a.feedbackText,
        submittedAt: a.submittedAt,
      })),
    })),
    consents: u.consents.map((c) => ({
      kind: c.kind,
      textVersion: c.textVersion,
      givenAt: c.givenAt,
    })),
    activity: u.activityEvents.map((e) => ({ text: e.text, at: e.at })),
    cardViews: u.cardViews.map((v) => ({
      card: v.card.position,
      question: v.card.question,
      viewedAt: v.viewedAt,
    })),
    privacyRequests: u.privacyRequests.map((r) => ({
      kind: r.kind,
      status: r.status,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
    })),
  };
}
