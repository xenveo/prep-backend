// Evaluator calibration (SRS 5.5, plan 05-production-ops "Evaluator calibration"): the fixture format,
// the agreement metrics and the markdown report. Pure, so scripts/calibrate.ts only does the I/O.
// Reports carry indexes, ids and scores only, never answer text or notes.
import { z } from 'zod';
import { geminiCostUsd } from '../src/adapters/gemini/gemini.pricing.js';
import { DIMENSIONS, type Dimension } from '../src/modules/interview/types.js';

/** Target: at least 80% of answers within ±1 level, per dimension, on at least 30 answers per role. */
export const AGREEMENT_TARGET = 0.8;
export const MIN_ITEMS_PER_ROLE = 30;

const level = z.number().int().min(1).max(5);
const levelsSchema = z
  .object({
    content: level,
    structure: level,
    delivery: level,
    relevance: level,
  })
  .strict();
export type Levels = z.infer<typeof levelsSchema>;

export const calibrationItemSchema = z
  .object({
    /** Optional label for the item in reports, e.g. "cs-07". Never answer text. */
    id: z.string().trim().min(1).optional(),
    roleSlug: z.string().trim().min(1),
    questionId: z.uuid().optional(),
    questionText: z.string().trim().min(1).optional(),
    answerText: z.string().trim().min(1),
    mode: z.enum(['typed', 'voice']),
    /** Voice only: measured delivery metrics. Without them, delivery is scored from the text. */
    delivery: z
      .object({
        wpm: z.number().positive(),
        fillerCount: z.number().int().min(0),
        pauseCount: z.number().int().min(0).nullable(),
        longestPauseS: z.number().min(0).nullable(),
        durationS: z.number().positive(),
      })
      .optional(),
    humanScores: levelsSchema,
    notes: z.string().optional(),
  })
  .refine(
    (i) => (i.questionId === undefined) !== (i.questionText === undefined),
    {
      message: 'give exactly one of questionId or questionText',
    },
  )
  .refine((i) => i.mode === 'voice' || i.delivery === undefined, {
    message: 'delivery metrics are for voice answers only',
    path: ['delivery'],
  });
export type CalibrationItem = z.infer<typeof calibrationItemSchema>;

/** A bare array of items, or `{description, items}` to label the set. */
export const calibrationFixtureSchema = z
  .union([
    z.array(calibrationItemSchema).min(1),
    z.object({
      description: z.string().optional(),
      items: z.array(calibrationItemSchema).min(1),
    }),
  ])
  .transform((f) => (Array.isArray(f) ? { items: f } : f));
export type CalibrationFixture = z.output<typeof calibrationFixtureSchema>;

export type ItemResult = {
  index: number;
  id: string | null;
  roleSlug: string;
  questionId: string;
  mode: 'typed' | 'voice';
  human: Levels;
  /** Null when the evaluator failed for this item. */
  model: Levels | null;
  promptVersion: number | null;
  error: string | null;
};

/** Counts of (model − human): ≤ −2, −1, 0, +1, ≥ +2. */
export type DiffBuckets = [number, number, number, number, number];

export type DimensionStats = {
  n: number;
  exact: number;
  within1: number;
  mae: number;
  /** Mean (model − human): positive means the model scores higher than people. */
  bias: number;
  diffs: DiffBuckets;
  /** confusion[human − 1][model − 1] */
  confusion: number[][];
};

export type GroupStats = {
  n: number;
  dimensions: Record<Dimension, DimensionStats>;
  /** Every dimension at or above the target within ±1. */
  agreementMet: boolean;
};

export type CalibrationReport = {
  scored: number;
  failed: number;
  overall: GroupStats;
  roles: Record<string, GroupStats>;
  /** Every role has at least MIN_ITEMS_PER_ROLE scored answers. */
  sampleSufficient: boolean;
  /** Sample sufficient and agreement met for every role. */
  pass: boolean;
};

