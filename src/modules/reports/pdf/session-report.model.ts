// The neutral model behind the PDF session report (FR-SCORE-04), built from either the candidate's
// own results or the admin session review. Pure functions; the document layout is in
// session-report-pdf.service.ts.
import type { Band } from '../../../generated/prisma/client.js';
import {
  type AdminAppliedState,
  type CandidateBand,
  fromAdminBand,
  toCandidateBand,
} from '../../../common/mapping/enums.js';
import { BAND_MESSAGES } from '../../interview/scoring/score.js';
import { CATEGORY_LABELS } from '../../interview/serializers/candidate.serializer.js';
import type {
  AppliedItem,
  CandidateAttempt,
  CandidateSession,
  Dimension,
} from '../../interview/types.js';
import { BAND_LABEL, bandLabel } from '../format.js';
import type { AdminDelivery, SessionReview, Try } from '../reports.types.js';

export type ReportDelivery = { label: string; value: string; note?: string };

export type ReportTry = {
  mode: 'voice' | 'typed';
  score: number;
  subScores: Record<Dimension, number>;
  /** Voice metrics; null for typed answers or when none were measured. */
  delivery: ReportDelivery[] | null;
  worked: string[];
  improve: string[];
  transcript: string;
};

export type ReportApplied = {
  label: string;
  status: 'applied' | 'partly' | 'not_yet';
  evidence: string;
};

export type ReportQuestion = {
  position: number;
  text: string;
  category: string | null;
  first: ReportTry;
  second: ReportTry | null;
  retrySkipped: boolean;
  applied: ReportApplied[];
};

export type SessionReportModel = {
  candidateName: string | null;
  roleTitle: string;
  sessionNumber: number;
  /** ISO 8601: completedAt, or the review date. */
  date: string;
  durationMin: number | null;
  score: number;
  /** "Nearly ready" etc. */
  bandLabel: string;
  bandMessage: string | null;
  firstTryAvg: number | null;
  secondTryAvg: number | null;
  learningScore: number | null;
  formulaText: string | null;
  strengths: string[];
  focus: string[];
  questions: ReportQuestion[];
};

const BANDS = Object.keys(BAND_MESSAGES) as Band[];

const fromCandidateBand = (band: CandidateBand): Band =>
  BANDS.find((b) => toCandidateBand(b) === band) ?? 'not_ready';

const CANDIDATE_APPLIED: Record<
  AppliedItem['status'],
  ReportApplied['status']
> = { applied: 'applied', partly: 'partly', 'not-yet': 'not_yet' };

const ADMIN_APPLIED: Record<AdminAppliedState, ReportApplied['status']> = {
  done: 'applied',
  partial: 'partly',
  missed: 'not_yet',
};

/** Trimmed, non-empty lines. The admin `Try` joins its lists into one string. */
const toList = (value: string | string[] | undefined): string[] =>
  (Array.isArray(value) ? value : [value ?? ''])
    .map((s) => s.trim())
    .filter(Boolean);

/** "behavioural" → "Behavioural"; display labels pass through. */
const categoryLabel = (category: string | undefined): string | null =>
  category
    ? (CATEGORY_LABELS[category as keyof typeof CATEGORY_LABELS] ?? category)
    : null;

function candidateTry(a: CandidateAttempt): ReportTry {
  return {
    mode: a.mode,
    score: a.feedback.score,
    subScores: a.feedback.subScores,
    delivery:
      a.mode === 'voice' && a.feedback.delivery.length
        ? a.feedback.delivery.map((d) => ({
            label: d.label,
            value: d.valueText,
            ...(d.targetText && { note: d.targetText }),
          }))
        : null,
    worked: toList(a.feedback.worked),
    improve: toList(a.feedback.improve),
    transcript: a.transcript,
  };
}

/** The candidate's completed session (GET /sessions/:id/report.pdf). */
export function fromCandidateSession(
  s: CandidateSession,
  candidateName: string | null,
  roleTitle: string,
): SessionReportModel {
  const ms = Date.parse(s.completedAt) - Date.parse(s.startedAt);
  return {
    candidateName: candidateName?.trim() || null,
    roleTitle,
    sessionNumber: s.number,
    date: s.completedAt,
    durationMin: Number.isFinite(ms)
      ? Math.max(0, Math.round(ms / 60_000))
      : null,
    score: s.score,
    bandLabel: bandLabel(fromCandidateBand(s.band)),
    bandMessage: s.bandMessage || null,
    firstTryAvg: s.firstAttemptAvg,
    secondTryAvg: s.retryAvg,
    learningScore: s.learningAvg,
    formulaText: null,
    strengths: toList(s.strengths.map((p) => p.text)),
    focus: toList(s.focus.map((p) => p.text)),
    questions: s.results.map((r) => ({
      position: r.question.index,
      text: r.question.text,
      category: categoryLabel(r.question.category),
      first: candidateTry(r.first),
      second: r.second ? candidateTry(r.second) : null,
      retrySkipped: r.second === null,
      applied: r.second
        ? r.applied.map((a) => ({
            label: a.label,
            status: CANDIDATE_APPLIED[a.status],
            evidence: a.evidence,
          }))
        : [],
    })),
  };
}

/** Worded like the admin review page's try card. */
const adminDelivery = (d: AdminDelivery): ReportDelivery[] => [
  {
    label: 'Pace',
    value: `${d.wpm} wpm${d.paceLabel ? `, ${d.paceLabel}` : ''}`,
  },
  { label: 'Filler words', value: String(d.fillerWords) },
  {
    label: 'Longest pause',
    value:
      d.longestPauseSec === null ? 'Not measured' : `${d.longestPauseSec} s`,
  },
];

function adminTry(t: Try): ReportTry {
  return {
    mode: t.mode,
    score: t.score,
    subScores: t.subScores,
    delivery:
      t.mode === 'voice' && t.delivery ? adminDelivery(t.delivery) : null,
    worked: toList(t.worked),
    improve: toList(t.improve),
    transcript: t.transcript,
  };
}

/** The admin session review (GET /admin/candidates/:cid/sessions/:sid/report.pdf). */
export function fromSessionReview(r: SessionReview): SessionReportModel {
  const band = fromAdminBand(r.band);
  return {
    candidateName: r.candidateName.trim() || null,
    roleTitle: r.roleTitle,
    sessionNumber: r.sessionNumber,
    date: r.date,
    durationMin: r.durationMin,
    score: r.score,
    bandLabel: BAND_LABEL[r.band],
    bandMessage: BAND_MESSAGES[band],
    firstTryAvg: r.firstTryAvg,
    secondTryAvg: r.secondTryAvg,
    learningScore: r.learningScore,
    formulaText: r.formulaText || null,
    strengths: [],
    focus: [],
    questions: r.hasDetail
      ? r.questions.map((q) => {
          const [first, second] = q.tries;
          const retry = q.retrySkipped ? undefined : second;
          return {
            position: q.n,
            text: q.text,
            category: categoryLabel(q.category),
            first: adminTry(first),
            second: retry ? adminTry(retry) : null,
            retrySkipped: q.retrySkipped,
            applied: (retry?.appliedFromFeedback ?? []).map((a) => ({
              label: a.text,
              status: ADMIN_APPLIED[a.state],
              evidence: a.detail ?? '',
            })),
          };
        })
      : [],
  };
}
