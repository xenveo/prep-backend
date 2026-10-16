// Load test driver (plans/production-readiness/05-production-ops.md "Load test", NFR-01/02).
//
// Drives N virtual candidates through the real API: GET /api/roles → start a session → for each
// question: fetch its audio, upload try 1 (voice webm or typed), wait for `attempt.evaluated` on
// WS /api/ws/sessions/:id (polling GET /api/attempts/:id as a fallback), then try 2 or skip-retry →
// complete. Accounts and auth sessions are inserted straight into a dedicated *_load database
// (see seed.ts); the API under test must use that database and fake AI providers.
//
//   tsx test/load/run.ts --database-url postgresql://…/prep_db_load --concurrency 100 --ramp-sec 30
//
// Options (all optional except --database-url / LOAD_DATABASE_URL):
//   --base-url URL             API under test (default http://localhost:4300)
//   --origin URL               Origin header, as the candidate UI (default http://localhost:3001)
//   --concurrency N            virtual candidates running at once (default 5)
//   --sessions N               total sessions, one fresh candidate each (default = concurrency)
//   --ramp-sec S               spread the candidates' start over S seconds (default 0)
//   --think-ms MIN-MAX         pause before each answer (default 1000-3000)
//   --typed-ratio R            share of sessions answered by typing (default 0.3)
//   --retry-ratio R            share of questions answered twice, the rest skip the retry (default 0.5)
//   --feedback-timeout-sec S   upload → terminal limit before an attempt counts as lost (default 60)
//   --poll-after-sec S         no WS event this long → also poll the attempt (default 10)
//   --role SLUG                role to use (default: first approved role with enough questions)
//   --redis-url URL            sample the attempt queue depth (read-only), e.g. redis://localhost:6379/4
//   --redis-prefix P           REDIS_PREFIX of the API under test (default preppilot-load)
//   --out DIR                  where to write the JSON result (default test/load/results)
//
// Logs ids only. Writes <out>/<timestamp>.json and prints a markdown summary.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Redis } from 'ioredis';
import { SESSION_COOKIE } from '../../src/common/auth/auth.types.js';
import { runOutcome, seedCandidates } from './seed.js';
import {
  fmtMs,
  markdown,
  percentiles,
  Recorder,
  toObject,
  type Report,
} from './stats.js';
import { silentWebm } from './webm.js';

const { values: args } = parseArgs({
  options: {
    'base-url': { type: 'string', default: 'http://localhost:4300' },
    origin: { type: 'string', default: 'http://localhost:3001' },
    'database-url': { type: 'string' },
    concurrency: { type: 'string', default: '5' },
    sessions: { type: 'string' },
    'ramp-sec': { type: 'string', default: '0' },
    'think-ms': { type: 'string', default: '1000-3000' },
    'typed-ratio': { type: 'string', default: '0.3' },
    'retry-ratio': { type: 'string', default: '0.5' },
    'feedback-timeout-sec': { type: 'string', default: '60' },
    'poll-after-sec': { type: 'string', default: '10' },
    role: { type: 'string' },
    'redis-url': { type: 'string' },
    'redis-prefix': { type: 'string', default: 'preppilot-load' },
    out: { type: 'string', default: 'test/load/results' },
  },
});

const num = (name: keyof typeof args): number => {
  const n = Number(args[name]);
  if (!Number.isFinite(n) || n < 0)
    throw new Error(`--${name} must be a number`);
  return n;
};

const baseUrl = args['base-url'].replace(/\/+$/, '');
const origin = args.origin;
const databaseUrl = args['database-url'] ?? process.env.LOAD_DATABASE_URL;
if (!databaseUrl)
  throw new Error('--database-url (or LOAD_DATABASE_URL) is required');
const concurrency = Math.max(1, Math.floor(num('concurrency')));
const totalSessions = args.sessions ? Math.floor(num('sessions')) : concurrency;
const rampMs = num('ramp-sec') * 1000;
const [thinkMin, thinkMax] = args['think-ms'].split('-').map(Number);
if (!(thinkMin >= 0 && thinkMax >= thinkMin))
  throw new Error('--think-ms must be MIN-MAX');
const typedRatio = num('typed-ratio');
const retryRatio = num('retry-ratio');
const feedbackTimeoutMs = num('feedback-timeout-sec') * 1000;
const pollAfterMs = num('poll-after-sec') * 1000;
const REQUEST_TIMEOUT_MS = 30_000;