function dimensionStats(pairs: [number, number][]): DimensionStats {
  const confusion = Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]);
  const diffs: DiffBuckets = [0, 0, 0, 0, 0];
  let exact = 0;
  let within1 = 0;
  let absSum = 0;
  let sum = 0;
  for (const [human, model] of pairs) {
    const d = model - human;
    confusion[human - 1][model - 1]++;
    diffs[Math.max(-2, Math.min(2, d)) + 2]++;
    if (d === 0) exact++;
    if (Math.abs(d) <= 1) within1++;
    absSum += Math.abs(d);
    sum += d;
  }
  const n = pairs.length;
  const ratio = (x: number) => (n === 0 ? 0 : x / n);
  return {
    n,
    exact: ratio(exact),
    within1: ratio(within1),
    mae: ratio(absSum),
    bias: ratio(sum),
    diffs,
    confusion,
  };
}

function groupStats(results: ItemResult[]): GroupStats {
  const scored = results.filter((r) => r.model !== null);
  const dimensions = Object.fromEntries(
    DIMENSIONS.map((d) => [
      d,
      dimensionStats(scored.map((r) => [r.human[d], r.model![d]])),
    ]),
  ) as Record<Dimension, DimensionStats>;
  return {
    n: scored.length,
    dimensions,
    agreementMet:
      scored.length > 0 &&
      DIMENSIONS.every((d) => dimensions[d].within1 >= AGREEMENT_TARGET),
  };
}

export function summarise(results: ItemResult[]): CalibrationReport {
  const slugs = [...new Set(results.map((r) => r.roleSlug))].sort();
  const roles = Object.fromEntries(
    slugs.map((s) => [s, groupStats(results.filter((r) => r.roleSlug === s))]),
  );
  const sampleSufficient = Object.values(roles).every(
    (g) => g.n >= MIN_ITEMS_PER_ROLE,
  );
  const overall = groupStats(results);
  return {
    scored: overall.n,
    failed: results.length - overall.n,
    overall,
    roles,
    sampleSufficient,
    pass: sampleSufficient && Object.values(roles).every((g) => g.agreementMet),
  };
}

/** Output tokens one evaluator call 1 is budgeted at (JSON plus low thinking; ~300 seen, 520 max). */
const EST_OUTPUT_TOKENS = 700;

/** Rough cost of one call from its prompt length (~4 characters a token). Null for unpriced models. */
export function estimateCallUsd(
  model: string,
  inputChars: number,
): number | null {
  return geminiCostUsd(model, Math.ceil(inputChars / 4), EST_OUTPUT_TOKENS);
}

export type RunInfo = {
  fixture: string;
  description?: string;
  provider: string;
  evaluatorPrompt: {
    version: number;
    model: string;
    temperature: number;
    thinkingLevel: string | null;
  };
  promptVersionsSeen: number[];
  /** Items selected after --limit. */
  selected: number;
  limit: number | null;
  maxUsd: number;
  estimatedUsd: number | null;
  actualUsd: number;
  calls: number;
  unpricedCalls: number;
  aborted: string | null;
};

const pct = (x: number) => `${Math.round(x * 100)}%`;
const fixed = (x: number) => x.toFixed(2);
const signed = (x: number) => (x > 0 ? '+' : '') + x.toFixed(2);
const usd = (x: number | null) => (x === null ? 'unknown' : `$${x.toFixed(4)}`);
const levels = (l: Levels | null) =>
  l ? DIMENSIONS.map((d) => l[d]).join('/') : '–';
const row = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;
const header = (cells: string[]) =>
  [row(cells), row(cells.map(() => '---'))].join('\n');

