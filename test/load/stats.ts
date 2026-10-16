// Latency and status bookkeeping for the load driver, plus the markdown report.

export type Pct = {
  count: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
};

/** Nearest-rank percentiles, in ms rounded to 0.1. Null when there are no samples. */
export function percentiles(samples: number[]): Pct | null {
  if (samples.length === 0) return null;
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number) => s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
  const r = (n: number) => Math.round(n * 10) / 10;
  return {
    count: s.length,
    mean: r(s.reduce((a, b) => a + b, 0) / s.length),
    p50: r(at(50)),
    p90: r(at(90)),
    p95: r(at(95)),
    p99: r(at(99)),
    max: r(s[s.length - 1]),
  };
}

export class Recorder {
  /** endpoint label → latencies (ms) of every response, whatever its status. */
  readonly latency = new Map<string, number[]>();
  /** endpoint label → status (or network error name) → count. */
  readonly statuses = new Map<string, Map<string, number>>();
  /** endpoint label → unexpected status → count. */
  readonly errors = new Map<string, Map<string, number>>();
  readonly samples = new Map<string, number[]>();

  request(endpoint: string, ms: number, status: string, ok: boolean): void {
    push(this.latency, endpoint, ms);
    bump(this.statuses, endpoint, status);
    if (!ok) bump(this.errors, endpoint, status);
  }

  /** Non-request timings: feedback latency, question audio, WS connect. */
  sample(name: string, ms: number): void {
    push(this.samples, name, ms);
  }

  requestCount(filter: (endpoint: string) => boolean = () => true): number {
    let n = 0;
    for (const [e, l] of this.latency) if (filter(e)) n += l.length;
    return n;
  }

  latencies(filter: (endpoint: string) => boolean): number[] {
    return [...this.latency].filter(([e]) => filter(e)).flatMap(([, l]) => l);
  }
}

function push(m: Map<string, number[]>, k: string, v: number): void {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}

function bump(m: Map<string, Map<string, number>>, k: string, s: string) {
  let inner = m.get(k);
  if (!inner) m.set(k, (inner = new Map()));
  inner.set(s, (inner.get(s) ?? 0) + 1);
}

export const toObject = (
  m: Map<string, Map<string, number>>,
): Record<string, Record<string, number>> =>
  Object.fromEntries([...m].map(([k, v]) => [k, Object.fromEntries(v)]));

export type Target = {
  name: string;
  target: string;
  actual: string;
  pass: boolean;
};

export type Report = {
  runId: string;
  config: Record<string, unknown>;
  startedAt: string;
  wallSec: number;
  sessions: {
    planned: number;
    started: number;
    completed: number;
    failed: number;
    peakConcurrent: number;
    failureReasons: Record<string, number>;
  };
  api: { overall: Pct | null; byEndpoint: Record<string, Pct | null> };
  statuses: Record<string, Record<string, number>>;
  errors: Record<string, Record<string, number>>;
  feedback: {
    uploadToEvaluated: Pct | null;
    voice: Pct | null;
    typed: Pct | null;
    viaWebSocket: number;
    viaPolling: number;
    wsConnectFailures: number;
  };
  questionAudio: Pct | null;
  wsConnect: Pct | null;
  attempts: {
    submitted: number;
    evaluated: number;
    failed: number;
    lostByDriver: number;
    dbStatuses: Record<string, number>;
    lostInDb: number;
  };
  dbSessionStatuses: Record<string, number>;
  throughput: {
    apiRequestsPerSec: number;
    attemptsEvaluatedPerSec: number;
    sessionsCompletedPerMin: number;
  };
  queue: {
    samples: number;
    maxWaiting: number;
    maxActive: number;
  } | null;
  targets: Target[];
};

export const fmtMs = (p: Pct | null, k: keyof Pct = 'p95') =>
  p ? `${p[k]} ms` : 'n/a';

function pctRow(name: string, p: Pct | null): string {
  if (!p) return `| ${name} | 0 | | | | | |`;
  return `| ${name} | ${p.count} | ${p.p50} | ${p.p90} | ${p.p95} | ${p.p99} | ${p.max} |`;
}

const PCT_HEAD =
  '| | n | p50 ms | p90 ms | p95 ms | p99 ms | max ms |\n|---|---:|---:|---:|---:|---:|---:|';

export function markdown(r: Report): string {
  const s = r.sessions;
  const lines = [
    `## Load test ${r.runId}`,
    '',
    `Config: ${Object.entries(r.config)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(', ')}`,
    '',
    `Wall time ${r.wallSec} s. Sessions: ${s.planned} planned, ${s.started} started, ${s.completed} completed, ${s.failed} failed; peak ${s.peakConcurrent} concurrent.`,
    '',
    'Fake LLM/STT/TTS providers: latency here is API + Redis/BullMQ + Postgres only. Real-provider',
    'latency was measured separately in P2 (written feedback about 5 s typed, 8 to 9 s voice).',
    '',
    '### Targets (NFR-01)',
    '',
    '| Target | Goal | Actual | |',
    '|---|---|---|---|',
    ...r.targets.map(
      (t) =>
        `| ${t.name} | ${t.target} | ${t.actual} | ${t.pass ? 'PASS' : 'FAIL'} |`,
    ),
    '',
    '### API latency',
    '',
    PCT_HEAD,
    pctRow('**all API requests**', r.api.overall),
    ...Object.entries(r.api.byEndpoint).map(([e, p]) => pctRow(e, p)),
    '',
    '### Pipeline and audio',
    '',
    PCT_HEAD,
    pctRow('upload → attempt.evaluated (all)', r.feedback.uploadToEvaluated),
    pctRow('upload → attempt.evaluated (voice)', r.feedback.voice),
    pctRow('upload → attempt.evaluated (typed)', r.feedback.typed),
    pctRow('question audio (302 + download)', r.questionAudio),
    pctRow('WS connect', r.wsConnect),
    '',
    `Feedback delivered via WebSocket ${r.feedback.viaWebSocket}, via polling fallback ${r.feedback.viaPolling}; WS connect failures ${r.feedback.wsConnectFailures}.`,
    '',
    '### Attempts and errors',
    '',
    `Attempts: ${r.attempts.submitted} submitted, ${r.attempts.evaluated} evaluated, ${r.attempts.failed} failed, ${r.attempts.lostByDriver} lost (driver timeout).`,
    `DB attempt statuses: ${JSON.stringify(r.attempts.dbStatuses)}; non-terminal after grace period: ${r.attempts.lostInDb}.`,
    `DB session statuses: ${JSON.stringify(r.dbSessionStatuses)}.`,
    `Unexpected statuses: ${Object.keys(r.errors).length ? JSON.stringify(r.errors) : 'none'}.`,
    ...(Object.keys(s.failureReasons).length
      ? [`Session failures: ${JSON.stringify(s.failureReasons)}.`]
      : []),
    '',
    '### Throughput',
    '',
    `${r.throughput.apiRequestsPerSec} API req/s, ${r.throughput.attemptsEvaluatedPerSec} attempts evaluated/s, ${r.throughput.sessionsCompletedPerMin} sessions completed/min.`,
    ...(r.queue
      ? [
          `Attempt queue (${r.queue.samples} samples, 1/s): max waiting ${r.queue.maxWaiting}, max active ${r.queue.maxActive}.`,
        ]
      : []),
    '',
  ];
  return lines.join('\n');
}
