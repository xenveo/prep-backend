// AI usage and cost for Super admins (plan 04 "F1 · Cost per session", NFR-10).
// A call belongs to the session it names, or else to its attempt's session. Calls of preview
// sessions and of erased users are left out everywhere; calls without a session (admin drafting,
// test evaluation, voice samples) count in the totals unless a role is selected.
// Timestamp columns hold UTC wall time, so bounds are passed as ISO strings and converted to UTC.
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/** NFR-10: target AI cost per completed session. A constant for R1, not workspace config yet. */
export const SESSION_BUDGET_USD = 0.5;
export const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;

const dayStart = (date: string) => new Date(`${date}T00:00:00.000Z`);

/** GET /admin/ai-usage: inclusive UTC days, at most a year and a day. */
export const aiUsageQuerySchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    roleId: z.uuid().optional(),
  })
  .refine((q) => q.from <= q.to, {
    message: 'from must not be after to',
    path: ['from'],
  })
  .refine(
    (q) =>
      (dayStart(q.to).getTime() - dayStart(q.from).getTime()) / DAY_MS + 1 <=
      MAX_RANGE_DAYS,
    { message: `Range is longer than ${MAX_RANGE_DAYS} days`, path: ['to'] },
  );

export type AiUsageQuery = z.infer<typeof aiUsageQuerySchema>;

export const AI_CALL_KINDS = ['llm', 'stt', 'tts'] as const;
type AiCallKind = (typeof AI_CALL_KINDS)[number];

export type AiUsage = {
  range: { from: string; to: string };
  budgetUsd: number;
  totals: {
    calls: number;
    costUsd: number;
    unpricedCalls: number;
    failedCalls: number;
    byKind: { kind: AiCallKind; calls: number; costUsd: number }[];
    byModel: { model: string | null; calls: number; costUsd: number }[];
  };
  perSession: {
    completedSessions: number;
    avgCostUsd: number | null;
    p90CostUsd: number | null;
    overBudget: number;
    unpricedSessions: number;
  };
  daily: { date: string; calls: number; costUsd: number }[];
};

/** Calls grouped by (kind, model, UTC day). */
export type CallAggRow = {
  kind: string;
  model: string | null;
  day: string;
  calls: number;
  cost_usd: number;
  unpriced: number;
  failed: number;
};

/** Total cost of each in-scope completed session, and how many of its calls were priced (> 0). */
export type SessionCostRow = {
  session_id: string;
  cost_usd: number;
  priced_calls: number;
};

const utc = (d: Date) =>
  Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Nearest-rank percentile of an ascending list: the value at rank ceil(p/100 * n). */
