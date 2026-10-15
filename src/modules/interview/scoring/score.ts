// Scoring formulas (SRS 5, spec "Scoring", plan §6). Pure functions.
import type { Band } from '../../../generated/prisma/client.js';
import type { AppliedStatus } from '../../../common/mapping/enums.js';
import {
  DIMENSIONS,
  type DimensionScores,
  type DimensionWeights,
  type SessionWeights,
} from '../types.js';

const LEVEL_SCORES: Record<number, number> = {
  1: 0,
  2: 25,
  3: 50,
  4: 75,
  5: 100,
};

/** Rubric level 1..5 → 0, 25, 50, 75, 100. */
export function levelToScore(level: number): number {
  const score = LEVEL_SCORES[level];
  if (score === undefined)
    throw new RangeError(`Invalid rubric level ${level}`);
  return score;
}

export function dimensionScoresFromLevels(
  levels: DimensionScores,
): DimensionScores {
  const out = {} as DimensionScores;
  for (const d of DIMENSIONS) out[d] = levelToScore(levels[d]);
  return out;
}

/** Σ dim × weight / 100, rounded. 52/40/58/60 at 45/20/20/15 → 52. */
export function attemptScore(
  dims: DimensionScores,
  weights: DimensionWeights,
): number {
  return Math.round(
    DIMENSIONS.reduce((sum, d) => sum + (dims[d] * weights[d]) / 100, 0),
  );
}

const APPLIED_CREDIT: Record<AppliedStatus, number> = {
  applied: 1,
  partly: 0.5,
  not_applied: 0,
};

/** (applied 1, partly 0.5, not applied 0) ÷ points × 100, rounded. No points → 0. */
export function learningScore(applied: { status: AppliedStatus }[]): number {
  if (applied.length === 0) return 0;
  const credit = applied.reduce((sum, a) => sum + APPLIED_CREDIT[a.status], 0);
  return Math.round((credit / applied.length) * 100);
}

export type SessionQuestionScores = {
  first: number;
  /** null = retry skipped */
  second: number | null;
  /** null = retry skipped */
  learning: number | null;
};

export type SessionScoreResult = {
  firstTryAvg: number;
  retryAvg: number;
  learningAvg: number;
  score: number;
  band: Band;
};

const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const oneDecimal = (n: number) => Math.round(n * 10) / 10;

/**
 * Preparedness = w1·A1 + w2·A2 + wL·L (weights in percent), rounded.
 * A skipped retry counts A2 = A1 and L = 0. Averages are returned to one decimal; the score uses the
 * unrounded means.
 */
export function sessionScore(
  questions: SessionQuestionScores[],
  weights: SessionWeights,
): SessionScoreResult {
  const a1 = mean(questions.map((q) => q.first));
  const a2 = mean(
    questions.map((q) => (q.second === null ? q.first : q.second)),
  );
  const l = mean(
    questions.map((q) => (q.second === null ? 0 : (q.learning ?? 0))),
  );
  const score = Math.round(
    (a1 * weights.firstTry + a2 * weights.secondTry + l * weights.learning) /
      100,
  );
  return {
    firstTryAvg: oneDecimal(a1),
    retryAvg: oneDecimal(a2),
    learningAvg: oneDecimal(l),
    score,
    band: bandFor(score),
  };
}

/** 85–100 interview ready, 70–84 nearly ready, 50–69 developing, 0–49 not ready (SRS 5.4). */
export function bandFor(score: number): Band {
  if (score >= 85) return 'interview_ready';
  if (score >= 70) return 'nearly_ready';
  if (score >= 50) return 'developing';
  return 'not_ready';
}

/** SRS 5.4 "Message to candidate". */
export const BAND_MESSAGES: Record<Band, string> = {
  interview_ready: 'Strong and consistent; keep practising delivery',
  nearly_ready: 'Solid base; fix the listed focus areas',
  developing: 'Review flash cards and retake',
  not_ready: 'Study the flash cards again before retaking',
};

/** Per-dimension mean over attempts, rounded (Session.skills). */
export function skillsAverage(dimScores: DimensionScores[]): DimensionScores {
  const out = {} as DimensionScores;
  for (const d of DIMENSIONS)
    out[d] = Math.round(mean(dimScores.map((s) => s[d])));
  return out;
}
