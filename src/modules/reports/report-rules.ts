// Report rules from ../prep-admin-ui/src/services/reports.ts, over real data. Pure functions.
import type { Band, UserStatus } from '../../generated/prisma/client.js';
import { toAdminBand, type AdminBand } from '../../common/mapping/enums.js';
import { bandFor } from '../interview/scoring/score.js';
import {
  DIMENSIONS,
  type Dimension,
  type DimensionScores,
} from '../interview/types.js';
import type { CsvCell } from './csv.js';
import {
  addDays,
  BAND_LABEL,
  bandLabel,
  daysBetween,
  daysSince,
  formatDayRange,
  relativeTime,
  startOfWorkspaceDay,
  workspaceDay,
} from './format.js';
import type {
  BandCounts,
  HardestQuestion,
  NeedsAttention,
  Report,
  Weakest,
} from './reports.types.js';

export type DateBasis = 'completed' | 'invited';

export type ReportRange = {
  from: string;
  to: string;
  label: string;
  /** Inclusive start (midnight of `from`, workspace time). */
  start: Date;
  /** Exclusive end (midnight after `to`, workspace time). */
  end: Date;
};

/** Defaults to the last 30 days ending today. "Last 30 days · 15 Sep – 15 Oct 2026" or "Custom range · …". */
export function reportRange(
  q: { from?: string; to?: string },
  now: Date,
): ReportRange {
  const today = workspaceDay(now);
  const to = q.to ?? today;
  const from = q.from ?? addDays(to, -30);
  const kind =
    daysBetween(from, to) === 30 && to === today
      ? 'Last 30 days'
      : 'Custom range';
  return {
    from,
    to,
    label: `${kind} · ${formatDayRange(from, to)}`,
    start: startOfWorkspaceDay(from),
    end: startOfWorkspaceDay(addDays(to, 1)),
  };
}

const BASIS_TEXT: Record<DateBasis, string> = {
  completed: 'by session completion date',
  invited: 'by invite date',
};

/** The CSV `Range` row value: the range label plus the date basis. */
export const rangeWithBasis = (label: string, basis: DateBasis) =>
  `${label} · ${BASIS_TEXT[basis]}`;

const DIMENSION_LABEL: Record<Dimension, string> = {
  content: 'Content',
  structure: 'Structure',
  delivery: 'Delivery',
  relevance: 'Relevance',
};

const SUGGESTION: Record<Dimension, string> = {
  structure: 'Consider a flash card on STAR.',
  content: 'Consider a flash card on what a strong answer includes.',
  delivery: 'Consider a flash card on pace and filler words.',
  relevance: 'Consider a flash card on answering the question that was asked.',
};

/** Lowest-average dimension; ties go to the first in Content, Structure, Delivery, Relevance order. */
export function weakestDimension(avgs: DimensionScores): Weakest {
  const id = DIMENSIONS.reduce(
    (worst, d) => (avgs[d] < avgs[worst] ? d : worst),
    DIMENSIONS[0],
  );
  return { id, label: DIMENSION_LABEL[id], value: avgs[id] };
}

/** "Structure is the weakest area. Consider a flash card on STAR." */
export const weakestNote = (w: Weakest) =>
  `${w.label} is the weakest area. ${SUGGESTION[w.id]}`;

export const emptyBands = (): BandCounts => ({
  ready: 0,
  nearly: 0,
  developing: 0,
  not_ready: 0,
});

export function countBands(scores: number[]): BandCounts {
  const out = emptyBands();
  for (const s of scores) out[toAdminBand(bandFor(s))]++;
  return out;
}

export const roundedMean = (values: number[]): number | null =>
  values.length
    ? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
    : null;

/**
 * avgLatest − avgBaseline. Null until some candidate in the report has 2+ completed sessions;
 * before that baseline and latest are the same session (candidate detail's change is null too).
 */
export function reportChange(
  avgBaseline: number | null,
  avgLatest: number | null,
  sessionCounts: number[],
): number | null {
  if (avgBaseline === null || avgLatest === null) return null;
  return sessionCounts.some((n) => n >= 2) ? avgLatest - avgBaseline : null;
}

export type QuestionAgg = {
  questionId: string;
  question: string;
  timesAsked: number;
  avgFirst: number;
  avgSecond: number;
  avgLearning: number | null;
};

