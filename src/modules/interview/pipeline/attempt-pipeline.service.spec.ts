import { Logger } from '@nestjs/common';
import { FakeLlmAdapter } from '../../../adapters/llm/fake-llm.adapter.js';
import { LlmUnavailableError } from '../../../adapters/llm/llm.adapter.js';
import type { StorageAdapter } from '../../../adapters/storage/storage.adapter.js';
import { FakeSttAdapter } from '../../../adapters/stt/fake-stt.adapter.js';
import {
  SttUnavailableError,
  type SttAdapter,
} from '../../../adapters/stt/stt.adapter.js';
import type { EventBus } from '../../../common/events/event-bus.types.js';
import type { QueueService } from '../../../common/queue/queue.types.js';
import type { Attempt } from '../../../generated/prisma/client.js';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import type { AiCallLogService } from '../../ai/ai-call-log.service.js';
import { EvaluatorService } from '../../ai/evaluator.service.js';
import { PromptService } from '../../ai/prompt.service.js';
import type { TtsCacheService } from '../../content/tts-cache.service.js';
import type { SettingsService } from '../../settings/settings.service.js';
import { DEFAULT_DELIVERY_TARGETS } from '../scoring/delivery.js';
import { DEFAULT_ROLE_SETTINGS, type StoredFeedback } from '../types.js';
import {
  AttemptPipelineService,
  mimeTypeForKey,
  STALE_RUN_MS,
} from './attempt-pipeline.service.js';

const SESSION_ID = 'sess-1';
const QUESTION_ID = 'q-1';
const LONG_ANSWER = Array.from({ length: 70 }, (_, i) => `word${i}`).join(' ');

function attemptRow(over: Partial<Attempt> = {}): Attempt {
  const now = new Date();
  return {
    id: 'att-1',
    sessionId: SESSION_ID,
    questionId: QUESTION_ID,
    attemptNo: 1,
    mode: 'voice',
    status: 'received',
    idempotencyKey: 'k1',
    transcript: null,
    words: null,
    audioKey: `audio/${SESSION_ID}/att-1.webm`,
    audioExpiresAt: null,
    durationS: null,
    wpm: null,
    fillerCount: null,
    pauseCount: null,
    longestPauseS: null,
    dimensionScores: null,
    score: null,
    learningScore: null,
    feedback: null,
    feedbackText: null,
    feedbackAudioKey: null,
    evidence: null,
    error: null,
    submittedAt: now,
    updatedAt: now,
    ...over,
  };
}

