// Report SQL (plan §7 "Reports"). Every query starts from the same CTEs:
//   cohort   candidates assigned to the role (erased users excluded); with dateBasis=invited, only
//            those with an invite sent in the range
//   done     their completed, scored, non-preview sessions for the role (ever)
//   in_scope the sessions the report covers: `done` completed in the range (dateBasis=completed),
//            or all of `done` (dateBasis=invited)
// Timestamp columns hold UTC wall time, so bounds are passed as ISO strings and converted to UTC.
import { Prisma } from '../../generated/prisma/client.js';
import type { UserStatus } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { DateBasis, QuestionAgg } from './report-rules.js';

export type ReportScope = {
  roleId: string;
  basis: DateBasis;
  start: Date;
  end: Date;
};

const utc = (d: Date) =>
  Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

function scopeCtes(p: ReportScope): Prisma.Sql {
  const inCohort =
    p.basis === 'invited'
      ? Prisma.sql`EXISTS (
          SELECT 1 FROM "invites" i
          WHERE i."user_id" = u."id" AND i."sent_at" >= ${utc(p.start)} AND i."sent_at" < ${utc(p.end)})`
      : Prisma.sql`ra."assigned_at" < ${utc(p.end)}`;
  const inScope =
    p.basis === 'invited'
      ? Prisma.sql`TRUE`
      : Prisma.sql`d."completed_at" >= ${utc(p.start)} AND d."completed_at" < ${utc(p.end)}`;
  return Prisma.sql`
    WITH cohort AS (
      SELECT u."id", u."name", u."email", u."status", u."last_active_at", u."first_login_at",
             (ra."removed_at" IS NULL) AS "assigned"
      FROM "role_assignments" ra
      JOIN "users" u ON u."id" = ra."user_id" AND u."deleted_at" IS NULL AND u."role" = 'candidate'
      WHERE ra."job_role_id" = ${p.roleId}::uuid AND ${inCohort}
    ),
    done AS (
      SELECT s."id", s."user_id", s."number", s."score", s."band", s."completed_at", s."skills"
      FROM "sessions" s
      JOIN cohort c ON c."id" = s."user_id"
      WHERE s."job_role_id" = ${p.roleId}::uuid AND s."status" = 'completed'
        AND NOT s."is_preview" AND s."score" IS NOT NULL
    ),
    in_scope AS (
      SELECT d.* FROM done d WHERE ${inScope}
    )`;
}

export type CohortRow = {
  id: string;
  name: string | null;
  email: string;
  status: UserStatus;
  last_active_at: Date | null;
  first_login_at: Date | null;
  assigned: boolean;
  sessions_total: number;
  baseline_score: number | null;
  sessions_in_scope: number;
  latest_score: number | null;
  latest_band: string | null;
};

/** One row per cohort candidate: baseline (first session ever) and latest (last in scope). */
export function cohortRows(
  prisma: PrismaService,
  p: ReportScope,
): Promise<CohortRow[]> {
  return prisma.$queryRaw<CohortRow[]>`${scopeCtes(p)}
    SELECT c."id"::text, c."name", c."email"::text, c."status"::text, c."last_active_at",
           c."first_login_at", c."assigned",
           COALESCE(dn."total", 0)::int AS "sessions_total", dn."baseline_score",
           COALESCE(sc."n", 0)::int AS "sessions_in_scope", sc."latest_score", sc."latest_band"::text
    FROM cohort c
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS "total", (ARRAY_AGG(d."score" ORDER BY d."number"))[1] AS "baseline_score"
      FROM done d WHERE d."user_id" = c."id"
    ) dn ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS "n",
             (ARRAY_AGG(d."score" ORDER BY d."number" DESC))[1] AS "latest_score",
             (ARRAY_AGG(d."band" ORDER BY d."number" DESC))[1] AS "latest_band"
      FROM in_scope d WHERE d."user_id" = c."id"
    ) sc ON true`;
}

type QuestionSqlRow = {
  question_id: string;
  question: string;
  times_asked: number;
  avg_first: number;
  avg_second: number;
  avg_learning: number | null;
};

/**
 * Per-question averages over the sessions in scope. A skipped retry counts its first try as the
 * second (A2 = A1) and learning 0 (plan §6 "Scoring").
 */
export async function questionAggregates(
  prisma: PrismaService,
  p: ReportScope,
): Promise<QuestionAgg[]> {
  const rows = await prisma.$queryRaw<QuestionSqlRow[]>`${scopeCtes(p)}
    SELECT q."id"::text AS "question_id", q."text" AS "question",
           COUNT(*)::int AS "times_asked",
           AVG(a1."score")::float8 AS "avg_first",
           AVG(COALESCE(a2."score", a1."score"))::float8 AS "avg_second",
           AVG(CASE WHEN sq."retry_skipped" THEN 0 ELSE a2."learning_score" END)::float8 AS "avg_learning"
    FROM in_scope s
    JOIN "session_questions" sq ON sq."session_id" = s."id"
    JOIN "questions" q ON q."id" = sq."question_id"
    JOIN "attempts" a1 ON a1."session_id" = s."id" AND a1."question_id" = sq."question_id"
      AND a1."attempt_no" = 1 AND a1."score" IS NOT NULL
    LEFT JOIN "attempts" a2 ON a2."session_id" = s."id" AND a2."question_id" = sq."question_id"
      AND a2."attempt_no" = 2 AND a2."score" IS NOT NULL
    GROUP BY q."id", q."text"`;
  return rows.map((r) => ({
    questionId: r.question_id,
    question: r.question,
    timesAsked: r.times_asked,
    avgFirst: r.avg_first,
    avgSecond: r.avg_second,
    avgLearning: r.avg_learning,
  }));
}

type DimensionSqlRow = {
  content: number | null;
  structure: number | null;
  delivery: number | null;
  relevance: number | null;
};

/** Mean of each session's `skills` (per-dimension averages) over the sessions in scope. */
export async function dimensionAverages(
  prisma: PrismaService,
  p: ReportScope,
): Promise<DimensionSqlRow> {
  const rows = await prisma.$queryRaw<DimensionSqlRow[]>`${scopeCtes(p)}
    SELECT AVG((s."skills"->>'content')::float8) AS "content",
           AVG((s."skills"->>'structure')::float8) AS "structure",
           AVG((s."skills"->>'delivery')::float8) AS "delivery",
           AVG((s."skills"->>'relevance')::float8) AS "relevance"
    FROM in_scope s
    WHERE s."skills" IS NOT NULL`;
  return rows[0];
}