const CONSENT_TEXT =
  'Your answers are recorded, analysed and may be reviewed by your admin team. Your audio is stored for 30 days, then deleted.';
const TYPED_ANSWER =
  'In my last role a customer contacted us because a delivery had been late twice. I listened to the full story, ' +
  'acknowledged the frustration, checked the tracking and found the parcel stuck at the depot. I arranged a courier ' +
  'for the next morning, set a reminder, and called back the next day to confirm it had arrived. She thanked me and ' +
  'stayed a customer. I learned to own the follow-up rather than hand it off.';
const WEBM = new Uint8Array(silentWebm());

const rec = new Recorder();
const stats = {
  started: 0,
  completed: 0,
  failed: 0,
  active: 0,
  peakActive: 0,
  submitted: 0,
  evaluated: 0,
  attemptFailed: 0,
  lost: 0,
  viaWs: 0,
  viaPoll: 0,
  wsFailed: 0,
  failureReasons: new Map<string, number>(),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const round1 = (n: number) => Math.round(n * 10) / 10;

class HttpError extends Error {
  constructor(
    readonly endpoint: string,
    readonly status: string,
  ) {
    super(`${endpoint} → ${status}`);
  }
}

/** One measured request. Latency covers the full response body. Throws on an unexpected status. */
async function call<T>(
  endpoint: string,
  url: string,
  init: RequestInit & { token?: string; expect: number[] },
): Promise<{ body: T | null; res: Response }> {
  const { token, expect, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('Origin', origin);
  if (token) headers.set('Cookie', `${SESSION_COOKIE}=${token}`);
  const t0 = performance.now();
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      ...rest,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    const status = err instanceof Error ? err.name : 'Error';
    rec.request(endpoint, performance.now() - t0, status, false);
    throw new HttpError(endpoint, status);
  }
  const ok = expect.includes(res.status);
  let body: unknown = null;
  if (text && res.headers.get('content-type')?.includes('json'))
    body = JSON.parse(text);
  const code = (body as { error?: { code?: string } } | null)?.error?.code;
  const status = code ? `${res.status} ${code}` : String(res.status);
  rec.request(endpoint, performance.now() - t0, status, ok);
  if (!ok) throw new HttpError(endpoint, status);
  return { body: body as T, res };
}

type SessionEvent = { type: string; attemptId?: string };
type Terminal = {
  kind: 'evaluated' | 'failed';
  at: number;
  via: 'ws' | 'poll';
};

/** WS /api/ws/sessions/:id, keeping each attempt's first terminal event until it is awaited. */
class SessionSocket {
  private ws: WebSocket | null = null;
  private readonly terminal = new Map<string, Terminal>();
  private readonly waiters = new Map<string, () => void>();
  open = false;

  async connect(sessionId: string, token: string): Promise<void> {
    const url = `${baseUrl.replace(/^http/, 'ws')}/api/ws/sessions/${sessionId}`;
    const t0 = performance.now();
    // Node's (undici) WebSocket takes a non-standard `headers` init the DOM typings lack; it lets the
    // cookie and Origin go as a browser's would.
    const ws = new WebSocket(url, {
      headers: { Cookie: `${SESSION_COOKIE}=${token}`, Origin: origin },
    } as unknown as string[]);
    this.ws = ws;
    ws.onmessage = (m) => this.onMessage(String(m.data));
    ws.onclose = () => (this.open = false);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 5000);
      ws.onopen = () => {
        clearTimeout(timer);
        this.open = true;
        rec.sample('ws.connect', performance.now() - t0);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        stats.wsFailed++;
        resolve();
      };
    });
  }

  close(): void {
    this.ws?.close();
  }

  private onMessage(raw: string): void {
    let ev: SessionEvent;
    try {
      ev = JSON.parse(raw) as SessionEvent;
    } catch {
      return;
    }
    if (!ev.attemptId) return;
    const kind =
      ev.type === 'attempt.evaluated'
        ? 'evaluated'
        : ev.type === 'attempt.failed'
          ? 'failed'
          : null;
    if (kind)
      this.settle(ev.attemptId, { kind, at: performance.now(), via: 'ws' });
  }

  settle(attemptId: string, t: Terminal): void {
    if (this.terminal.has(attemptId)) return;
    this.terminal.set(attemptId, t);
    this.waiters.get(attemptId)?.();
  }

  /** The terminal event if it arrives within `ms`, else null. */
  async wait(attemptId: string, ms: number): Promise<Terminal | null> {
    const have = this.terminal.get(attemptId);
    if (have || ms <= 0) return have ?? null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.waiters.set(attemptId, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.waiters.delete(attemptId);
    return this.terminal.get(attemptId) ?? null;
  }
}

