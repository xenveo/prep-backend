import { attempt, loadedSession, qid } from './fixtures.test-spec.js';
import {
  currentQuestionOf,
  questionStates,
  toInProgressView,
} from './session-state.js';

describe('session state', () => {
  it('starts at question 1 with nothing pending', () => {
    const view = toInProgressView(loadedSession(3, []));
    expect(view).toMatchObject({
      status: 'in_progress',
      mode: 'typed',
      currentQuestion: 1,
      results: [],
      pending: null,
      failed: null,
    });
    expect(view.questions.map((q) => q.index)).toEqual([1, 2, 3]);
    expect(view.questions[0]).toEqual({
      id: qid(1),
      index: 1,
      text: 'Question 1',
      cardId: 3,
      category: 'Behavioural',
    });
  });

  it('reports a processing attempt as pending (refresh mid-attempt, NFR-03)', () => {
    const view = toInProgressView(
      loadedSession(2, [attempt(1, 1, { status: 'evaluating' })]),
    );
    expect(view.pending).toEqual({ questionId: qid(1), attemptNo: 1 });
    expect(view.currentQuestion).toBe(1);
    expect(view.results).toEqual([]);
  });

  it('shows attempt 1 done as awaiting_retry and keeps the question current', () => {
    const view = toInProgressView(loadedSession(2, [attempt(1, 1)]));
    expect(view.currentQuestion).toBe(1);
    expect(view.results).toHaveLength(1);
    expect(view.results[0]).toMatchObject({
      state: 'awaiting_retry',
      second: null,
      applied: [],
    });
  });

  it('a pending second try keeps the result awaiting_retry with second null', () => {
    const view = toInProgressView(
      loadedSession(2, [
        attempt(1, 1),
        attempt(1, 2, { status: 'transcribing' }),
      ]),
    );
    expect(view.results[0].state).toBe('awaiting_retry');
    expect(view.results[0].second).toBeNull();
    expect(view.pending).toEqual({ questionId: qid(1), attemptNo: 2 });
  });

  it('advances past questions with a done retry or a skipped retry', () => {
    const session = loadedSession(
      3,
      [attempt(1, 1), attempt(1, 2), attempt(2, 1)],
      {},
      [2],
    );
    const view = toInProgressView(session);
    expect(view.currentQuestion).toBe(3);
    expect(view.results.map((r) => r.state)).toEqual(['done', 'done']);
    expect(view.results[1].second).toBeNull();
  });

  it('is questions.length + 1 once every question is done', () => {
    const states = questionStates(loadedSession(1, [attempt(1, 1)], {}, [1]));
    expect(currentQuestionOf(states)).toBe(2);
  });

  it('reports a failed attempt with its code', () => {
    const view = toInProgressView(
      loadedSession(1, [
        attempt(1, 1, {
          status: 'failed',
          score: null,
          error: 'ai_unavailable',
        }),
      ]),
    );
    expect(view.failed).toEqual({
      questionId: qid(1),
      attemptNo: 1,
      code: 'ai_unavailable',
    });
    expect(view.pending).toBeNull();
  });
});
