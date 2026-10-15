// Read-only aggregate over sessions/attempts for the admin question bank (spec: "Adds timesAsked,
// avgFirstTry, avgSecondTry and avgLearning from completed sessions"). Raw SQL is not erasure-filtered,
// so it joins `users` on deleted_at IS NULL and skips preview sessions itself.
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { QuestionStats } from './content.serializers.js';

type Row = {
  question_id: string;
  times_asked: number;
  avg_first: number | null;
  avg_second: number | null;
  avg_learning: number | null;
};

/** Stats per question id for one role. Questions never asked are absent. A skipped retry counts as learning 0. */
export async function questionStats(
  prisma: PrismaService,
  jobRoleId: string,
): Promise<Map<string, QuestionStats>> {
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT sq."question_id"::text AS question_id,
           COUNT(*)::int AS times_asked,
           ROUND(AVG(a1."score"))::int AS avg_first,
           ROUND(AVG(a2."score") FILTER (WHERE NOT sq."retry_skipped"))::int AS avg_second,
           ROUND(AVG(CASE WHEN sq."retry_skipped" THEN 0 ELSE a2."learning_score" END))::int AS avg_learning
    FROM "session_questions" sq
    JOIN "sessions" s
      ON s."id" = sq."session_id" AND s."status" = 'completed' AND NOT s."is_preview"
    JOIN "users" u ON u."id" = s."user_id" AND u."deleted_at" IS NULL
    LEFT JOIN "attempts" a1
      ON a1."session_id" = sq."session_id" AND a1."question_id" = sq."question_id"
     AND a1."attempt_no" = 1 AND a1."status" = 'done'
    LEFT JOIN "attempts" a2
      ON a2."session_id" = sq."session_id" AND a2."question_id" = sq."question_id"
     AND a2."attempt_no" = 2 AND a2."status" = 'done'
    WHERE s."job_role_id" = ${jobRoleId}::uuid
    GROUP BY sq."question_id"`;
  return new Map(
    rows.map((r) => [
      r.question_id,
      {
        timesAsked: Number(r.times_asked),
        avgFirstTry: r.avg_first === null ? null : Number(r.avg_first),
        avgSecondTry: r.avg_second === null ? null : Number(r.avg_second),
        avgLearning: r.avg_learning === null ? null : Number(r.avg_learning),
      },
    ]),
  );
}

type AvgRow = { job_role_id: string; avg_latest: number | null };

/** Average latest score per role over live (not removed) assignments with a completed session. */
export async function avgLatestScores(
  prisma: PrismaService,
  jobRoleIds: string[],
): Promise<Map<string, number>> {
  if (jobRoleIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<AvgRow[]>`
    SELECT st.job_role_id::text AS job_role_id, ROUND(AVG(st.latest_score))::int AS avg_latest
    FROM "assignment_stats" st
    JOIN "role_assignments" ra ON ra."id" = st.assignment_id AND ra."removed_at" IS NULL
    WHERE st.latest_score IS NOT NULL AND st.job_role_id = ANY(${jobRoleIds}::uuid[])
    GROUP BY st.job_role_id`;
  const out = new Map<string, number>();
  for (const r of rows)
    if (r.avg_latest !== null) out.set(r.job_role_id, Number(r.avg_latest));
  return out;
}
