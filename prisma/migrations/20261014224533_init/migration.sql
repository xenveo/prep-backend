-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('candidate', 'admin', 'super_admin');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('invite_pending', 'active', 'deactivated', 'revoked');

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('pending', 'accepted', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "RoleStatus" AS ENUM ('draft', 'approved', 'archived');

-- CreateEnum
CREATE TYPE "Seniority" AS ENUM ('entry', 'junior', 'mid', 'senior');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('ai_draft', 'approved', 'archived');

-- CreateEnum
CREATE TYPE "CardCategory" AS ENUM ('behavioural', 'situational', 'role_knowledge', 'motivation');

-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('easy', 'medium', 'hard');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('in_progress', 'completed', 'abandoned', 'failed');

-- CreateEnum
CREATE TYPE "AnswerMode" AS ENUM ('voice', 'typed');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('received', 'transcribing', 'evaluating', 'done', 'failed');

-- CreateEnum
CREATE TYPE "Band" AS ENUM ('not_ready', 'developing', 'nearly_ready', 'interview_ready');

-- CreateEnum
CREATE TYPE "FlagStatus" AS ENUM ('open', 'resolved');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "name" TEXT,
    "title" TEXT,
    "role" "UserRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'invite_pending',
    "access_expires_at" TIMESTAMP(3),
    "first_login_at" TIMESTAMP(3),
    "last_active_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "invited_by" UUID,
    "batch_id" UUID,
    "token_hash" TEXT NOT NULL,
    "status" "InviteStatus" NOT NULL DEFAULT 'pending',
    "sent_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite_batches" (
    "id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "file_name" TEXT,
    "sent" INTEGER NOT NULL,
    "skipped" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_codes" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "tries" INTEGER NOT NULL DEFAULT 0,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_roles" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "blurb" TEXT NOT NULL DEFAULT '',
    "description_html" TEXT NOT NULL DEFAULT '',
    "seniority" "Seniority" NOT NULL,
    "key_skills" TEXT[],
    "status" "RoleStatus" NOT NULL DEFAULT 'draft',
    "settings" JSONB NOT NULL,
    "approved_at" TIMESTAMP(3),
    "approved_by" UUID,
    "last_ai_draft_at" TIMESTAMP(3),
    "updated_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_assignments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "job_role_id" UUID NOT NULL,
    "assigned_by" UUID,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "max_attempts" INTEGER,
    "removed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flash_cards" (
    "id" UUID NOT NULL,
    "job_role_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "category" "CardCategory" NOT NULL,
    "question" TEXT NOT NULL,
    "strong_answer_points" TEXT[],
    "sample_answer_outline" TEXT,
    "common_mistakes" TEXT[],
    "tip" VARCHAR(90) NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'approved',
    "created_by" UUID,
    "approved_by" UUID,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flash_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_views" (
    "user_id" UUID NOT NULL,
    "flash_card_id" UUID NOT NULL,
    "viewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_views_pkey" PRIMARY KEY ("user_id","flash_card_id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" UUID NOT NULL,
    "job_role_id" UUID NOT NULL,
    "flash_card_id" UUID,
    "text" TEXT NOT NULL,
    "category" "CardCategory" NOT NULL,
    "difficulty" "Difficulty" NOT NULL,
    "rubric" JSONB NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'approved',
    "sample_evaluation" JSONB,
    "audio_key" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "job_role_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'in_progress',
    "mode" "AnswerMode" NOT NULL,
    "is_preview" BOOLEAN NOT NULL DEFAULT false,
    "current_question" INTEGER NOT NULL DEFAULT 1,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "duration_s" INTEGER,
    "first_try_avg" DOUBLE PRECISION,
    "retry_avg" DOUBLE PRECISION,
    "learning_avg" DOUBLE PRECISION,
    "score" INTEGER,
    "band" "Band",
    "skills" JSONB,
    "strengths" JSONB,
    "focus_areas" JSONB,
    "band_message" TEXT,
    "weights_snapshot" JSONB NOT NULL,
    "prompt_versions" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_questions" (
    "session_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "retry_skipped" BOOLEAN NOT NULL DEFAULT false,
    "follow_up_text" TEXT,

    CONSTRAINT "session_questions_pkey" PRIMARY KEY ("session_id","position")
);

-- CreateTable
CREATE TABLE "attempts" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "mode" "AnswerMode" NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'received',
    "idempotency_key" TEXT NOT NULL,
    "transcript" TEXT,
    "words" JSONB,
    "audio_key" TEXT,
    "audio_expires_at" TIMESTAMP(3),
    "duration_s" DOUBLE PRECISION,
    "wpm" DOUBLE PRECISION,
    "filler_count" INTEGER,
    "pause_count" INTEGER,
    "longest_pause_s" DOUBLE PRECISION,
    "dimension_scores" JSONB,
    "score" INTEGER,
    "learning_score" INTEGER,
    "feedback" JSONB,
    "feedback_text" TEXT,
    "feedback_audio_key" TEXT,
    "evidence" JSONB,
    "error" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "text_version" TEXT NOT NULL,
    "given_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluation_flags" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "question_id" UUID,
    "question_number" INTEGER NOT NULL,
    "dimension" TEXT NOT NULL,
    "issue" TEXT NOT NULL,
    "note" TEXT,
    "status" "FlagStatus" NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "evaluation_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_filters" (
    "id" UUID NOT NULL,
    "admin_id" UUID,
    "label" TEXT NOT NULL,
    "query" JSONB NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_filters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_events" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "item_label" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "data" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_versions" (
    "id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "temperature" DOUBLE PRECISION NOT NULL,
    "template" TEXT NOT NULL,
    "output_schema" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_call_logs" (
    "id" UUID NOT NULL,
    "session_id" UUID,
    "attempt_id" UUID,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "prompt_role" TEXT,
    "prompt_version" INTEGER,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "audio_seconds" DOUBLE PRECISION,
    "latency_ms" INTEGER NOT NULL,
    "cost_usd" DECIMAL(10,5),
    "status" TEXT NOT NULL,
    "error" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_jobs" (
    "id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "subject_id" UUID,
    "file_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "privacy_requests" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "completed_by" UUID,

    CONSTRAINT "privacy_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "erasure_receipts" (
    "id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "email_sha256" TEXT NOT NULL,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL,
    "hidden_at" TIMESTAMP(3) NOT NULL,
    "purge_after" TIMESTAMP(3) NOT NULL,
    "purged_at" TIMESTAMP(3),
    "s3_objects_deleted" INTEGER,

    CONSTRAINT "erasure_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "invites_token_hash_key" ON "invites"("token_hash");

-- CreateIndex
CREATE INDEX "invites_user_id_idx" ON "invites"("user_id");

-- CreateIndex
CREATE INDEX "auth_codes_email_created_at_idx" ON "auth_codes"("email", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_token_hash_key" ON "auth_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_roles_slug_key" ON "job_roles"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "role_assignments_user_id_job_role_id_key" ON "role_assignments"("user_id", "job_role_id");

-- CreateIndex
CREATE UNIQUE INDEX "flash_cards_job_role_id_position_key" ON "flash_cards"("job_role_id", "position");

-- CreateIndex
CREATE INDEX "questions_job_role_id_idx" ON "questions"("job_role_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_user_id_job_role_id_number_key" ON "sessions"("user_id", "job_role_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "session_questions_session_id_question_id_key" ON "session_questions"("session_id", "question_id");

-- CreateIndex
CREATE INDEX "attempts_audio_expires_at_idx" ON "attempts"("audio_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "attempts_session_id_question_id_attempt_no_key" ON "attempts"("session_id", "question_id", "attempt_no");

-- CreateIndex
CREATE UNIQUE INDEX "attempts_session_id_idempotency_key_key" ON "attempts"("session_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "evaluation_flags_session_id_idx" ON "evaluation_flags"("session_id");

-- CreateIndex
CREATE INDEX "activity_events_user_id_at_idx" ON "activity_events"("user_id", "at");

-- CreateIndex
CREATE INDEX "audit_logs_at_idx" ON "audit_logs"("at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_entity_id_idx" ON "audit_logs"("entity", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_versions_role_version_key" ON "prompt_versions"("role", "version");

-- CreateIndex
CREATE INDEX "ai_call_logs_session_id_idx" ON "ai_call_logs"("session_id");

-- CreateIndex
CREATE INDEX "erasure_receipts_purge_after_idx" ON "erasure_receipts"("purge_after");

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "invite_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_job_role_id_fkey" FOREIGN KEY ("job_role_id") REFERENCES "job_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flash_cards" ADD CONSTRAINT "flash_cards_job_role_id_fkey" FOREIGN KEY ("job_role_id") REFERENCES "job_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_views" ADD CONSTRAINT "card_views_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_views" ADD CONSTRAINT "card_views_flash_card_id_fkey" FOREIGN KEY ("flash_card_id") REFERENCES "flash_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_job_role_id_fkey" FOREIGN KEY ("job_role_id") REFERENCES "job_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_flash_card_id_fkey" FOREIGN KEY ("flash_card_id") REFERENCES "flash_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_job_role_id_fkey" FOREIGN KEY ("job_role_id") REFERENCES "job_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_questions" ADD CONSTRAINT "session_questions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_questions" ADD CONSTRAINT "session_questions_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_flags" ADD CONSTRAINT "evaluation_flags_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_filters" ADD CONSTRAINT "saved_filters_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_call_logs" ADD CONSTRAINT "ai_call_logs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_call_logs" ADD CONSTRAINT "ai_call_logs_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Raw SQL (BACKEND_IMPLEMENTATION.md §4)
-- ---------------------------------------------------------------------------

-- One in-progress session per (user, role).
CREATE UNIQUE INDEX "sessions_one_in_progress" ON "sessions" ("user_id", "job_role_id") WHERE "status" = 'in_progress';

-- Per-assignment stats. Excludes preview sessions and erased users (stage 1).
-- sessions_used counts in-progress and completed sessions (the attempt limit).
-- change = latest - baseline, null with fewer than 2 completed sessions.
CREATE VIEW "assignment_stats" AS
SELECT
  ra."id"          AS assignment_id,
  ra."user_id"     AS user_id,
  ra."job_role_id" AS job_role_id,
  COUNT(s."id") FILTER (WHERE s."status" IN ('in_progress', 'completed'))::int AS sessions_used,
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
