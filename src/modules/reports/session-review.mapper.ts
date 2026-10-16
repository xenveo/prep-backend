// Attempt rows → the admin UI's `Try` and `SessionQuestion` (FR-REP-02). Pure functions.
import type { Attempt } from '../../generated/prisma/client.js';
import { toAdminApplied, toAdminBand } from '../../common/mapping/enums.js';
import { toAdminDelivery } from '../interview/scoring/delivery.js';
import { bandFor } from '../interview/scoring/score.js';
import type {
  DimensionScores,
  SessionWeights,
  StoredFeedback,
} from '../interview/types.js';
import { formatDuration } from './format.js';
import type { ReviewQuestion, Try } from './reports.types.js';

export type ReviewAttempt = Pick<
  Attempt,
  | 'attemptNo'
  | 'mode'
  | 'score'
  | 'durationS'
  | 'dimensionScores'
  | 'transcript'
  | 'feedback'
  | 'wpm'
  | 'fillerCount'
  | 'longestPauseS'
>;

/** "20% first try + 55% second try + 25% learning = 78" */
export function sessionFormulaText(
  score: number,
  weights: SessionWeights,
): string {
  return `${weights.firstTry}% first try + ${weights.secondTry}% second try + ${weights.learning}% learning = ${score}`;
}

const EMPTY_SCORES: DimensionScores = {
  content: 0,
  structure: 0,
  delivery: 0,
  relevance: 0,
};

/** One evaluated attempt as a `Try`. `audioUrl` is the signed URL (or null once audio expired). */
export function toTry(a: ReviewAttempt, audioUrl: string | null): Try {
  const feedback = a.feedback as Partial<StoredFeedback> | null;
  const score = a.score ?? 0;
  const seconds = Math.round(a.durationS ?? 0);
  const voice = a.wpm !== null && a.fillerCount !== null;
  const out: Try = {
    attempt: a.attemptNo === 2 ? 2 : 1,
    mode: a.mode,
    score,
    band: toAdminBand(bandFor(score)),
    audioSeconds: seconds,
    audioLabel: formatDuration(seconds),
    subScores: (a.dimensionScores as DimensionScores | null) ?? EMPTY_SCORES,
    transcript: a.transcript ?? '',
    highlights: (feedback?.highlights ?? []).map((h) => ({
      text: h.quote,
      kind: h.kind,
      note: h.note,
    })),
    worked: (feedback?.worked ?? []).join(' '),
    improve: (feedback?.improve ?? []).join(' '),
    delivery: voice
      ? toAdminDelivery({
          wpm: a.wpm!,
          fillerCount: a.fillerCount!,
          longestPauseS: a.longestPauseS,
        })
      : null,
    audioUrl,
  };
  if (a.attemptNo === 2)
    out.appliedFromFeedback = (feedback?.applied ?? []).map((p) => ({
      text: p.point,
      state: toAdminApplied(p.status),
      ...(p.evidence && { detail: p.evidence }),
    }));
  return out;
}

/**
 * One question of the session. Without an attempt 2 (retry skipped or never answered) it has a
 * single try and a null second score. The session aggregates still count a skipped retry as A2 = A1
 * (plan §6 "Scoring"); those come from stored session fields, not from here.
 */
export function toReviewQuestion(input: {
  position: number;
  text: string;
  category: string;
  retrySkipped: boolean;
  first: Try;
  second: Try | null;
}): ReviewQuestion {
  const second = input.retrySkipped ? null : input.second;
  return {
    n: input.position,
    text: input.text,
    category: input.category,
    firstScore: input.first.score,
    secondScore: second?.score ?? null,
    retrySkipped: input.retrySkipped,
    tries: second ? [input.first, second] : [input.first],
  };
}
