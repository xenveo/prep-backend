// Prisma rows → candidate UI shapes (../prep-candidate-ui/lib/types.ts plus the spec's added fields).
// Pure functions; enum spellings go through common/mapping/enums.ts (plan §10).
import type {
  Attempt,
  CardCategory,
  FlashCard,
  Question,
  Session,
  SessionQuestion,
} from '../../../generated/prisma/client.js';
import {
  toCandidateApplied,
  toCandidateBand,
} from '../../../common/mapping/enums.js';
import { BAND_MESSAGES } from '../scoring/score.js';
import type {
  AppliedItem,
  CandidateAttempt,
  CandidateInterviewQuestion,
  CandidateSession,
  DimensionScores,
  QuestionResult,
  ReportPoint,
  SessionSummary,
  StoredAppliedItem,
  StoredFeedback,
} from '../types.js';

/** Candidate-facing category labels (FlashCard.category and InterviewQuestion.category). */
export const CATEGORY_LABELS: Record<CardCategory, string> = {
  behavioural: 'Behavioural',
  situational: 'Situational',
  role_knowledge: 'Role knowledge',
  motivation: 'Motivation',
};

export type SessionQuestionRow = Pick<
  SessionQuestion,
  'position' | 'retrySkipped'
> & {
  question: Pick<Question, 'id' | 'text' | 'category'> & {
    card: Pick<FlashCard, 'position'> | null;
  };
};

export type AttemptRow = Pick<
  Attempt,
  | 'id'
  | 'attemptNo'
  | 'mode'
  | 'transcript'
  | 'durationS'
  | 'score'
  | 'dimensionScores'
  | 'feedback'
  | 'audioKey'
  | 'feedbackAudioKey'
  | 'submittedAt'
>;

const iso = (d: Date) => d.toISOString();

export function toInterviewQuestion(
  sq: SessionQuestionRow,
): CandidateInterviewQuestion {
  return {
    id: sq.question.id,
    index: sq.position,
    text: sq.question.text,
    cardId: sq.question.card?.position ?? 0,
    category: CATEGORY_LABELS[sq.question.category],
  };
}

/** A finished attempt. Throws if it has no evaluation yet (callers report pending attempts separately). */
export function toCandidateAttempt(attempt: AttemptRow): CandidateAttempt {
  const feedback = attempt.feedback as StoredFeedback | null;
  const subScores = attempt.dimensionScores as DimensionScores | null;
  if (!feedback || !subScores || attempt.score === null) {
    throw new Error(`Attempt ${attempt.id} has no evaluation`);
  }
  return {
    id: attempt.id,
    attemptNo: attempt.attemptNo === 2 ? 2 : 1,
    mode: attempt.mode,
    transcript: attempt.transcript ?? '',
    durationSec: Math.round(attempt.durationS ?? 0),
    feedback: {
      score: attempt.score,
      subScores,
      worked: feedback.worked,
      improve: feedback.improve,
      opener: feedback.opener,
      delivery: feedback.delivery,
      audioSeconds: feedback.audioSeconds,
      focus: feedback.focus,
    },
    audioUrl: attempt.audioKey ? `/api/attempts/${attempt.id}/audio` : null,
    feedbackAudioUrl: attempt.feedbackAudioKey
      ? `/api/attempts/${attempt.id}/feedback-audio`
      : null,
    submittedAt: iso(attempt.submittedAt),
  };
}

export function toAppliedItems(applied: StoredAppliedItem[]): AppliedItem[] {
  return applied.map((a) => ({
    label: a.point,
    status: toCandidateApplied(a.status),
    evidence: a.evidence,
  }));
}

/** `second` is null when the retry was skipped; `applied` is [] then. */
export function toQuestionResult(
  sq: SessionQuestionRow,
  first: AttemptRow,
  second: AttemptRow | null,
): QuestionResult {
  const retry = sq.retrySkipped ? null : second;
  return {
    question: toInterviewQuestion(sq),
    first: toCandidateAttempt(first),
    second: retry ? toCandidateAttempt(retry) : null,
    applied: retry
      ? toAppliedItems((retry.feedback as StoredFeedback | null)?.applied ?? [])
      : [],
  };
}

export type SessionReportRow = Pick<
  Session,
  | 'id'
  | 'jobRoleId'
  | 'number'
  | 'startedAt'
  | 'completedAt'
  | 'score'
  | 'band'
  | 'bandMessage'
  | 'skills'
  | 'strengths'
  | 'focusAreas'
  | 'firstTryAvg'
  | 'retryAvg'
  | 'learningAvg'
>;

/**
 * A completed session → candidate `Session`. Throws if the session is not scored yet. `roleId` is the
 * id the candidate UI uses for the role (its slug); it defaults to the job role uuid.
 */
export function toSessionReport(
  session: SessionReportRow,
  results: QuestionResult[],
  roleId: string = session.jobRoleId,
): CandidateSession {
  if (
    session.score === null ||
    session.band === null ||
    session.completedAt === null
  ) {
    throw new Error(`Session ${session.id} is not completed`);
  }
  return {
    id: session.id,
    roleId,
    number: session.number,
    startedAt: iso(session.startedAt),
    completedAt: iso(session.completedAt),
    score: session.score,
    band: toCandidateBand(session.band),
    bandMessage: session.bandMessage ?? BAND_MESSAGES[session.band],
    skills: (session.skills as DimensionScores | null) ?? {
      content: 0,
      structure: 0,
      delivery: 0,
      relevance: 0,
    },
    strengths: (session.strengths as ReportPoint[] | null) ?? [],
    focus: (session.focusAreas as ReportPoint[] | null) ?? [],
    results,
    firstAttemptAvg: session.firstTryAvg ?? 0,
    retryAvg: session.retryAvg ?? 0,
    learningAvg: session.learningAvg ?? 0,
  };
}

/** History / progress chart row. Completed sessions only. */
export function toSessionSummary(
  session: Pick<Session, 'id' | 'number' | 'startedAt' | 'score' | 'band'>,
): SessionSummary {
  if (session.score === null || session.band === null) {
    throw new Error(`Session ${session.id} is not completed`);
  }
  return {
    id: session.id,
    number: session.number,
    startedAt: iso(session.startedAt),
    score: session.score,
    band: toCandidateBand(session.band),
  };
}
