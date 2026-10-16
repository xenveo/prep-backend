import type { StorageAdapter } from '../../adapters/storage/storage.adapter.js';
import type { AppError } from '../../common/errors/app-error.js';
import type { QueueService } from '../../common/queue/queue.types.js';
import { ZodPipe } from '../../common/validation/zod.pipe.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { TtsCacheService } from '../content/tts-cache.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { AssignmentsService } from '../users/assignments.service.js';
import { AttemptsService } from './attempts.service.js';
import {
  submitAttemptSchema,
  uploadedVoiceMetrics,
} from './interview.schemas.js';
import {
  attempt,
  loadedSession,
  qid,
  SESSION_ID,
  USER_ID,
} from './fixtures.test-spec.js';
import type { SessionsService } from './sessions.service.js';

const typed = (attemptNo: 1 | 2) => ({
  attemptNo,
  mode: 'typed' as const,
  text: 'I owned the problem.',
  durationSec: 40,
});

function setup(session = loadedSession(2, [])) {
  const prisma = {
    attempt: {
      create: vi.fn(async ({ data }) => ({ ...attempt(1, 1), ...data })),
      update: vi.fn(async ({ where, data }) => ({
        ...attempt(1, 1),
        id: where.id,
        ...data,
      })),
      findFirst: vi.fn(),
    },
    question: { findUnique: vi.fn(), update: vi.fn() },
    sessionQuestion: { findFirst: vi.fn() },
  };
  const sessions = { loadOwned: vi.fn().mockResolvedValue(session) };
  const storage = {
    put: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    signedUrl: vi.fn(async (k: string) => `https://signed/${k}`),
  };
  const queue = { add: vi.fn().mockResolvedValue({ jobId: 'j' }) };
  const settings = {
    get: vi.fn().mockResolvedValue({ audioRetentionDays: 30 }),
  };
  const tts = {
    getOrCreate: vi.fn().mockResolvedValue({ key: 'tts/q.mp3', durationS: 3 }),
    signedUrl: vi.fn(async (k: string) => `https://signed/${k}`),
  };
  const assignments = { findCandidateRole: vi.fn() };
  const service = new AttemptsService(
    prisma as unknown as PrismaService,
    sessions as unknown as SessionsService,
    assignments as unknown as AssignmentsService,
    settings as unknown as SettingsService,
    tts as unknown as TtsCacheService,
    storage as unknown as StorageAdapter,
    queue as unknown as QueueService,
  );
  return { service, prisma, storage, queue, tts, assignments };
}

async function errorOf(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a rejection');
}