function bumpReason(reason: string): void {
  stats.failureReasons.set(reason, (stats.failureReasons.get(reason) ?? 0) + 1);
}

type StartedSession = {
  id: string;
  questions: { id: string; index: number }[];
};
type AttemptStatus = {
  status: 'transcribing' | 'evaluating' | 'done' | 'failed';
};

async function questionAudio(token: string, questionId: string): Promise<void> {
  const t0 = performance.now();
  const { res } = await call(
    'GET /api/questions/:id/audio (302)',
    `${baseUrl}/api/questions/${questionId}/audio`,
    {
      token,
      redirect: 'manual',
      expect: [302],
    },
  );
  const location = res.headers.get('location');
  if (!location)
    throw new HttpError('GET /api/questions/:id/audio (302)', 'no_location');
  await call(
    'GET signed audio URL (file)',
    new URL(location, baseUrl).toString(),
    {
      expect: [200],
    },
  );
  rec.sample('question.audio', performance.now() - t0);
}

/** Uploads one try and waits for its terminal state. Returns false when the session can't go on. */
async function attempt(
  token: string,
  socket: SessionSocket,
  sessionId: string,
  questionId: string,
  attemptNo: 1 | 2,
  mode: 'voice' | 'typed',
): Promise<boolean> {
  const form = new FormData();
  form.set('attemptNo', String(attemptNo));
  form.set('mode', mode);
  if (mode === 'typed') {
    form.set('durationSec', '0');
    form.set('text', TYPED_ANSWER);
  } else {
    const durationSec = round1(rand(30, 90));
    form.set('durationSec', String(durationSec));
    form.set('pauseCount', String(Math.floor(rand(2, 9))));
    form.set('longestPauseSec', String(round1(rand(1, 4))));
    form.set('speakingSec', String(round1(durationSec * 0.85)));
    form.set(
      'audio',
      new Blob([WEBM], { type: 'audio/webm;codecs=opus' }),
      'answer.webm',
    );
  }
  const t0 = performance.now();
  const { body } = await call<{ attemptId: string }>(
    `POST /api/sessions/:id/questions/:qid/attempts (${mode})`,
    `${baseUrl}/api/sessions/${sessionId}/questions/${questionId}/attempts`,
    {
      token,
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: form,
      expect: [202],
    },
  );
  stats.submitted++;
  const attemptId = body!.attemptId;

  const deadline = t0 + feedbackTimeoutMs;
  let result = await socket.wait(
    attemptId,
    socket.open ? Math.min(pollAfterMs, feedbackTimeoutMs) : 0,
  );
  while (!result && performance.now() < deadline) {
    const { body: st } = await call<AttemptStatus>(
      'GET /api/attempts/:id',
      `${baseUrl}/api/attempts/${attemptId}`,
      {
        token,
        expect: [200],
      },
    );
    if (st?.status === 'done' || st?.status === 'failed') {
      socket.settle(attemptId, {
        kind: st.status === 'done' ? 'evaluated' : 'failed',
        at: performance.now(),
        via: 'poll',
      });
    }
    result = await socket.wait(attemptId, 1000);
  }
  if (!result) {
    stats.lost++;
    bumpReason('attempt_lost');
    return false;
  }
  if (result.via === 'ws') stats.viaWs++;
  else stats.viaPoll++;
  if (result.kind === 'failed') {
    stats.attemptFailed++;
    bumpReason('attempt_failed');
    return false;
  }
  stats.evaluated++;
  const latency = result.at - t0;
  rec.sample('feedback.all', latency);
  rec.sample(`feedback.${mode}`, latency);
  return true;
}

