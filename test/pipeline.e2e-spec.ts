import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import {
  STORAGE_ADAPTER,
  type StorageAdapter,
} from '../src/adapters/storage/storage.adapter.js';
import {
  QUEUE_SERVICE,
  type QueueService,
} from '../src/common/queue/queue.types.js';
import { AppConfig } from '../src/config/app-config.js';
import { DEFAULT_ROLE_SETTINGS } from '../src/modules/interview/types.js';
import {
  cleanupUsers,
  createTestApp,
  loginAs,
  runId,
  type TestApp,
} from './helpers/e2e.js';

// Attempt pipeline + WS gateway (plan §6, M5): fake STT/LLM/TTS, local storage, in-process queue.
const RUN = runId('pipeline');
const ANSWER = Array.from({ length: 70 }, (_, i) => `word${i}`).join(' ');

type Msg = { type: string; [k: string]: any };

describe('Attempt pipeline (e2e)', () => {
  let t: TestApp;
  let baseUrl: string;
  let origin: string;
  let storage: StorageAdapter;
  let queue: QueueService;
  let roleId: string;
  let questionId: string;
  let sessionId: string;
  let cookie: string;
  const audioKeys: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    await t.app.listen(0, '127.0.0.1');
    const { port } = t.app.getHttpServer().address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${port}`;
    origin = t.app.get(AppConfig).env.APP_CANDIDATE_ORIGIN;
    storage = t.app.get(STORAGE_ADAPTER);
    queue = t.app.get(QUEUE_SERVICE);

    const role = await t.prisma.jobRole.create({
      data: {
        slug: RUN,
        title: 'Pipeline Test Role',
        seniority: 'entry',
        keySkills: [],
        status: 'approved',
        settings: DEFAULT_ROLE_SETTINGS,
      },
    });
    roleId = role.id;
    const question = await t.prisma.question.create({
      data: {
        jobRoleId: roleId,
        text: 'Tell me about a time you helped an upset customer.',
        category: 'behavioural',
        difficulty: 'easy',
        rubric: {
          keyPoints: [{ id: 'kp1', point: 'Empathy', example: 'I listened' }],
          redFlags: [],
          expectedStructure: 'star',
        },
      },
    });
    questionId = question.id;

    const login = await loginAs(t.prisma, {
      email: `${RUN}-cand@example.test`,
    });
    cookie = login.cookie;
    const session = await t.prisma.session.create({
      data: {
        userId: login.user.id,
        jobRoleId: roleId,
        number: 1,
        mode: 'voice',
        weightsSnapshot: {
          sessionWeights: DEFAULT_ROLE_SETTINGS.sessionWeights,
          dimensionWeights: DEFAULT_ROLE_SETTINGS.dimensionWeights,
        },
        promptVersions: { interviewer: 0, evaluator: 0, summariser: 0 },
        questions: { create: [{ questionId, position: 1 }] },
      },
    });
    sessionId = session.id;
  });

  afterAll(async () => {
    if (t) {
      await Promise.all(
        audioKeys.map((k) => storage.delete(k).catch(() => undefined)),
      );
      if (sessionId)
        await t.prisma.unfiltered.aiCallLog.deleteMany({
          where: { sessionId },
        });
      await cleanupUsers(t.prisma, RUN);
      if (roleId)
        await t.prisma.unfiltered.jobRole.deleteMany({ where: { id: roleId } });
      await t.close();
    }
  });

  function connect(
    path = `/ws/sessions/${sessionId}`,
    headers?: Record<string, string>,
  ) {
    const ws = new WebSocket(`${baseUrl}${path}`, {
      headers: headers ?? { Cookie: cookie, Origin: origin },
    });
    const messages: Msg[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString()) as Msg));
    const open = new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return { ws, messages, open };
  }

  async function until(cond: () => boolean, ms = 10_000) {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end)
      await new Promise((r) => setTimeout(r, 20));
    expect(cond()).toBe(true);
  }

  const rejectedStatus = (ws: WebSocket) =>
    new Promise<number>((resolve) => {
      ws.once('unexpected-response', (_req, res) =>
        resolve(res.statusCode ?? 0),
      );
      ws.once('error', () => resolve(-1));
    });

  it('rejects an upgrade without a cookie (401) and a foreign origin (403)', async () => {
    const noCookie = connect(undefined, { Origin: origin });
    noCookie.open.catch(() => undefined);
    expect(await rejectedStatus(noCookie.ws)).toBe(401);

    const evil = connect(undefined, {
      Cookie: cookie,
      Origin: 'https://evil.example',
    });
    evil.open.catch(() => undefined);
    expect(await rejectedStatus(evil.ws)).toBe(403);
  });

  it('runs a voice attempt 1 and pushes transcribed → evaluated → audio_ready', async () => {
    const attempt = await t.prisma.attempt.create({
      data: {
        sessionId,
        questionId,
        attemptNo: 1,
        mode: 'voice',
        idempotencyKey: `${RUN}-1`,
        audioKey: `audio/${sessionId}/${RUN}-1.webm`,
      },
    });
    audioKeys.push(attempt.audioKey!);
    await storage.put(
      attempt.audioKey!,
      Buffer.from(`FAKE:${ANSWER}`),
      'audio/webm',
    );

    const { ws, messages, open } = connect();
    await open;
    await queue.add(
      'attempt',
      { attemptId: attempt.id },
      { jobId: `attempt-${attempt.id}` },
    );
    await until(() => messages.some((m) => m.type === 'feedback.audio_ready'));
    ws.close();

    expect(messages.map((m) => m.type)).toEqual([
      'attempt.transcribed',
      'attempt.evaluated',
      'feedback.audio_ready',
    ]);
    expect(messages[0]).toMatchObject({
      attemptId: attempt.id,
      questionId,
      attemptNo: 1,
      transcript: ANSWER,
    });
    expect(messages[1]).toMatchObject({
      attemptId: attempt.id,
      attemptNo: 1,
      applied: [],
      followUp: null,
      attempt: {
        id: attempt.id,
        mode: 'voice',
        transcript: ANSWER,
        audioUrl: `/api/attempts/${attempt.id}/audio`,
      },
    });
    expect(messages[1].attempt.feedback.delivery).toHaveLength(3);
    expect(messages[2]).toEqual({
      type: 'feedback.audio_ready',
      attemptId: attempt.id,
      url: `/api/attempts/${attempt.id}/feedback-audio`,
    });

    const row = await t.prisma.attempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(row).toMatchObject({
      status: 'done',
      error: null,
      transcript: ANSWER,
    });
    expect(row.wpm).toBeGreaterThan(0);
    expect(row.pauseCount).toBe(1);
    expect(row.score).toEqual(expect.any(Number));
    expect(row.feedbackAudioKey).toMatch(/^tts\//);
    expect(row.feedbackText).toEqual(expect.any(String));
    const logs = await t.prisma.aiCallLog.findMany({
      where: { attemptId: attempt.id },
    });
    expect(logs.map((l) => l.kind).sort()).toEqual(
      expect.arrayContaining(['llm', 'stt']),
    );
  });

  it('runs a typed attempt 2 with applied items and advances the question', async () => {
    const attempt = await t.prisma.attempt.create({
      data: {
        sessionId,
        questionId,
        attemptNo: 2,
        mode: 'typed',
        idempotencyKey: `${RUN}-2`,
        transcript: ANSWER,
      },
    });
    const { ws, messages, open } = connect(`/api/ws/sessions/${sessionId}`);
    await open;
    ws.send(JSON.stringify({ type: 'ping' }));
    await queue.add(
      'attempt',
      { attemptId: attempt.id },
      { jobId: `attempt-${attempt.id}` },
    );
    await until(() => messages.some((m) => m.type === 'attempt.evaluated'));
    ws.close();

    expect(messages.some((m) => m.type === 'pong')).toBe(true);
    expect(messages.some((m) => m.type === 'attempt.transcribed')).toBe(false);
    const evaluated = messages.find((m) => m.type === 'attempt.evaluated')!;
    expect(evaluated.attemptNo).toBe(2);
    expect(evaluated.applied).toHaveLength(2);
    expect(evaluated.applied[0]).toMatchObject({ status: 'applied' });

    const row = await t.prisma.attempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(row.status).toBe('done');
    expect(row.learningScore).toBe(100);
    const session = await t.prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
    });
    expect(session.currentQuestion).toBe(2);
  });
});