function setup(opts: { sessionStatus?: string } = {}) {
  const attempts = new Map<string, Attempt>();
  const session = {
    status: opts.sessionStatus ?? 'in_progress',
    currentQuestion: 2,
    weightsSnapshot: {
      sessionWeights: DEFAULT_ROLE_SETTINGS.sessionWeights,
      dimensionWeights: DEFAULT_ROLE_SETTINGS.dimensionWeights,
    },
    role: { title: 'Customer Support Associate' },
  };
  const sq = {
    position: 2,
    followUpText: null as string | null,
    question: {
      text: 'Tell me about a time you helped an upset customer.',
      rubric: {
        keyPoints: [{ id: 'kp1', point: 'Empathy', example: 'I listened' }],
        redFlags: [],
        expectedStructure: 'star',
      },
    },
  };

  const update = (id: string, data: Partial<Attempt>) => {
    const row = attempts.get(id);
    if (!row) throw new Error('not found');
    const next = { ...row, ...data, updatedAt: new Date() };
    attempts.set(id, next);
    return next;
  };
  const prisma = {
    attempt: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return attempts.get(where.id) ?? null;
        const k = where.sessionId_questionId_attemptNo;
        return (
          [...attempts.values()].find(
            (a) =>
              a.sessionId === k.sessionId &&
              a.questionId === k.questionId &&
              a.attemptNo === k.attemptNo,
          ) ?? null
        );
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = attempts.get(where.id);
        if (!row) return { count: 0 };
        const ok = where.OR.some(
          (c: any) =>
            (typeof c.status === 'string'
              ? c.status === row.status
              : c.status.in.includes(row.status)) &&
            (!c.updatedAt || row.updatedAt < c.updatedAt.lt),
        );
        if (!ok) return { count: 0 };
        update(where.id, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: any) => update(where.id, data)),
    },
    session: {
      findUnique: vi.fn(async () => session),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (session.currentQuestion > where.currentQuestion.lte)
          return { count: 0 };
        session.currentQuestion = data.currentQuestion;
        return { count: 1 };
      }),
    },
    sessionQuestion: {
      findUnique: vi.fn(async () => sq),
      update: vi.fn(async ({ data }: any) => Object.assign(sq, data)),
    },
    promptVersion: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  const events: any[] = [];
  const bus: EventBus = {
    publish: vi.fn(async (channel: string, event: object) => {
      events.push({ channel, ...event });
    }),
    subscribe: vi.fn(),
  };
  const queue = { process: vi.fn() };
  const stt = new FakeSttAdapter();
  const audio = new Map<string, Buffer>();
  const storage = {
    get: vi.fn(async (key: string) => {
      const buf = audio.get(key);
      if (!buf) throw new Error('NoSuchKey');
      return buf;
    }),
  };
  const llm = new FakeLlmAdapter();
  const log = vi.fn().mockResolvedValue(undefined);
  const callLog = { log } as unknown as AiCallLogService;
  const evaluator = new EvaluatorService(
    llm,
    new PromptService(prisma as unknown as PrismaService),
    callLog,
  );
  const settings = {
    get: vi.fn(async () => ({ deliveryTargets: DEFAULT_DELIVERY_TARGETS })),
  };
  const tts = {
    getOrCreate: vi.fn(async () => ({ key: 'tts/abc.mp3', durationS: 7.6 })),
  };

  const service = new AttemptPipelineService(
    prisma as unknown as PrismaService,
    queue as unknown as QueueService,
    bus,
    stt as SttAdapter,
    storage as unknown as StorageAdapter,
    evaluator,
    callLog,
    settings as unknown as SettingsService,
    tts as unknown as TtsCacheService,
  );

  const addVoice = (over: Partial<Attempt> = {}, text = LONG_ANSWER) => {
    const row = attemptRow(over);
    attempts.set(row.id, row);
    if (row.audioKey) audio.set(row.audioKey, Buffer.from(`FAKE:${text}`));
    return row;
  };
  const addTyped = (over: Partial<Attempt> = {}) => {
    const row = attemptRow({
      mode: 'typed',
      audioKey: null,
      transcript: LONG_ANSWER,
      ...over,
    });
    attempts.set(row.id, row);
    return row;
  };

  return {
    service,
    prisma,
    attempts,
    session,
    sq,
    events,
    queue,
    stt,
    storage,
    llm,
    log,
    tts,
    addVoice,
    addTyped,
  };
}

