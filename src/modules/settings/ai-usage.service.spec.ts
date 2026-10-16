import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import {
  AiUsageService,
  aiUsageQuerySchema,
  nearestRank,
  type CallAggRow,
  type SessionCostRow,
} from './ai-usage.service.js';

const ROLE = '6f1c2b8e-1d2a-4c3b-9a4e-5f6a7b8c9d0e';

const call = (r: Partial<CallAggRow>): CallAggRow => ({
  kind: 'llm',
  model: 'gemini-3.8-flash',
  day: '2026-10-02',
  calls: 1,
  cost_usd: 0,
  unpriced: 0,
  failed: 0,
  ...r,
});

/** Sessions with these costs; a cost of 0 means none of its calls was priced. */
const sessions = (...costs: number[]): SessionCostRow[] =>
  costs.map((cost_usd, i) => ({
    session_id: `s${i}`,
    cost_usd,
    priced_calls: cost_usd > 0 ? 1 : 0,
  }));

function setup(calls: CallAggRow[] = [], costs: SessionCostRow[] = []) {
  const queryRaw = vi
    .fn()
    .mockResolvedValueOnce(calls)
    .mockResolvedValueOnce(costs);
  const service = new AiUsageService({
    $queryRaw: queryRaw,
  } as unknown as PrismaService);
  /** The SQL of the n-th query (0: calls, 1: session costs), whitespace collapsed. */
  const sql = (n: number) => {
    const [strings, ...values] = queryRaw.mock.calls[n] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const q = Prisma.sql(strings, ...values);
    return { text: q.text.replace(/\s+/g, ' '), values: q.values };
  };
  return { service, sql };
}

const get = (service: AiUsageService, q: Record<string, string>) =>
  service.get(aiUsageQuerySchema.parse(q));

describe('aiUsageQuerySchema', () => {
  const ok = (q: Record<string, string>) =>
    aiUsageQuerySchema.safeParse(q).success;

  it('requires from and to as real ISO dates', () => {
    expect(ok({ from: '2026-10-01', to: '2026-10-16' })).toBe(true);
    expect(ok({ to: '2026-10-16' })).toBe(false);
    expect(ok({ from: '2026-10-01' })).toBe(false);
    expect(ok({ from: '16/10/2026', to: '2026-10-16' })).toBe(false);
    expect(ok({ from: '2026-10-01', to: '2026-02-30' })).toBe(false);
  });

  it('rejects from after to', () => {
    expect(ok({ from: '2026-10-02', to: '2026-10-01' })).toBe(false);
    expect(ok({ from: '2026-10-01', to: '2026-10-01' })).toBe(true);
  });

  it('allows at most 366 days, inclusive', () => {
    expect(ok({ from: '2024-01-01', to: '2024-12-31' })).toBe(true); // 366
    expect(ok({ from: '2024-01-01', to: '2025-01-01' })).toBe(false); // 367
  });

  it('accepts an optional uuid roleId only', () => {
    expect(ok({ from: '2026-10-01', to: '2026-10-01', roleId: ROLE })).toBe(
      true,
    );
    expect(ok({ from: '2026-10-01', to: '2026-10-01', roleId: 'x' })).toBe(
      false,
    );
  });
});

describe('nearestRank', () => {
  it('takes the value at rank ceil(p * n)', () => {
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(nearestRank(ten, 90)).toBe(9);
    expect(nearestRank([...ten, 11], 90)).toBe(10);
    expect(nearestRank([4], 90)).toBe(4);
  });
});