async function candidateSession(
  token: string,
  roleId: string,
  typed: boolean,
): Promise<void> {
  const mode = typed ? 'typed' : 'voice';
  await call('GET /api/roles', `${baseUrl}/api/roles`, {
    token,
    expect: [200],
  });
  const { body: session } = await call<StartedSession>(
    'POST /api/roles/:id/sessions',
    `${baseUrl}/api/roles/${roleId}/sessions`,
    {
      token,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode,
        consent: { recording: true, text: CONSENT_TEXT, version: '2026-10-15' },
      }),
      expect: [201],
    },
  );
  stats.started++;
  const sessionId = session!.id;
  const socket = new SessionSocket();
  await socket.connect(sessionId, token);
  try {
    const questions = [...session!.questions].sort((a, b) => a.index - b.index);
    for (const q of questions) {
      await questionAudio(token, q.id);
      await sleep(rand(thinkMin, thinkMax));
      if (!(await attempt(token, socket, sessionId, q.id, 1, mode))) return;
      if (Math.random() < retryRatio) {
        await sleep(rand(thinkMin, thinkMax));
        if (!(await attempt(token, socket, sessionId, q.id, 2, mode))) return;
      } else {
        await call(
          'POST /api/sessions/:id/questions/:qid/skip-retry',
          `${baseUrl}/api/sessions/${sessionId}/questions/${q.id}/skip-retry`,
          {
            token,
            method: 'POST',
            expect: [204],
          },
        );
      }
    }
    await call(
      'POST /api/sessions/:id/complete',
      `${baseUrl}/api/sessions/${sessionId}/complete`,
      {
        token,
        method: 'POST',
        expect: [200],
      },
    );
    stats.completed++;
  } finally {
    socket.close();
  }
}

/** Read-only queue depth sampler for the attempt queue (BullMQ keys under the API's prefix). */
function sampleQueue(): { stop: () => Promise<Report['queue']> } | null {
  if (!args['redis-url']) return null;
  const redis = new Redis(args['redis-url'], { maxRetriesPerRequest: 1 });
  const key = (k: string) => `${args['redis-prefix']}:attempt:${k}`;
  const q = { samples: 0, maxWaiting: 0, maxActive: 0 };
  const timer = setInterval(() => {
    redis
      .multi()
      .llen(key('wait'))
      .zcard(key('prioritized'))
      .llen(key('active'))
      .exec()
      .then((r) => {
        if (!r) return;
        const [wait, prio, active] = r.map(([, v]) => Number(v));
        q.samples++;
        q.maxWaiting = Math.max(q.maxWaiting, wait + prio);
        q.maxActive = Math.max(q.maxActive, active);
      })
      .catch(() => undefined);
  }, 1000);
  return {
    stop: async () => {
      clearInterval(timer);
      await redis.quit().catch(() => undefined);
      return q;
    },
  };
}