export function nearestRank(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

@Injectable()
export class AiUsageService {
  constructor(private readonly prisma: PrismaService) {}

  async get(query: AiUsageQuery): Promise<AiUsage> {
    const start = dayStart(query.from);
    const end = new Date(dayStart(query.to).getTime() + DAY_MS);
    const [calls, sessions] = await Promise.all([
      this.callAggregates(start, end, query.roleId),
      this.sessionCosts(start, end, query.roleId),
    ]);
    return buildAiUsage(query, calls, sessions);
  }

  /** Calls made in [start, end), excluding preview and erased-user sessions. */
  private callAggregates(
    start: Date,
    end: Date,
    roleId: string | undefined,
  ): Promise<CallAggRow[]> {
    const role = roleId
      ? Prisma.sql`AND s."job_role_id" = ${roleId}::uuid`
      : Prisma.empty;
    return this.prisma.$queryRaw<CallAggRow[]>`
      SELECT l."kind", l."model", to_char(l."at", 'YYYY-MM-DD') AS "day",
             COUNT(*)::int AS "calls",
             COALESCE(SUM(l."cost_usd"), 0)::float8 AS "cost_usd",
             COUNT(*) FILTER (WHERE l."cost_usd" IS NULL)::int AS "unpriced",
             COUNT(*) FILTER (WHERE l."status" <> 'ok')::int AS "failed"
      FROM "ai_call_logs" l
      LEFT JOIN "attempts" a ON a."id" = l."attempt_id" AND l."session_id" IS NULL
      LEFT JOIN "sessions" s ON s."id" = COALESCE(l."session_id", a."session_id")
      LEFT JOIN "users" u ON u."id" = s."user_id"
      WHERE l."at" >= ${utc(start)} AND l."at" < ${utc(end)}
        AND (s."id" IS NULL OR (NOT s."is_preview" AND u."deleted_at" IS NULL))
        ${role}
      GROUP BY 1, 2, 3`;
  }

  /**
   * Completed, non-preview sessions of non-erased users, completed in [start, end), with their cost
   * over every linked call (whenever made). The two branches are disjoint, so no call counts twice.
   * Sessions with no logged call are left out.
   */
  private sessionCosts(
    start: Date,
    end: Date,
    roleId: string | undefined,
  ): Promise<SessionCostRow[]> {
    const role = roleId
      ? Prisma.sql`AND s."job_role_id" = ${roleId}::uuid`
      : Prisma.empty;
    return this.prisma.$queryRaw<SessionCostRow[]>`
      WITH in_scope AS (
        SELECT s."id"
        FROM "sessions" s
        JOIN "users" u ON u."id" = s."user_id" AND u."deleted_at" IS NULL
        WHERE s."status" = 'completed' AND NOT s."is_preview"
          AND s."completed_at" >= ${utc(start)} AND s."completed_at" < ${utc(end)}
          ${role}
      ),
      linked AS (
        SELECT l."session_id" AS "sid", l."cost_usd"
        FROM "ai_call_logs" l JOIN in_scope i ON i."id" = l."session_id"
        UNION ALL
        SELECT a."session_id", l."cost_usd"
        FROM "ai_call_logs" l
        JOIN "attempts" a ON a."id" = l."attempt_id"
        JOIN in_scope i ON i."id" = a."session_id"
        WHERE l."session_id" IS NULL
      )
      SELECT "sid"::text AS "session_id", COALESCE(SUM("cost_usd"), 0)::float8 AS "cost_usd",
             COUNT(*) FILTER (WHERE "cost_usd" > 0)::int AS "priced_calls"
      FROM linked
      GROUP BY "sid"`;
  }
}

/** Shapes the SQL rows into the response: zero-filled kinds and days, costs rounded to 4 dp. */
export function buildAiUsage(
  range: { from: string; to: string },
  calls: readonly CallAggRow[],
  sessions: readonly SessionCostRow[],
): AiUsage {
  const byKind = new Map<string, { calls: number; cost: number }>(
    AI_CALL_KINDS.map((k) => [k, { calls: 0, cost: 0 }]),
  );
  const byModel = new Map<string | null, { calls: number; cost: number }>();
  const byDay = new Map<string, { calls: number; cost: number }>();
  const totals = { calls: 0, cost: 0, unpriced: 0, failed: 0 };
  const add = <K>(
    map: Map<K, { calls: number; cost: number }>,
    key: K,
    r: CallAggRow,
  ) => {
    const acc = map.get(key) ?? { calls: 0, cost: 0 };
    acc.calls += r.calls;
    acc.cost += r.cost_usd;
    map.set(key, acc);
  };
  for (const r of calls) {
    totals.calls += r.calls;
    totals.cost += r.cost_usd;
    totals.unpriced += r.unpriced;
    totals.failed += r.failed;
    if (byKind.has(r.kind)) add(byKind, r.kind, r);
    add(byModel, r.model, r);
    add(byDay, r.day, r);
  }

  const daily: AiUsage['daily'] = [];
  const last = dayStart(range.to).getTime();
  for (let t = dayStart(range.from).getTime(); t <= last; t += DAY_MS) {
    const date = new Date(t).toISOString().slice(0, 10);
    const d = byDay.get(date);
    daily.push({ date, calls: d?.calls ?? 0, costUsd: round4(d?.cost ?? 0) });
  }

  // Per-session stats cover sessions with a priced call; an explicit 0 (fake provider) is unpriced.
  const priced = sessions.filter((s) => s.priced_calls > 0);
  const costs = priced.map((s) => s.cost_usd).sort((a, b) => a - b);
  const n = costs.length;
  return {
    range: { from: range.from, to: range.to },
    budgetUsd: SESSION_BUDGET_USD,
    totals: {
      calls: totals.calls,
      costUsd: round4(totals.cost),
      unpricedCalls: totals.unpriced,
      failedCalls: totals.failed,
      byKind: AI_CALL_KINDS.map((kind) => {
        const k = byKind.get(kind)!;
        return { kind, calls: k.calls, costUsd: round4(k.cost) };
      }),
      byModel: [...byModel]
        .map(([model, m]) => ({
          model,
          calls: m.calls,
          costUsd: round4(m.cost),
        }))
        .sort(
          (a, b) =>
            b.costUsd - a.costUsd ||
            b.calls - a.calls ||
            (a.model ?? '').localeCompare(b.model ?? ''),
        ),
    },
    perSession: {
      completedSessions: n,
      avgCostUsd: n ? round4(costs.reduce((s, c) => s + c, 0) / n) : null,
      p90CostUsd: n ? round4(nearestRank(costs, 90)) : null,
      overBudget: costs.filter((c) => c > SESSION_BUDGET_USD).length,
      unpricedSessions: sessions.length - priced.length,
    },
    daily,
  };
}