/** Hardest questions: asked at least `minAsks` times, lowest average first try first. */
export function pickHardest(
  rows: QuestionAgg[],
  minAsks = 3,
  limit = 5,
): HardestQuestion[] {
  return rows
    .filter((r) => r.timesAsked >= minAsks)
    .sort((a, b) => a.avgFirst - b.avgFirst)
    .slice(0, limit)
    .map((r) => ({
      questionId: r.questionId,
      question: r.question,
      timesAsked: r.timesAsked,
      avgFirst: Math.round(r.avgFirst),
      avgSecond: Math.round(r.avgSecond),
      avgLearning: r.avgLearning === null ? null : Math.round(r.avgLearning),
    }));
}

export type AttentionCandidate = {
  id: string;
  name: string;
  email: string;
  status: UserStatus;
  /** False when the assignment was removed. */
  assigned: boolean;
  lastActiveAt: Date | null;
  /** Completed sessions for the role, ever. */
  sessionsTotal: number;
  /** First completed session ever. */
  baselineScore: number | null;
  /** Last completed session in the report's scope. */
  latestScore: number | null;
  latestBand: Band | null;
};

export const INACTIVE_DAYS = 14;

/**
 * Needs attention: latest score under 50, or no activity for 14+ days. Pending, revoked and
 * unassigned candidates are left out. Lowest latest score first; no score last.
 */
export function needsAttention(
  candidates: AttentionCandidate[],
  now: Date,
): NeedsAttention[] {
  const out: NeedsAttention[] = [];
  for (const c of candidates) {
    if (!c.assigned || c.status === 'revoked' || c.status === 'invite_pending')
      continue;
    const idle = c.lastActiveAt ? daysSince(c.lastActiveAt, now) : null;
    const low = c.latestScore !== null && c.latestScore < 50;
    const inactive = idle !== null && idle >= INACTIVE_DAYS;
    if (!low && !inactive) continue;
    const band = c.latestBand ?? bandFor(c.latestScore ?? 0);
    const why = low
      ? c.sessionsTotal >= 2 &&
        c.baselineScore !== null &&
        c.latestScore! <= c.baselineScore
        ? `${bandLabel(band)}, no change over ${c.sessionsTotal} sessions`
        : bandLabel(band)
      : `No activity for ${idle} days`;
    out.push({
      candidateId: c.id,
      name: c.name,
      email: c.email,
      why,
      sessions: c.sessionsTotal,
      latestScore: c.latestScore,
      lastActiveLabel: c.lastActiveAt
        ? relativeTime(c.lastActiveAt, now)
        : 'Not yet',
      ...(c.lastActiveAt && { lastActiveAt: c.lastActiveAt.toISOString() }),
    });
  }
  const key = (r: NeedsAttention) => r.latestScore ?? Number.POSITIVE_INFINITY;
  return out.sort((a, b) => key(a) - key(b) || a.name.localeCompare(b.name));
}

const BAND_ORDER: AdminBand[] = ['ready', 'nearly', 'developing', 'not_ready'];

/** Rows for the report CSV, laid out as the admin UI's `exportReportCsv`. */
export function reportCsvRows(r: Report, basis: DateBasis): CsvCell[][] {
  const dims = r.dimensionAverages;
  return [
    ['Report', r.roleTitle],
    ['Range', rangeWithBasis(r.range.label, basis)],
    [],
    ['Metric', 'Value'],
    ['Invited', r.stats.invited],
    ['Active', r.stats.active],
    ['Completed a session', r.stats.completedSession],
    ['Average baseline', r.stats.avgBaseline],
    ['Average latest', r.stats.avgLatest],
    ['Change', r.stats.change],
    [],
    ['Band', 'Baseline', 'Latest', 'Change'],
    ...BAND_ORDER.map((b) => [
      BAND_LABEL[b],
      r.bandsBaseline[b],
      r.bandsLatest[b],
      r.bandsLatest[b] - r.bandsBaseline[b],
    ]),
    [],
    ['Dimension', 'Average'],
    ...(dims ? DIMENSIONS.map((d) => [DIMENSION_LABEL[d], dims[d]]) : []),
    [],
    [
      'Hardest question',
      'Times asked',
      'Avg first try',
      'Avg second try',
      'Learning',
    ],
    ...r.hardestQuestions.map((h) => [
      h.question,
      h.timesAsked,
      h.avgFirst,
      h.avgSecond,
      h.avgLearning,
    ]),
  ];
}

/** "report-customer-support-associate-2026-10-15.csv" */
export function reportCsvFilename(roleTitle: string, to: string): string {
  const slug = roleTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `report-${slug}-${to}.csv`;
}