export function verdictText(r: CalibrationReport): string {
  if (r.pass) return 'PASS';
  const reasons: string[] = [];
  const short = Object.entries(r.roles)
    .filter(([, g]) => g.n < MIN_ITEMS_PER_ROLE)
    .map(([s, g]) => `${s} ${g.n}`);
  if (short.length)
    reasons.push(
      `fewer than ${MIN_ITEMS_PER_ROLE} scored answers (${short.join(', ')})`,
    );
  const low = Object.entries(r.roles)
    .filter(([, g]) => !g.agreementMet)
    .map(([s]) => s);
  if (low.length)
    reasons.push(
      `within ±1 below ${pct(AGREEMENT_TARGET)} on some dimension (${low.join(', ')})`,
    );
  return `FAIL: ${reasons.join('; ')}`;
}

/** The markdown summary printed on stdout. */
export function renderMarkdown(
  info: RunInfo,
  report: CalibrationReport,
  results: ItemResult[],
): string {
  const p = info.evaluatorPrompt;
  const o = report.overall.dimensions;
  const lines = [
    '# Evaluator calibration',
    '',
    ...(info.description ? [`> ${info.description}`, ''] : []),
    `- Fixture: \`${info.fixture}\`, ${info.selected} items selected${info.limit === null ? '' : ` (--limit ${info.limit})`}, ${report.scored} scored, ${report.failed} failed`,
    `- Evaluator: provider ${info.provider}, prompt version ${p.version} (${p.model}, temperature ${p.temperature}, thinking ${p.thinkingLevel ?? 'default'}); versions seen: ${info.promptVersionsSeen.join(', ') || 'none'}`,
    `- Cost: estimated ${usd(info.estimatedUsd)}, actual ${usd(info.actualUsd)} over ${info.calls} calls${info.unpricedCalls ? ` (${info.unpricedCalls} unpriced)` : ''}, max $${info.maxUsd}`,
    ...(info.aborted ? [`- **Aborted:** ${info.aborted}`] : []),
    `- Target: within ±1 level ≥ ${pct(AGREEMENT_TARGET)} on every dimension, ≥ ${MIN_ITEMS_PER_ROLE} answers per role`,
    `- **Verdict: ${verdictText(report)}**`,
    '',
    '## Agreement by dimension (all roles)',
    '',
    header([
      'Dimension',
      'n',
      'Exact',
      'Within ±1',
      'MAE',
      'Bias (model − human)',
    ]),
    ...DIMENSIONS.map((d) =>
      row([
        d,
        o[d].n,
        pct(o[d].exact),
        pct(o[d].within1),
        fixed(o[d].mae),
        signed(o[d].bias),
      ]),
    ),
    '',
    '## Confusion summary (model − human, counts)',
    '',
    header(['Dimension', '≤ −2', '−1', '0', '+1', '≥ +2']),
    ...DIMENSIONS.map((d) => row([d, ...o[d].diffs])),
    '',
    '## Within ±1 by role',
    '',
    header(['Role', 'n', ...DIMENSIONS, 'Meets target']),
    ...Object.entries(report.roles).map(([slug, g]) =>
      row([
        slug,
        g.n,
        ...DIMENSIONS.map((d) => pct(g.dimensions[d].within1)),
        g.agreementMet ? 'yes' : 'no',
      ]),
    ),
    '',
    '## Confusion matrices (rows human 1–5, columns model 1–5)',
    '',
    ...DIMENSIONS.flatMap((d) => [
      `**${d}**`,
      '',
      header(['human \\ model', '1', '2', '3', '4', '5']),
      ...o[d].confusion.map((counts, i) => row([i + 1, ...counts])),
      '',
    ]),
    '## Items (content/structure/delivery/relevance)',
    '',
    header(['#', 'Id', 'Role', 'Question', 'Mode', 'Human', 'Model', 'Status']),
    ...results.map((r) =>
      row([
        r.index,
        r.id ?? '',
        r.roleSlug,
        r.questionId,
        r.mode,
        levels(r.human),
        levels(r.model),
        r.error ?? 'ok',
      ]),
    ),
  ];
  return lines.join('\n') + '\n';
}