describe('AttemptsService.submit', () => {
  it('creates a typed attempt 1 and enqueues it', async () => {
    const { service, prisma, queue } = setup();
    const { attemptId } = await service.submit(
      USER_ID,
      SESSION_ID,
      qid(1),
      'k1',
      typed(1),
      undefined,
    );
    const data = prisma.attempt.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      id: attemptId,
      sessionId: SESSION_ID,
      questionId: qid(1),
      attemptNo: 1,
      mode: 'typed',
      idempotencyKey: 'k1',
      transcript: 'I owned the problem.',
      audioKey: null,
      durationS: 40,
    });
    const [name, job, opts] = queue.add.mock.calls[0];
    expect(name).toBe('attempt');
    expect(job).toEqual({ attemptId });
    expect(opts.attempts).toBe(1);
    expect(opts.jobId).toMatch(
      new RegExp(`^attempt-${SESSION_ID}-${attemptId}-[0-9a-z]+$`),
    );
    expect(opts.jobId).not.toContain(':');
  });

  it('stores voice audio under audio/<sessionId>/<attemptId>.<ext> with an expiry', async () => {
    const { service, prisma, storage } = setup();
    const { attemptId } = await service.submit(
      USER_ID,
      SESSION_ID,
      qid(1),
      'k1',
      { attemptNo: 1, mode: 'voice', durationSec: 50 },
      { buffer: Buffer.from('abc'), mimetype: 'audio/webm;codecs=opus' },
    );
    const key = `audio/${SESSION_ID}/${attemptId}.webm`;
    expect(storage.put).toHaveBeenCalledWith(
      key,
      expect.any(Buffer),
      'audio/webm;codecs=opus',
    );
    const data = prisma.attempt.create.mock.calls[0][0].data;
    expect(data.audioKey).toBe(key);
    expect(data.transcript).toBeNull();
    const days =
      (data.audioExpiresAt.getTime() - data.submittedAt.getTime()) / 864e5;
    expect(days).toBe(30);
  });

  it('stores browser-measured pause metrics on a voice attempt, clamped to the duration', async () => {
    const { service, prisma } = setup();
    await service.submit(
      USER_ID,
      SESSION_ID,
      qid(1),
      'k1',
      submitAttemptSchema.parse({
        attemptNo: '1',
        mode: 'voice',
        durationSec: '50',
        pauseCount: '4',
        longestPauseSec: '2.5',
        speakingSec: '61.2',
      }),
      { buffer: Buffer.from('abc'), mimetype: 'audio/webm' },
    );
    expect(prisma.attempt.create.mock.calls[0][0].data).toMatchObject({
      durationS: 50,
      pauseCount: 4,
      longestPauseS: 2.5,
      speakingS: 50,
    });
  });

  it('ignores pause metrics on a typed attempt and clears them on resubmission', async () => {
    const failed = attempt(1, 1, {
      status: 'failed',
      idempotencyKey: 'old',
      pauseCount: 3,
      speakingS: 12,
    });
    const { service, prisma } = setup(loadedSession(2, [failed]));
    await service.submit(
      USER_ID,
      SESSION_ID,
      qid(1),
      'new',
      { ...typed(1), pauseCount: 3, longestPauseSec: 1, speakingSec: 12 },
      undefined,
    );
    expect(prisma.attempt.update.mock.calls[0][0].data).toMatchObject({
      pauseCount: null,
      longestPauseS: null,
      speakingS: null,
    });
  });

  it('rejects voice without audio or with an unknown type', async () => {
    const { service } = setup();
    const voice = {
      attemptNo: 1 as const,
      mode: 'voice' as const,
      durationSec: 5,
    };
    expect(
      (
        await errorOf(
          service.submit(USER_ID, SESSION_ID, qid(1), 'k', voice, undefined),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await errorOf(
          service.submit(USER_ID, SESSION_ID, qid(1), 'k', voice, {
            buffer: Buffer.from('x'),
            mimetype: 'image/png',
          }),
        )
      ).status,
    ).toBe(400);
  });

  it('replays the same key to the same attempt without a new row or job', async () => {
    const { service, prisma, queue } = setup(
      loadedSession(2, [
        attempt(1, 1, { idempotencyKey: 'k1', status: 'evaluating' }),
      ]),
    );
    const res = await service.submit(
      USER_ID,
      SESSION_ID,
      qid(1),
      'k1',
      typed(1),
      undefined,
    );
    expect(res.attemptId).toBe(attempt(1, 1).id);
    expect(prisma.attempt.create).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('409 for a second attempt 1 with a new key', async () => {
    const { service } = setup(loadedSession(2, [attempt(1, 1)]));
    const e = await errorOf(
      service.submit(USER_ID, SESSION_ID, qid(1), 'k2', typed(1), undefined),
    );
    expect([e.status, e.code]).toEqual([409, 'conflict']);
  });

  it('attempt 2 needs attempt 1 done', async () => {
    const { service } = setup(
      loadedSession(2, [attempt(1, 1, { status: 'evaluating' })]),
    );
    const e = await errorOf(
      service.submit(USER_ID, SESSION_ID, qid(1), 'k2', typed(2), undefined),
    );
    expect(e.status).toBe(409);
  });

  it('attempt 2 is refused after a skipped retry', async () => {
    const { service } = setup(loadedSession(2, [attempt(1, 1)], {}, [1]));
    const e = await errorOf(
      service.submit(USER_ID, SESSION_ID, qid(1), 'k2', typed(2), undefined),
    );
    expect(e.status).toBe(409);
  });

  it('accepts attempt 2 once attempt 1 is done', async () => {
    const { service, prisma } = setup(loadedSession(2, [attempt(1, 1)]));
    await service.submit(
      USER_ID,
      SESSION_ID,
      qid(1),
      'k2',
      typed(2),
      undefined,
    );
    expect(prisma.attempt.create.mock.calls[0][0].data.attemptNo).toBe(2);
  });

  it('resubmits a failed attempt by reusing and resetting its row', async () => {
    const failed = attempt(1, 1, {
      status: 'failed',
      error: 'ai_unavailable',
      score: null,
      idempotencyKey: 'old',
    });
    const { service, prisma, queue } = setup(loadedSession(2, [failed]));
    const res = await service.submit(
      USER_ID,
      SESSION_ID,
      qid(1),
      'new',
      typed(1),
      undefined,
    );
    expect(res.attemptId).toBe(failed.id);
    expect(prisma.attempt.create).not.toHaveBeenCalled();
    const { where, data } = prisma.attempt.update.mock.calls[0][0];
    expect(where).toEqual({ id: failed.id });
    expect(data).toMatchObject({
      status: 'received',
      idempotencyKey: 'new',
      error: null,
      score: null,
      transcript: 'I owned the problem.',
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('404 for a question outside the session; 409 when the session is over', async () => {
    const { service } = setup();
    expect(
      (
        await errorOf(
          service.submit(USER_ID, SESSION_ID, qid(9), 'k', typed(1), undefined),
        )
      ).status,
    ).toBe(404);
    const done = setup(loadedSession(1, [], { status: 'completed' }));
    expect(
      (
        await errorOf(
          done.service.submit(
            USER_ID,
            SESSION_ID,
            qid(1),
            'k',
            typed(1),
            undefined,
          ),
        )
      ).status,
    ).toBe(409);
  });
});

describe('submitAttemptSchema pause fields', () => {
  const base = { attemptNo: '1', mode: 'voice', durationSec: '40' };

  it('coerces the optional multipart strings', () => {
    expect(
      submitAttemptSchema.parse({
        ...base,
        pauseCount: '3',
        longestPauseSec: '1.8',
        speakingSec: '31.5',
      }),
    ).toMatchObject({ pauseCount: 3, longestPauseSec: 1.8, speakingSec: 31.5 });
    const bare = submitAttemptSchema.parse(base);
    expect(bare.pauseCount).toBeUndefined();
    expect(bare.speakingSec).toBeUndefined();
  });

  it('requires durationSec > 0 for a voice answer, not for a typed one', () => {
    for (const durationSec of [undefined, '0']) {
      const r = submitAttemptSchema.safeParse({ ...base, durationSec });
      expect(r.success).toBe(false);
      expect(r.error?.issues).toEqual([
        expect.objectContaining({
          path: ['durationSec'],
          message: 'required for a voice answer',
        }),
      ]);
    }
    expect(
      submitAttemptSchema.safeParse({
        attemptNo: '1',
        mode: 'typed',
        text: 'Typed.',
      }).success,
    ).toBe(true);
    expect(() =>
      new ZodPipe(submitAttemptSchema).transform({ ...base, durationSec: '0' }),
    ).toThrow(
      expect.objectContaining({
        code: 'validation_failed',
        status: 400,
        message: 'durationSec: required for a voice answer',
      }),
    );
  });

  it.each([
    ['pauseCount', '-1'],
    ['pauseCount', '1.5'],
    ['pauseCount', 'x'],
    ['longestPauseSec', '-0.1'],
    ['speakingSec', '0'],
    ['speakingSec', '301'],
  ])('rejects %s = %s', (field, value) => {
    expect(
      submitAttemptSchema.safeParse({ ...base, [field]: value }).success,
    ).toBe(false);
  });

  it('clamps the times to durationSec, and drops everything for typed answers', () => {
    const voice = submitAttemptSchema.parse({
      ...base,
      pauseCount: '2',
      longestPauseSec: '55',
      speakingSec: '45',
    });
    expect(uploadedVoiceMetrics(voice)).toEqual({
      pauseCount: 2,
      longestPauseS: 40,
      speakingS: 40,
    });
    expect(uploadedVoiceMetrics(submitAttemptSchema.parse(base))).toEqual({
      pauseCount: null,
      longestPauseS: null,
      speakingS: null,
    });
    expect(
      uploadedVoiceMetrics({ ...voice, mode: 'typed', text: 'Typed.' }),
    ).toEqual({ pauseCount: null, longestPauseS: null, speakingS: null });
  });
});

describe('AttemptsService.status and audio', () => {
  it('reports received as transcribing and failed with a code', async () => {
    const { service, prisma } = setup();
    prisma.attempt.findFirst.mockResolvedValueOnce(
      attempt(1, 1, { status: 'received' }),
    );
    expect(await service.status(USER_ID, attempt(1, 1).id)).toEqual({
      status: 'transcribing',
    });
    prisma.attempt.findFirst.mockResolvedValueOnce(
      attempt(1, 1, { status: 'failed', error: 'ai_unavailable' }),
    );
    expect(await service.status(USER_ID, attempt(1, 1).id)).toEqual({
      status: 'failed',
      code: 'ai_unavailable',
    });
  });

  it('returns the candidate attempt and applied items when done', async () => {
    const { service, prisma } = setup();
    prisma.attempt.findFirst.mockResolvedValue(attempt(1, 2));
    const view = await service.status(USER_ID, attempt(1, 2).id);
    expect(view.status).toBe('done');
    expect(view.attempt).toMatchObject({ attemptNo: 2, mode: 'typed' });
    expect(view.applied).toEqual([]);
  });

  it('410 when the answer audio expired', async () => {
    const { service, prisma } = setup();
    prisma.attempt.findFirst.mockResolvedValue(
      attempt(1, 1, {
        mode: 'voice',
        audioKey: 'audio/x.webm',
        audioExpiresAt: new Date(Date.now() - 1000),
      }),
    );
    const e = await errorOf(service.answerAudioUrl(USER_ID, attempt(1, 1).id));
    expect([e.status, e.code]).toEqual([410, 'gone']);
  });

  it('caches the question TTS key on the question', async () => {
    const { service, prisma } = setup();
    prisma.question.findUnique.mockResolvedValue({
      id: qid(1),
      text: 'Tell me',
      audioKey: null,
      jobRoleId: 'r',
      status: 'approved',
    });
    prisma.sessionQuestion.findFirst.mockResolvedValue({
      sessionId: SESSION_ID,
    });
    expect(await service.questionAudioUrl(USER_ID, qid(1))).toBe(
      'https://signed/tts/q.mp3',
    );
    expect(prisma.question.update).toHaveBeenCalledWith({
      where: { id: qid(1) },
      data: { audioKey: 'tts/q.mp3' },
    });
  });
});
