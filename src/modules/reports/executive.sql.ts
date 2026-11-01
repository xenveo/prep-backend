import { Prisma } from '../../generated/prisma/client.js';
import type { ExecutivePeriod } from './executive-period.js';

const utc = (d: Date) =>
  Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
export type ExecutiveScope = ExecutivePeriod & {
  roleId?: string;
  recruiterId?: string;
};

/** Shared bounded read model; the earliest invite is selected BEFORE the month filter. */
export function executiveCtes(s: ExecutiveScope): Prisma.Sql {
  const role = s.roleId
    ? Prisma.sql`AND m.role_id = ${s.roleId}::uuid`
    : Prisma.empty;
  const recruiter = s.recruiterId
    ? Prisma.sql`AND c.recruiter_id = ${s.recruiterId}`
    : Prisma.empty;
  return Prisma.sql`WITH recruiters AS (
    SELECT u.id, COALESCE(NULLIF(TRIM(u.name), ''), u.email::text) AS name
    FROM users u WHERE u.deleted_at IS NULL AND u.created_at < ${utc(s.cutoff)}
      AND (u.role IN ('admin', 'super_admin') OR (u.role = 'candidate' AND u.admin_role IN ('admin', 'super_admin')))
  ), first_invites AS (
    SELECT DISTINCT ON (i.user_id) i.user_id, i.invited_by, i.sent_at
    FROM invites i JOIN users u ON u.id = i.user_id AND u.role = 'candidate' AND u.deleted_at IS NULL
    ORDER BY i.user_id, i.sent_at, i.id
  ), eligible AS (
    SELECT u.id, COALESCE(NULLIF(TRIM(u.name), ''), u.email::text) AS name,
      i.sent_at, COALESCE(r.id::text, 'unknown') AS recruiter_id,
      (i.sent_at + INTERVAL '7 days' <= ${utc(s.cutoff)}) AS matured,
      (u.first_login_at >= i.sent_at AND u.first_login_at <= i.sent_at + INTERVAL '7 days'
       AND u.first_login_at < ${utc(s.cutoff)}) IS TRUE AS accepted
    FROM first_invites i JOIN users u ON u.id = i.user_id
    LEFT JOIN recruiters r ON r.id = i.invited_by
    WHERE i.sent_at >= ${utc(s.cohortStart)} AND i.sent_at < ${utc(s.cohortEnd)}
  ), memberships AS (
    SELECT ra.user_id, ra.job_role_id AS role_id FROM role_assignments ra JOIN eligible e ON e.id = ra.user_id
    WHERE ra.assigned_at < ${utc(s.cutoff)}
    UNION
    SELECT se.user_id, se.job_role_id FROM sessions se JOIN eligible e ON e.id = se.user_id
    WHERE NOT se.is_preview AND se.started_at < ${utc(s.cutoff)}
  ), cohort AS (
    SELECT c.* FROM eligible c WHERE TRUE ${recruiter}
      ${s.roleId ? Prisma.sql`AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = c.id AND m.role_id = ${s.roleId}::uuid)` : Prisma.empty}
  ), done AS (
    SELECT se.id, se.user_id, se.job_role_id, se.score, se.completed_at
    FROM sessions se JOIN cohort c ON c.id = se.user_id
    WHERE se.status = 'completed' AND NOT se.is_preview AND se.score IS NOT NULL
      AND se.completed_at < ${utc(s.cutoff)}
      ${s.roleId ? Prisma.sql`AND se.job_role_id = ${s.roleId}::uuid` : Prisma.empty}
  ), pair_scores AS (
    SELECT user_id, job_role_id, COUNT(*)::int AS sessions,
      (ARRAY_AGG(score ORDER BY completed_at, id))[1] AS first_score,
      (ARRAY_AGG(score ORDER BY completed_at DESC, id DESC))[1] AS latest_score
    FROM done GROUP BY user_id, job_role_id
  ), pairs AS (
    SELECT c.id::text || ':' || m.role_id::text AS id, c.id AS candidate_id, c.name, c.recruiter_id,
      c.accepted, m.role_id, COALESCE(p.sessions, 0)::int AS sessions, p.first_score,
      CASE WHEN p.sessions >= 2 THEN p.latest_score ELSE NULL END AS latest_score
    FROM cohort c JOIN memberships m ON m.user_id = c.id ${role}
    LEFT JOIN pair_scores p ON p.user_id = c.id AND p.job_role_id = m.role_id
  )`;
}
export type SummaryRow = {
  recruiter_id: string | null;
  role_id?: string;
  invited: number;
  acceptance_num: number;
  acceptance_den: number;
  awaiting: number;
  assignment_pairs: number;
  unassigned: number;
  paired: number;
  first: number | null;
  latest: number | null;
  gain: number | null;
  improved: number;
  unchanged: number;
  declined: number;
  single_session: number;
  unassessed: number;
};
const fields = Prisma.sql`
  COUNT(DISTINCT c.id)::int AS invited,
  COUNT(DISTINCT c.id) FILTER (WHERE c.matured AND c.accepted)::int AS acceptance_num,
  COUNT(DISTINCT c.id) FILTER (WHERE c.matured)::int AS acceptance_den,
  COUNT(DISTINCT c.id) FILTER (WHERE NOT c.matured)::int AS awaiting,
  COUNT(p.id)::int AS assignment_pairs,
  COUNT(DISTINCT c.id) FILTER (WHERE p.id IS NULL)::int AS unassigned,
  COUNT(p.id) FILTER (WHERE p.sessions >= 2)::int AS paired,
  AVG(p.first_score) FILTER (WHERE p.sessions >= 2)::float8 AS first,
  AVG(p.latest_score) FILTER (WHERE p.sessions >= 2)::float8 AS latest,
  AVG(p.latest_score - p.first_score) FILTER (WHERE p.sessions >= 2)::float8 AS gain,
  COUNT(p.id) FILTER (WHERE p.sessions >= 2 AND p.latest_score > p.first_score)::int AS improved,
  COUNT(p.id) FILTER (WHERE p.sessions >= 2 AND p.latest_score = p.first_score)::int AS unchanged,
  COUNT(p.id) FILTER (WHERE p.sessions >= 2 AND p.latest_score < p.first_score)::int AS declined,
  COUNT(p.id) FILTER (WHERE p.sessions = 1)::int AS single_session,
  COUNT(p.id) FILTER (WHERE p.sessions = 0)::int AS unassessed`;