describe('AttemptPipelineService', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() =>
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']),
  );

  it('registers the attempt processor with concurrency 10', () => {
    const t = setup();
    t.service.onModuleInit();
    expect(t.queue.process).toHaveBeenCalledWith(
      'attempt',
      expect.any(Function),
      { concurrency: 10 },
    );
  });

  it('voice: transcribes, saves metrics, evaluates, pushes in order, then speaks', async () => {
    const t = setup();
    t.addVoice();
    await t.service.processAttempt('att-1');

    const row = t.attempts.get('att-1')!;
    expect(row.status).toBe('done');
    expect(row.transcript).toBe(LONG_ANSWER);
    expect(row.words).toHaveLength(70);
    expect(row.wpm).toBeGreaterThan(100);
    expect(row.pauseCount).toBe(1);
    expect(row.longestPauseS).toBe(1.5);
    expect(row.fillerCount).toBe(0);
    expect(row.durationS).toBeGreaterThan(0);
    expect(row.score).toEqual(expect.any(Number));
    expect(row.learningScore).toBeNull();
    expect(row.feedbackAudioKey).toBe('tts/abc.mp3');
    expect(row.feedbackText).toBe(
      (row.feedback as StoredFeedback).spokenSummary,
    );
    const feedback = row.feedback as StoredFeedback;
    expect(feedback.delivery.map((d) => d.key)).toEqual([
      'pace',
      'fillers',
      'pauses',
    ]);
    expect(feedback.audioSeconds).toBe(8);
    expect(row.evidence).toHaveLength(1);

    expect(t.events.map((e) => e.type)).toEqual([
      'attempt.transcribed',
      'attempt.evaluated',
      'feedback.audio_ready',
    ]);
    expect(t.events.every((e) => e.channel === `session:${SESSION_ID}`)).toBe(
      true,
    );
    const evaluated = t.events[1];
    expect(evaluated).toMatchObject({
      attemptId: 'att-1',
      questionId: QUESTION_ID,
      attemptNo: 1,
      applied: [],
      followUp: null,
    });
    expect(evaluated.attempt).toMatchObject({
      id: 'att-1',
      attemptNo: 1,
      mode: 'voice',
      transcript: LONG_ANSWER,
      audioUrl: '/api/attempts/att-1/audio',
      feedbackAudioUrl: null,
    });
    expect(t.events[2]).toMatchObject({
      attemptId: 'att-1',
      url: '/api/attempts/att-1/feedback-audio',
    });
    expect(t.log).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'stt',
        status: 'ok',
        attemptId: 'att-1',
        sessionId: SESSION_ID,
      }),
    );
    expect(t.tts.getOrCreate).toHaveBeenCalledWith(feedback.spokenSummary, {
      sessionId: SESSION_ID,
      attemptId: 'att-1',
    });
    // Attempt 1 does not move the interview on.
    expect(t.session.currentQuestion).toBe(2);
  });

  it('typed: skips STT and metrics, delivery is []', async () => {
    const t = setup();
    t.addTyped({ durationS: 42 });
    const transcribe = vi.spyOn(t.stt, 'transcribe');
    await t.service.processAttempt('att-1');

    const row = t.attempts.get('att-1')!;
    expect(transcribe).not.toHaveBeenCalled();
    expect(t.storage.get).not.toHaveBeenCalled();
    expect(row.status).toBe('done');
    expect(row.wpm).toBeNull();
    expect(row.durationS).toBe(42);
    expect((row.feedback as StoredFeedback).delivery).toEqual([]);
    expect(t.events.map((e) => e.type)).toEqual([
      'attempt.evaluated',
      'feedback.audio_ready',
    ]);
    expect(t.events[0].attempt.durationSec).toBe(42);
  });

  it('attempt 2: passes attempt-1 improvement points, stores learning score, pushes applied, advances', async () => {
    const t = setup();
    t.addTyped();
    await t.service.processAttempt('att-1');
    const first = t.attempts.get('att-1')!.feedback as StoredFeedback;
    t.events.length = 0;

    t.addTyped({ id: 'att-2', attemptNo: 2, idempotencyKey: 'k2' });
    await t.service.processAttempt('att-2');

    const evaluatorCall = t.llm.calls.filter((c) => c.tag === 'evaluator')[1];
    const sent = evaluatorCall.messages[0].content;
    expect(sent.match(/<improvement_point>/g)).toHaveLength(
      first.improvementPoints.length,
    );
    expect(sent).toContain(
      `<improvement_point>${first.improvementPoints[0]}</improvement_point>`,
    );
    const row = t.attempts.get('att-2')!;
    expect(row.learningScore).toBe(100);
    const evaluated = t.events.find((e) => e.type === 'attempt.evaluated');
    expect(evaluated.attemptNo).toBe(2);
    expect(evaluated.followUp).toBeNull();
    expect(evaluated.applied).toEqual(
      first.improvementPoints.map((label) => ({
        label,
        status: 'applied',
        evidence: expect.any(String),
      })),
    );
    expect(t.session.currentQuestion).toBe(3);
  });

  it('attempt 1 follow-up is saved on the session question and pushed', async () => {
    const t = setup();
    t.addTyped();
    const canned = await t.llm.json({
      tag: 'evaluator',
      model: 'm',
      system: '',
      messages: [
        { role: 'user', content: '<candidate_answer>a b c</candidate_answer>' },
      ],
    } as any);
    t.llm.reset();
    t.llm.setNext('evaluator', {
      ...(canned.output as object),
      follow_up: 'What did you do next?',
    });
    await t.service.processAttempt('att-1');
    expect(t.sq.followUpText).toBe('What did you do next?');
    expect(t.events.find((e) => e.type === 'attempt.evaluated').followUp).toBe(
      'What did you do next?',
    );
  });

  it('evaluator failure: failed + ai_unavailable, attempt.failed offers text mode for voice', async () => {
    const t = setup();
    t.addVoice();
    t.llm.setNext('evaluator', new LlmUnavailableError('down'));
    t.llm.setNext('evaluator', new LlmUnavailableError('down'));
    await expect(t.service.processAttempt('att-1')).resolves.toBeUndefined();

    const row = t.attempts.get('att-1')!;
    expect(row.status).toBe('failed');
    expect(row.error).toBe('ai_unavailable');
    expect(t.events.map((e) => e.type)).toEqual([
      'attempt.transcribed',
      'attempt.failed',
    ]);
    expect(t.events[1]).toMatchObject({
      attemptId: 'att-1',
      code: 'ai_unavailable',
      retryable: true,
      textModeOffered: true,
    });
    expect(t.tts.getOrCreate).not.toHaveBeenCalled();
  });

  it('typed failure does not offer text mode', async () => {
    const t = setup();
    t.addTyped();
    t.llm.setNext('evaluator', new LlmUnavailableError('down'));
    t.llm.setNext('evaluator', new LlmUnavailableError('down'));
    await t.service.processAttempt('att-1');
    expect(t.events).toEqual([
      expect.objectContaining({
        type: 'attempt.failed',
        textModeOffered: false,
      }),
    ]);
  });

  it('STT failure: failed, logged as an stt error, no evaluation', async () => {
    const t = setup();
    t.addVoice();
    vi.spyOn(t.stt, 'transcribe').mockRejectedValue(
      new SttUnavailableError('timeout'),
    );
    await t.service.processAttempt('att-1');

    expect(t.attempts.get('att-1')!).toMatchObject({
      status: 'failed',
      error: 'ai_unavailable',
    });
    expect(t.log).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'stt', status: 'error' }),
    );
    expect(t.llm.calls).toHaveLength(0);
    expect(t.events.map((e) => e.type)).toEqual(['attempt.failed']);
  });

  it('missing audio fails the attempt', async () => {
    const t = setup();
    t.addVoice();
    t.storage.get.mockRejectedValueOnce(new Error('NoSuchKey'));
    await t.service.processAttempt('att-1');
    expect(t.attempts.get('att-1')!.status).toBe('failed');
    expect(t.events.map((e) => e.type)).toEqual(['attempt.failed']);
  });

  it('TTS failure keeps the attempt done without audio', async () => {
    const t = setup();
    t.addVoice();
    t.tts.getOrCreate.mockRejectedValueOnce(new Error('tts down'));
    await t.service.processAttempt('att-1');

    const row = t.attempts.get('att-1')!;
    expect(row.status).toBe('done');
    expect(row.feedbackAudioKey).toBeNull();
    expect(t.events.map((e) => e.type)).toEqual([
      'attempt.transcribed',
      'attempt.evaluated',
    ]);
  });

  it('is idempotent: a done attempt is a no-op', async () => {
    const t = setup();
    t.addTyped();
    await t.service.processAttempt('att-1');
    const calls = t.llm.calls.length;
    t.events.length = 0;
    await t.service.processAttempt('att-1');
    expect(t.llm.calls).toHaveLength(calls);
    expect(t.events).toEqual([]);
  });

  it('a failed attempt is skipped until it is reset to received', async () => {
    const t = setup();
    t.addTyped({ status: 'failed', error: 'ai_unavailable' });
    await t.service.processAttempt('att-1');
    expect(t.llm.calls).toHaveLength(0);

    t.attempts.set('att-1', {
      ...t.attempts.get('att-1')!,
      status: 'received',
    });
    await t.service.processAttempt('att-1');
    expect(t.attempts.get('att-1')!).toMatchObject({
      status: 'done',
      error: null,
    });
  });

  it('leaves a fresh in-flight run alone but takes over a stale one', async () => {
    const t = setup();
    t.addTyped({ status: 'evaluating', updatedAt: new Date() });
    await t.service.processAttempt('att-1');
    expect(t.llm.calls).toHaveLength(0);

    t.attempts.set('att-1', {
      ...t.attempts.get('att-1')!,
      updatedAt: new Date(Date.now() - STALE_RUN_MS - 1000),
    });
    await t.service.processAttempt('att-1');
    expect(t.attempts.get('att-1')!.status).toBe('done');
  });

  it('unknown attempt is a no-op', async () => {
    const t = setup();
    await t.service.processAttempt('missing');
    expect(t.events).toEqual([]);
  });

  it('a session that is no longer in progress fails the attempt quietly', async () => {
    const t = setup({ sessionStatus: 'abandoned' });
    t.addTyped();
    await t.service.processAttempt('att-1');
    expect(t.attempts.get('att-1')!).toMatchObject({
      status: 'failed',
      error: 'session_closed',
    });
    expect(t.events).toEqual([]);
    expect(t.llm.calls).toHaveLength(0);
  });

  it('maps audio keys to mime types', () => {
    expect(mimeTypeForKey('audio/s/a.webm')).toBe('audio/webm');
    expect(mimeTypeForKey('audio/s/a.M4A')).toBe('audio/mp4');
    expect(mimeTypeForKey('audio/s/a')).toBe('audio/webm');
  });
});
