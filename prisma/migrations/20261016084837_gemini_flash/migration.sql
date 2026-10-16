-- AlterTable
ALTER TABLE "attempts" ADD COLUMN     "speaking_s" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "prompt_versions" ADD COLUMN     "thinking_level" TEXT;

-- Data: switch every prompt role to gemini-3.8-flash as a new active version (history and session
-- snapshots keep the old rows). Copies template, temperature and output schema from the active
-- version; thinking is low on the latency-bound roles and medium on the summariser and drafter.
WITH "previous" AS (
    UPDATE "prompt_versions" SET "active" = false
    WHERE "active" AND "role" IN ('interviewer', 'evaluator', 'summariser', 'drafter')
    RETURNING "role", "version", "temperature", "template", "output_schema"
)
INSERT INTO "prompt_versions" ("id", "role", "version", "model", "temperature", "template", "output_schema", "thinking_level", "active")
SELECT DISTINCT ON (p."role")
    gen_random_uuid(),
    p."role",
    (SELECT MAX(v."version") FROM "prompt_versions" v WHERE v."role" = p."role") + 1,
    'gemini-3.8-flash',
    p."temperature",
    p."template",
    p."output_schema",
    CASE WHEN p."role" IN ('evaluator', 'interviewer') THEN 'low' ELSE 'medium' END,
    true
FROM "previous" p
ORDER BY p."role", p."version" DESC;
