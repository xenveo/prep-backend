-- Data and view only (04-feature-gaps PD1, PD4).

-- PD1: bulk audit actions get one stable key per kind; the count moves into item_label.
-- "Sent N invites" kept the file name or first email as its label: the count is prefixed to it,
-- as InvitesService now writes ("3 invites · march.csv"). The other three already carried
-- "N candidates" in item_label; it is filled in only where empty.
UPDATE "audit_logs"
SET "action" = 'Sent invites',
    "item_label" = CASE
      WHEN "item_label" IN ('', 'Invite') THEN substring("action" FROM '^Sent (\d+ invites?)$')
      ELSE substring("action" FROM '^Sent (\d+ invites?)$') || ' · ' || "item_label"
    END
WHERE "action" ~ '^Sent \d+ invites?$';

UPDATE "audit_logs"
SET "action" = 'Resent invites',
    "item_label" = CASE
      WHEN "item_label" <> '' THEN "item_label"
      WHEN "action" = 'Resent an invite' THEN '1 candidate'
      ELSE substring("action" FROM '^Resent (\d+) invites$') || ' candidates'
    END
WHERE "action" ~ '^Resent (\d+ invites|an invite)$';

UPDATE "audit_logs"
SET "action" = substring("action" FROM '^(\w+) ') || ' candidates',
    "item_label" = CASE
      WHEN "item_label" <> '' THEN "item_label"
      WHEN "action" ~ ' a candidate$' THEN '1 candidate'
      ELSE substring("action" FROM '^\w+ (\d+ candidates)$')
    END
WHERE "action" ~ '^(Deactivated|Reactivated) (\d+ candidates|a candidate)$';

-- PD4: an abandoned session counts toward the limit once it has an attempt. The definition is
-- the init migration's, with only the sessions_used expression changed.
CREATE OR REPLACE VIEW "assignment_stats" AS
SELECT
  ra."id"          AS assignment_id,
  ra."user_id"     AS user_id,
  ra."job_role_id" AS job_role_id,
  COUNT(s."id") FILTER (
    WHERE s."status" IN ('in_progress', 'completed')
       OR (s."status" = 'abandoned' AND EXISTS (SELECT 1 FROM "attempts" a WHERE a."session_id" = s."id"))
  )::int AS sessions_used,
  COUNT(s."id") FILTER (WHERE s."status" = 'completed')::int AS sessions_completed,
  (ARRAY_AGG(s."score" ORDER BY s."number") FILTER (WHERE s."status" = 'completed'))[1] AS baseline_score,
  (ARRAY_AGG(s."score" ORDER BY s."number" DESC) FILTER (WHERE s."status" = 'completed'))[1] AS latest_score,
  (ARRAY_AGG(s."band" ORDER BY s."number" DESC) FILTER (WHERE s."status" = 'completed'))[1] AS latest_band,
  MAX(s."score") FILTER (WHERE s."status" = 'completed') AS best_score,
  (ARRAY_AGG(s."band" ORDER BY s."score" DESC, s."number") FILTER (WHERE s."status" = 'completed'))[1] AS best_band,
  MAX(s."completed_at") AS last_completed_at,
  CASE WHEN COUNT(s."id") FILTER (WHERE s."status" = 'completed') >= 2
    THEN (ARRAY_AGG(s."score" ORDER BY s."number" DESC) FILTER (WHERE s."status" = 'completed'))[1]
       - (ARRAY_AGG(s."score" ORDER BY s."number") FILTER (WHERE s."status" = 'completed'))[1]
  END AS change
FROM "role_assignments" ra
JOIN "users" u ON u."id" = ra."user_id" AND u."deleted_at" IS NULL
LEFT JOIN "sessions" s
  ON s."user_id" = ra."user_id" AND s."job_role_id" = ra."job_role_id" AND NOT s."is_preview"
GROUP BY ra."id", ra."user_id", ra."job_role_id";