export function summarySql(s: ExecutiveScope): Prisma.Sql {
  return Prisma.sql`${executiveCtes(s)} SELECT c.recruiter_id, ${fields}
    FROM cohort c LEFT JOIN pairs p ON p.candidate_id = c.id
    GROUP BY GROUPING SETS ((c.recruiter_id), ())`;
}
export function roleSummarySql(s: ExecutiveScope): Prisma.Sql {
  return Prisma.sql`${executiveCtes(s)} SELECT p.role_id::text, NULL::text AS recruiter_id, ${fields}
    FROM cohort c JOIN pairs p ON p.candidate_id = c.id GROUP BY p.role_id`;
}
export function pageSql(
  s: ExecutiveScope,
  search: string | undefined,
  page: number,
  pageSize: number,
): Prisma.Sql {
  // SQL wildcards are escaped so search is literal, and the value remains parameterized.
  const term = `%${(search ?? '').replace(/[\\%_]/g, '\\$&')}%`;
  const where = Prisma.sql`WHERE (p.name ILIKE ${term} OR p.candidate_id::text ILIKE ${term} OR p.id ILIKE ${term})`;
  return Prisma.sql`${executiveCtes(s)}, filtered AS (SELECT p.* FROM pairs p ${where}),
    page AS (SELECT * FROM filtered ORDER BY lower(name), candidate_id, role_id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize})
    SELECT (SELECT COUNT(*)::int FROM filtered) AS total,
      COALESCE((SELECT json_agg(page ORDER BY lower(name), candidate_id, role_id) FROM page), '[]'::json) AS rows`;
}
