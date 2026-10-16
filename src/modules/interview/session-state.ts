// Per-question interview state, derived from attempts and session_questions.retry_skipped
// (plan §6 state machine; there is no status column). Pure functions over a loaded session.
import type { Attempt, Prisma } from '../../generated/prisma/client.js';
import type {
  InProgressResult,
  InProgressSession,
} from './interview.schemas.js';
import {
  type SessionQuestionRow,
  toInterviewQuestion,
  toQuestionResult,
} from './serializers/candidate.serializer.js';

/** The session plus everything the candidate views need. */
export const SESSION_INCLUDE = {
  role: { select: { slug: true, title: true } },
  questions: {
    orderBy: { position: 'asc' },
    include: {
      question: {
        select: {
          id: true,
          text: true,
          category: true,
          card: { select: { position: true } },
        },
      },
    },
  },
  attempts: true,
} satisfies Prisma.SessionInclude;

export type LoadedSession = Prisma.SessionGetPayload<{
  include: typeof SESSION_INCLUDE;
}>;

export type QuestionState = {
  sq: SessionQuestionRow & { questionId: string; followUpText: string | null };
  first: Attempt | null;
  second: Attempt | null;
  /** Attempt 1 is done and either attempt 2 is done or the retry was skipped. */
  done: boolean;
};

const isDone = (a: Attempt | null): a is Attempt => a?.status === 'done';

export function questionStates(session: LoadedSession): QuestionState[] {
  return session.questions.map((sq) => {
    const first =
      session.attempts.find(
        (a) => a.questionId === sq.questionId && a.attemptNo === 1,
      ) ?? null;
    const second =
      session.attempts.find(
        (a) => a.questionId === sq.questionId && a.attemptNo === 2,
      ) ?? null;
    return {
      sq,
      first,
      second,
      done: isDone(first) && (sq.retrySkipped || isDone(second)),
    };
  });
}

/** 1-based position of the first question not yet done; questions.length + 1 once all are done. */
export function currentQuestionOf(states: QuestionState[]): number {
  const open = states.find((s) => !s.done);
  return open ? open.sq.position : states.length + 1;
}

/** In-progress resume state (NFR-03): results for every question whose first try is done. */
export function toInProgressView(session: LoadedSession): InProgressSession {
  const states = questionStates(session);
  const results: InProgressResult[] = [];
  for (const s of states) {
    if (!isDone(s.first)) continue;
    const second = isDone(s.second) ? s.second : null;
    const result: InProgressResult = {
      ...toQuestionResult(s.sq, s.first, second),
      state: s.done ? 'done' : 'awaiting_retry',
    };
    if (s.sq.followUpText) result.followUp = s.sq.followUpText;
    results.push(result);
  }
  const pending = session.attempts.find(
    (a) => a.status !== 'done' && a.status !== 'failed',
  );
  const failed = session.attempts.find((a) => a.status === 'failed');
  return {
    status: 'in_progress',
    mode: session.mode,
    currentQuestion: currentQuestionOf(states),
    questions: session.questions.map(toInterviewQuestion),
    results,
    pending: pending
      ? { questionId: pending.questionId, attemptNo: attemptNoOf(pending) }
      : null,
    failed: failed
      ? {
          questionId: failed.questionId,
          attemptNo: attemptNoOf(failed),
          code: failed.error ?? 'ai_unavailable',
        }
      : null,
  };
}

const attemptNoOf = (a: Pick<Attempt, 'attemptNo'>): 1 | 2 =>
  a.attemptNo === 2 ? 2 : 1;