async function main(): Promise<void> {
  const runId = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+/, '');
  const seeded = await seedCandidates(databaseUrl!, {
    runId: `${runId}-${randomUUID().slice(0, 4)}`,
    count: totalSessions,
    roleSlug: args.role,
  });
  console.error(
    `[load] run ${runId}: ${totalSessions} candidates on role ${seeded.roleId}, concurrency ${concurrency}, ramp ${rampMs / 1000}s`,
  );
  const typedCount = Math.round(totalSessions * typedRatio);
  const queue = sampleQueue();
  const startedAt = new Date();
  const t0 = performance.now();

  let next = 0;
  const progress = setInterval(
    () =>
      console.error(
        `[load] ${Math.round((performance.now() - t0) / 1000)}s active=${stats.active} completed=${stats.completed} failed=${stats.failed} attempts=${stats.evaluated}/${stats.submitted}`,
      ),
    5000,
  );
  await Promise.all(
    Array.from({ length: concurrency }, async (_, vu) => {
      await sleep((rampMs * vu) / concurrency);
      for (let i = next++; i < totalSessions; i = next++) {
        const { token } = seeded.candidates[i];
        stats.active++;
        stats.peakActive = Math.max(stats.peakActive, stats.active);
        try {
          // Spread typed sessions evenly: every candidate whose index crosses a typed boundary types.
          const typed =
            Math.floor(((i + 1) * typedCount) / totalSessions) >
            Math.floor((i * typedCount) / totalSessions);
          await candidateSession(token, seeded.roleId, typed);
        } catch (err) {
          stats.failed++;
          bumpReason(
            err instanceof HttpError
              ? `${err.endpoint} → ${err.status}`
              : `driver: ${String(err)}`,
          );
        } finally {
          stats.active--;
        }
      }
    }),
  );
  const wallMs = performance.now() - t0;
  clearInterval(progress);
  const queueStats = (await queue?.stop()) ?? null;

  // Lost attempts: anything still non-terminal after a grace period for the pipeline to drain.
  const userIds = seeded.candidates.map((c) => c.userId);
  let outcome = await runOutcome(databaseUrl!, userIds);
  const nonTerminal = (a: Record<string, number>) =>
    Object.entries(a)
      .filter(([s]) => s !== 'done' && s !== 'failed')
      .reduce((n, [, c]) => n + c, 0);
  for (let i = 0; i < 15 && nonTerminal(outcome.attempts) > 0; i++) {
    await sleep(1000);
    outcome = await runOutcome(databaseUrl!, userIds);
  }

  const isApi = (e: string) => e.includes('/api/');
  const byEndpoint = Object.fromEntries(
    [...rec.latency.keys()]
      .sort()
      .map((e) => [e, percentiles(rec.latency.get(e)!)]),
  );
  const overall = percentiles(rec.latencies(isApi));
  const feedbackAll = percentiles(rec.samples.get('feedback.all') ?? []);
  const qAudio = percentiles(rec.samples.get('question.audio') ?? []);
  const lostInDb = nonTerminal(outcome.attempts);
  const lost = stats.lost + lostInDb;
  const errorCount = [...rec.errors.values()].reduce(
    (n, m) => n + [...m.values()].reduce((a, b) => a + b, 0),
    0,
  );
  const wallSec = wallMs / 1000;

  const report: Report = {
    runId,
    config: {
      baseUrl,
      concurrency,
      sessions: totalSessions,
      rampSec: rampMs / 1000,
      thinkMs: args['think-ms'],
      typedRatio,
      retryRatio,
      role: seeded.roleSlug,
    },
    startedAt: startedAt.toISOString(),
    wallSec: round1(wallSec),
    sessions: {
      planned: totalSessions,
      started: stats.started,
      completed: stats.completed,
      failed: stats.failed,
      peakConcurrent: stats.peakActive,
      failureReasons: Object.fromEntries(stats.failureReasons),
    },
    api: { overall, byEndpoint },
    statuses: toObject(rec.statuses),
    errors: toObject(rec.errors),
    feedback: {
      uploadToEvaluated: feedbackAll,
      voice: percentiles(rec.samples.get('feedback.voice') ?? []),
      typed: percentiles(rec.samples.get('feedback.typed') ?? []),
      viaWebSocket: stats.viaWs,
      viaPolling: stats.viaPoll,
      wsConnectFailures: stats.wsFailed,
    },
    questionAudio: qAudio,
    wsConnect: percentiles(rec.samples.get('ws.connect') ?? []),
    attempts: {
      submitted: stats.submitted,
      evaluated: stats.evaluated,
      failed: stats.attemptFailed,
      lostByDriver: stats.lost,
      dbStatuses: outcome.attempts,
      lostInDb,
    },
    dbSessionStatuses: outcome.sessions,
    throughput: {
      apiRequestsPerSec: round1(rec.requestCount(isApi) / wallSec),
      attemptsEvaluatedPerSec: round1(stats.evaluated / wallSec),
      sessionsCompletedPerMin: round1((stats.completed / wallSec) * 60),
    },
    queue: queueStats,
    targets: [
      {
        name: 'API p95 (all requests)',
        target: '< 300 ms',
        actual: fmtMs(overall),
        pass: !!overall && overall.p95 < 300,
      },
      {
        name: 'Question audio p95 (302 + file)',
        target: '< 2000 ms',
        actual: fmtMs(qAudio),
        pass: !!qAudio && qAudio.p95 < 2000,
      },
      {
        name: 'Upload → attempt.evaluated p90',
        target: '< 8000 ms',
        actual: fmtMs(feedbackAll, 'p90'),
        pass: !!feedbackAll && feedbackAll.p90 < 8000,
      },
      {
        name: 'Lost attempts',
        target: '0',
        actual: String(lost),
        pass: lost === 0,
      },
      {
        name: 'Unexpected statuses',
        target: '0',
        actual: String(errorCount),
        pass: errorCount === 0,
      },
    ],
  };

  await mkdir(args.out, { recursive: true });
  const file = join(args.out, `${runId}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(markdown(report));
  console.error(`[load] wrote ${file}`);
  if (report.targets.some((t) => !t.pass)) process.exitCode = 1;
}

await main();