describe('AiUsageService', () => {
  it('bounds both queries by whole UTC days, `to` inclusive', async () => {
    const { service, sql } = setup();
    await get(service, { from: '2026-10-01', to: '2026-10-03' });
    for (const n of [0, 1]) {
      expect(sql(n).values).toEqual([
        '2026-10-01T00:00:00.000Z',
        '2026-10-04T00:00:00.000Z',
      ]);
    }
    expect(sql(0).text).toContain(
      'l."at" >= ($1::timestamptz AT TIME ZONE \'UTC\') AND l."at" < ($2::timestamptz',
    );
    expect(sql(1).text).toContain(
      's."completed_at" >= ($1::timestamptz AT TIME ZONE \'UTC\') AND s."completed_at" < ($2::timestamptz',
    );
  });

  it('excludes preview sessions and erased users from totals and per-session', async () => {
    const { service, sql } = setup();
    await get(service, { from: '2026-10-01', to: '2026-10-01' });
    // Calls: session via session_id, else via the attempt; no-session calls stay.
    expect(sql(0).text).toContain(
      'LEFT JOIN "attempts" a ON a."id" = l."attempt_id" AND l."session_id" IS NULL',
    );
    expect(sql(0).text).toContain(
      'LEFT JOIN "sessions" s ON s."id" = COALESCE(l."session_id", a."session_id")',
    );
    expect(sql(0).text).toContain(
      '(s."id" IS NULL OR (NOT s."is_preview" AND u."deleted_at" IS NULL))',
    );
    // Sessions: completed, non-preview, user not erased; disjoint session/attempt branches.
    expect(sql(1).text).toContain(
      'JOIN "users" u ON u."id" = s."user_id" AND u."deleted_at" IS NULL',
    );
    expect(sql(1).text).toContain(
      `s."status" = 'completed' AND NOT s."is_preview"`,
    );
    expect(sql(1).text).toContain('UNION ALL');
    expect(sql(1).text).toContain('WHERE l."session_id" IS NULL');
  });

  it('scopes both queries to the role when roleId is given', async () => {
    const { service, sql } = setup();
    await get(service, { from: '2026-10-01', to: '2026-10-01', roleId: ROLE });
    for (const n of [0, 1]) {
      expect(sql(n).text).toContain('AND s."job_role_id" = $3::uuid');
      expect(sql(n).values[2]).toBe(ROLE);
    }
  });

  it('keeps no-session calls (no role filter) when roleId is absent', async () => {
    const { service, sql } = setup();
    await get(service, { from: '2026-10-01', to: '2026-10-01' });
    for (const n of [0, 1]) {
      expect(sql(n).text).not.toContain('job_role_id');
      expect(sql(n).values).toHaveLength(2);
    }
  });

  it('zero-fills every day in range, ascending', async () => {
    const { service } = setup([
      call({ day: '2026-10-02', calls: 3, cost_usd: 0.012345 }),
      call({ day: '2026-10-02', kind: 'tts', model: null, calls: 2 }),
    ]);
    const res = await get(service, { from: '2026-09-30', to: '2026-10-03' });
    expect(res.daily).toEqual([
      { date: '2026-09-30', calls: 0, costUsd: 0 },
      { date: '2026-10-01', calls: 0, costUsd: 0 },
      { date: '2026-10-02', calls: 5, costUsd: 0.0123 },
      { date: '2026-10-03', calls: 0, costUsd: 0 },
    ]);
  });

  it('totals by kind (all three) and by model, cost desc, with unpriced and failed counts', async () => {
    const { service } = setup([
      call({ kind: 'llm', model: 'a', calls: 4, cost_usd: 0.02, failed: 1 }),
      call({ kind: 'llm', model: 'b', calls: 2, cost_usd: 0.05 }),
      call({ kind: 'stt', model: null, calls: 3, cost_usd: 0, unpriced: 3 }),
      call({ kind: 'llm', model: 'a', day: '2026-10-03', cost_usd: 0.00001 }),
    ]);
    const res = await get(service, { from: '2026-10-01', to: '2026-10-03' });
    expect(res.range).toEqual({ from: '2026-10-01', to: '2026-10-03' });
    expect(res.budgetUsd).toBe(0.5);
    expect(res.totals).toEqual({
      calls: 10,
      costUsd: 0.07,
      unpricedCalls: 3,
      failedCalls: 1,
      byKind: [
        { kind: 'llm', calls: 7, costUsd: 0.07 },
        { kind: 'stt', calls: 3, costUsd: 0 },
        { kind: 'tts', calls: 0, costUsd: 0 },
      ],
      byModel: [
        { model: 'b', calls: 2, costUsd: 0.05 },
        { model: 'a', calls: 5, costUsd: 0.02 },
        { model: null, calls: 3, costUsd: 0 },
      ],
    });
  });

  it('per-session: null stats when no completed sessions', async () => {
    const { service } = setup();
    const res = await get(service, { from: '2026-10-01', to: '2026-10-01' });
    expect(res.perSession).toEqual({
      completedSessions: 0,
      avgCostUsd: null,
      p90CostUsd: null,
      overBudget: 0,
      unpricedSessions: 0,
    });
    expect(res.totals.byKind.map((k) => k.calls)).toEqual([0, 0, 0]);
    expect(res.totals.byModel).toEqual([]);
  });

  it('per-session: average, nearest-rank p90 and over-budget count (strictly above 0.50)', async () => {
    const { service } = setup(
      [],
      sessions(0.6, 0.1, 0.2, 0.3, 0.4, 0.5, 0.05, 0.15, 0.25, 0.500001),
    );
    const res = await get(service, { from: '2026-10-01', to: '2026-10-01' });
    expect(res.perSession).toEqual({
      completedSessions: 10,
      avgCostUsd: 0.305,
      p90CostUsd: 0.5, // sorted rank 9 of 10 is 0.500001 → 0.5 at 4 dp
      overBudget: 2,
      unpricedSessions: 0,
    });
  });

  it('per-session: sessions without a priced call (> 0) are counted apart, not averaged', async () => {
    const { service, sql } = setup([], sessions(0.05436, 0.01778, 0, 0));
    const res = await get(service, { from: '2026-10-01', to: '2026-10-01' });
    expect(sql(1).text).toContain(
      'COUNT(*) FILTER (WHERE "cost_usd" > 0)::int AS "priced_calls"',
    );
    expect(res.perSession).toEqual({
      completedSessions: 2,
      avgCostUsd: 0.0361,
      p90CostUsd: 0.0544,
      overBudget: 0,
      unpricedSessions: 2,
    });
  });

  it('per-session: null stats when every session is unpriced', async () => {
    const { service } = setup([], sessions(0, 0, 0));
    const res = await get(service, { from: '2026-10-01', to: '2026-10-01' });
    expect(res.perSession).toEqual({
      completedSessions: 0,
      avgCostUsd: null,
      p90CostUsd: null,
      overBudget: 0,
      unpricedSessions: 3,
    });
  });
});
