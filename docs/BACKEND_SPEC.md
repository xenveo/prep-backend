# PrepPilot Backend Specification

Oct 15, 2026 · exported from the Claude Doc https://claude.ai/code/artifact/087bdc70-db63-405d-9281-8ab62d5e5941 (the live, commentable version)

## Overview and scope

The backend is one web service with REST and WebSocket APIs. It powers two Next.js clients: `prep-candidate-ui` and `prep-admin-ui`. Scope is release 1 of the PrepPilot SRS (Oct 13, 2026). If a UI shows something the SRS leaves out, this spec marks it out of scope or open. It does not add it silently.

**In scope (SRS 1.2):**

- Invite-only, passwordless email login (OTP or magic link) with Candidate, Admin and Super admin roles
- Admin management of users, invites, job roles, flash cards and question banks, with AI-drafted content that admins approve
- Flash-card study with view tracking per candidate
- A voice and text AI mock interview: ask, answer, feedback, re-ask once, compare. 5 questions by default
- Per-attempt dimension scores, a learning score, a session preparedness score (0 to 100) and a readiness band
- Admin reporting, CSV export, flags on AI evaluations, and an audit log

**Out of scope (SRS 10.1):** video or body-language analysis, languages other than English, public sign-up, payments or subscriptions, ATS/HRIS integration, using scores in hiring decisions, and native mobile apps.

**External services, each behind an adapter:** an LLM (interviewer, evaluator, summariser), speech (STT with word timestamps, plus TTS), and transactional email.

## Architecture

Release 1 is one backend service with four modules and a worker pool (SRS 9). Every LLM, speech and email provider sits behind an adapter. Both clients call it directly over HTTPS. The interview room also keeps a WebSocket open for attempt results.

```
Candidate app (Next.js) --HTTPS REST + WebSocket--+
Admin app (Next.js) ------HTTPS REST--------------+
                                                  v
Backend service (one deployable, REST + WebSocket)
  [Auth and users] [Content] [Interview engine*] [Reports and audit]
  [Background workers: Redis queue - attempt pipeline, question TTS, audio purge, exports]
        |                                   |
        v                                   v
Data stores: PostgreSQL, Redis, S3   External services (adapters): LLM, Speech STT+TTS, Email
* the interview engine is the core
```

The interview engine owns the answer pipeline; workers run the slow steps (STT, evaluation, TTS) so API requests stay fast.

| Layer | Choice | Why |
| --- | --- | --- |
| API | Node.js + NestJS, TypeScript | Shares types with both Next.js clients; REST + WebSocket gateway built in. Decided 2026-10-15 |
| Validation and docs | Zod (or class-validator) + OpenAPI generated from the code | The OpenAPI spec generates typed clients, which replace `lib/api.ts` and `src/services/*` |
| Database | PostgreSQL 16 on AWS RDS (ap-south-1), accessed through Prisma ORM with migrations kept in git (decided 2026-10-15) | Relational reporting queries; jsonb for rubrics, feedback and settings |
| Queue and cache | Redis + BullMQ | Attempt pipeline, TTS pre-generation, purge and export jobs; rate-limit counters |
| Object storage | S3-compatible, SSE encryption, lifecycle rule | Audio expires after `audioRetentionDays` |
| LLM | Provider adapter; one config entry per prompt role (interviewer, evaluator, summariser) | Swap models without a deploy (SRS 7.2). The model must be served from an India region |
| Speech | STT with word timestamps (e.g. Deepgram, AssemblyAI); TTS (e.g. ElevenLabs, Azure) | Timestamps drive the wpm, filler and pause metrics. The vendor must process in India; otherwise self-host Whisper in Mumbai |
| Email | Amazon SES, Postmark or SendGrid with SPF and DKIM | Login codes, invites, role-assigned notices |
| Hosting | Clients on Vercel; API and workers on AWS or GCP in India (AWS ap-south-1 Mumbai; backups in ap-south-2 Hyderabad) | Data residency: India only |

## Auth and roles

Login is passwordless with a 6-digit email code. One login flow serves all three roles. The server sets an httpOnly session cookie that expires after 7 days of inactivity (FR-AUTH-01..06). The candidate UI already builds this flow against mocks in `lib/api.ts` and `app/(auth)/actions.ts`. It sets a demo `pp_session` cookie whose value is the raw email, and that cookie must be replaced.

**Code request** — `POST /auth/code {email}` → `{result: "sent" | "rate-limited"}`

- An email that is not invited, or belongs to a deactivated user, still gets `sent`. Nothing is emailed (FR-AUTH-03).
- Rate limit: 5 code requests per email per hour, plus a per-IP limit. A 30 s resend cooldown is enforced on the server, not just in the client. When the limit is hit, return `rate-limited` with `retryAfterSec`. The UI currently says "15 minutes", so align that copy with the real window.
- The code is random, 6 digits, stored only as a hash, valid for 10 minutes and single use. A new request invalidates earlier codes.
- The invite email from FR-ADM-02 carries a magic link to `/login/code?email=…` with the email filled in. It can also carry a signed one-time token: `POST /auth/verify {token}`.

**Verify** — `POST /auth/verify {email, code}` → `{result: "ok" | "wrong" | "expired"}`

- After 5 wrong tries the code is burned and verify returns `expired`. The UI then shows "Send a new code".
- On `ok`: mark a pending invite `accepted`, create a server-side session row, and set cookie `pp_session` (`pp_admin_session` when the request comes from the admin app, so the two apps don't sign each other out). The cookie is opaque, random, `HttpOnly; Secure; SameSite=Lax`, with a 7-day sliding expiry. The row is stored as a hash.

**Session**

- `GET /me` → `{id, email, name, initials, role, accessExpiresAt}`. The UI needs a real `name`; today it parses one from the email.
- `POST /auth/logout` revokes the session.
- Every request checks: the user's status is `active`, `access_expires_at` has not passed, and the session has not been revoked.
- Deactivating a user (FR-ADM-04) deletes all their sessions, so the user is signed out at once.

**Authorisation (FR-AUTH-06, NFR-04)** — every rule is checked on the server, on every route.

| Role | Can do |
| --- | --- |
| Candidate | `/api/*` candidate routes. Only for roles that are assigned to them and Approved, and only their own sessions |
| Admin | Everything under `/api/admin/*` except the Super admin rows below. A test interview runs as a preview session that is excluded from reports |
| Super admin | Everything Admin can do, plus: manage admins, AI settings (models, prompt versions, scoring weights), data retention, and deletion and export requests |

Admins are one team: multiple admins, one department. There is no `org_id`.

## Data model

The data model is the SRS's nine core entities, plus ten supporting tables that the two UIs need. Everything is in PostgreSQL with UUID primary keys and `created_at`/`updated_at` on every table. Audio lives in S3 and is referenced by key. Derived figures the UIs show (counts, averages, baseline, latest, change) are computed in SQL views, not stored. The exception is a per-assignment stats row, refreshed when a session completes.

Erasure (DPDP Act 2023) has two stages:

1. `users.deleted_at` is set when a deletion is requested and approved. Every query, view and report filters on `deleted_at IS NULL`, so the candidate disappears at once.
2. A purge job runs after the grace period and hard-deletes the user. The cascade removes their invites, auth codes, auth sessions, role assignments, card views, sessions, attempts (transcripts, audio keys, feedback), consents, activity events, flags on their sessions and their privacy requests.

After the purge:

- `ai_call_logs` rows that point at their sessions have those ids set to null.
- `audit_logs` rows that name them have `item_label` replaced with "Deleted candidate" and any personal data removed from `before`/`after`.
- One `erasure_receipts` row is kept as proof of erasure: `{id, email_sha256, requested_by, requested_at, purged_at}`.

**SRS core entities** (SRS 6, extended with fields the UIs need)

| Entity | Key fields | Relations |
| --- | --- | --- |
| `users` | email (unique, citext), name, title, role `candidate\|admin\|super_admin`, status `invite_pending\|active\|deactivated\|revoked`, access\_expires\_at, first\_login\_at, last\_active\_at | many role\_assignments, sessions |
| `invites` | email, user\_id, invited\_by, batch\_id, token\_hash, status `pending\|accepted\|revoked\|expired`, sent\_at, expires\_at | belongs to user and inviting admin |
| `job_roles` | title, slug, description\_html, seniority `entry\|junior\|mid\|senior`, key\_skills text\[\], status `draft\|approved\|archived`, settings jsonb (`RoleSettings`: questionsPerSession, questionOrder, answerGuideSeconds, requireAllCards, maxSessionsPerCandidate, sessionWeights, dimensionWeights), approved\_at/by, last\_ai\_draft\_at, updated\_by | many flash\_cards, questions |
| `role_assignments` | user\_id, job\_role\_id, assigned\_by, assigned\_at, max\_attempts (null = no limit), removed\_at | unique (user\_id, job\_role\_id) |
| `flash_cards` | job\_role\_id, position (1-based, contiguous), category `behavioural\|situational\|role_knowledge\|motivation`, question, strong\_answer\_points text\[\], sample\_answer\_outline, common\_mistakes text\[\], tip (≤ 90), status `ai_draft\|approved`, created\_by (admin id or null = AI), approved\_by/at | belongs to job\_role |
| `questions` | job\_role\_id, flash\_card\_id, text, category, difficulty `easy\|medium\|hard`, rubric jsonb `{keyPoints[{id, point, example}], redFlags[], expectedStructure}`, status `ai_draft\|approved\|archived`, sample\_evaluation jsonb | belongs to job\_role and flash\_card |
| `sessions` | user\_id, job\_role\_id, number (per user and role), status `in_progress\|completed\|abandoned\|failed`, mode, is\_preview, current\_question, started\_at, completed\_at, duration\_s, first\_try\_avg, retry\_avg, learning\_avg, score, band, skills jsonb, strengths jsonb `[{text, cardId}]`, focus\_areas jsonb, band\_message, weights\_snapshot jsonb, prompt\_versions jsonb | many session\_questions, attempts |
| `attempts` | session\_id, question\_id, attempt\_no 1\|2, mode, status `received\|transcribing\|evaluating\|done\|failed`, idempotency\_key, transcript, words jsonb (timestamps), audio\_key, audio\_expires\_at, duration\_s, wpm, filler\_count, pause\_count, longest\_pause\_s, dimension\_scores jsonb, score, learning\_score, feedback jsonb (worked, improve, opener, focus, delivery notes, applied\[\], highlights\[\]), feedback\_text, feedback\_audio\_key, evidence jsonb | unique (session\_id, question\_id, attempt\_no) |
| `audit_logs` | actor\_id, action, entity, entity\_id, item\_label, before/after jsonb, ip, at | references users |
| `card_views` | user\_id, flash\_card\_id, viewed\_at | unique (user\_id, flash\_card\_id) |

**Supporting tables**

| Table | Purpose |
| --- | --- |
| `auth_codes` | email, code\_hash, expires\_at, attempts, used\_at. OTP storage (FR-AUTH-02) |
| `auth_sessions` | user\_id, token\_hash, last\_seen\_at, expires\_at, revoked\_at. 7-day sliding window |
| `invite_batches` | created\_by, source `single\|csv`, file\_name, sent, skipped |
| `session_questions` | session\_id, question\_id, position, retry\_skipped, follow\_up\_text. The questions frozen when the session starts |
| `consents` | session\_id, user\_id, kind `recording`, text\_version, given\_at, ip (NFR-06) |
| `evaluation_flags` | session\_id, question\_id, question\_number, dimension, issue, note, status `open\|resolved`, resolution, created\_by, resolved\_by/at |
| `saved_filters` | admin\_id (null = system), label, query jsonb, is\_default |
| `activity_events` | user\_id, text, at. The candidate timeline ("First login", "Studied 12 of 12 flash cards") |
| `workspace_settings` | Single row: `WorkspaceSettings` (voice, feedbackLength, audioRetentionDays, transcriptRetention, candidatesCanDeleteData, senderName, replyTo, inviteLinkExpiryDays, lastExportAt) |
| `prompt_versions`, `ai_call_logs`, `export_jobs`, `privacy_requests` | Versioned prompts and model config; per-call cost and latency log; async exports; candidate export and deletion requests |

The API maps UI ids onto the database. The candidate UI's `FlashCard.id` is the card's `position`, and its band ids are kebab-case. The admin UI uses snake\_case ids (`not_ready`, `nearly`). Pick one canonical band enum: `not_ready | developing | nearly_ready | interview_ready`. Both clients then map it.

## Candidate API

These endpoints replace the mocks in `prep-candidate-ui/lib/api.ts` and the localStorage store in `lib/store.ts`. Their responses use the shapes in `lib/types.ts`, so the screens keep working unchanged. Every route is under `/api`, uses JSON, and requires the candidate session cookie. A role that isn't assigned or isn't Approved returns `404`, not `403`, so it stays hidden.

| Screen | Endpoint | Request | Response / behaviour |
| --- | --- | --- | --- |
| Login | `POST /auth/code`, `POST /auth/verify`, `POST /auth/logout`, `GET /me` | see Auth | see Auth |
| Dashboard | `GET /roles` | — | `RoleWithStatus[]`. The server derives `status`: an in-progress session → `interviewing {question}`; else any completed session → `completed {score: best, baseline: first or null}`; else cards viewed → `studying {viewed}`; else `not-started`. Also adds `latest`, `bestBand`, `latestBand`, `attemptsLeft` and `accessExpiresAt` (SRS 5.6, FR-ADM-05) |
| Role shell | `GET /roles/:roleId` | — | `Role` plus settings: `cardsRequired`, `questionsPerSession`, `answerSoftLimitSec` (default 120), `retriesPerQuestion` (1) |
| Flash cards | `GET /roles/:roleId/cards` | — | `{cards: FlashCard[], viewed: number[]}`. Only Approved cards, in their set order. `id` is the stable 1-based card number that "Review on card N" links point at |
| Flash cards | `POST /roles/:roleId/cards/:cardId/view` | — | `204`, idempotent. Writes a `CardView` record (FR-CARD-03) |
| Flash cards | `GET /roles/:roleId/cards/:cardId/audio` | — | `302` to cached TTS audio (FR-CARD-05, Could). The UI uses browser TTS for now |
| Prepare | `POST /roles/:roleId/sessions` | `{mode: "voice" \| "typed", consent: {recording: true, text, version}}` | `201` with the session in progress: `{id, number, questions: InterviewQuestion[], intro: {text, audioUrl}, currentQuestion: 1}`. If a session is already in progress, returns `409` with that session so the UI can resume it. Returns `403` with code `cards_not_viewed`, `attempt_limit` or `access_expired` when blocked. Questions are picked at start, fixed or random per role, and stored on the session |
| Interview | `GET /sessions/:id` | — | While in progress, resume state: `{status, mode, currentQuestion, questions, results: QuestionResult[], pending: {questionId, attemptNo} \| null}`. Survives a page refresh (NFR-03). When completed, this is the report (see Results) |
| Interview | `GET /questions/:questionId/audio` | — | `302` to cached TTS of the question text (FR-INT-03; must start playing within 2 s, NFR-01) |
| Interview | `POST /sessions/:id/questions/:questionId/attempts` | multipart: `attemptNo` 1\|2, `mode`, `audio` (webm/ogg/mp4, ≤ 5 min) **or** `text` (≤ 1500 chars), `durationSec`, header `Idempotency-Key` | `202 {attemptId}`. The pipeline then runs: STT, metrics, evaluation, TTS. A second POST with the same key returns the same attempt, which makes the UI's retry safe. Attempt 2 must have attempt 1 done; one retry per question in R1 (FR-RETRY-04) |
| Interview | `GET /attempts/:attemptId` | — | Polling fallback for the WebSocket. Returns `{status: "transcribing" \| "evaluating" \| "done" \| "failed", attempt?: Attempt, applied?: AppliedItem[], followUp?: string}` |
| Interview | `WS /ws/sessions/:id` | client sends `audio.chunk` frames (optional live STT) | server sends `transcript.partial`, `attempt.transcribed`, `attempt.evaluated` (the full `Attempt`, plus `applied[]` on attempt 2), `feedback.audio_ready {url}`, `attempt.failed {retryable, textModeOffered}` |
| Interview | `POST /sessions/:id/questions/:questionId/skip-retry` | — | `204`. Records `second: null`. The question then counts as no change: A2 = A1 and a learning score of 50 (user decision 2026-10-16, replacing FR-RETRY-05's 0) |
| Interview | `POST /sessions/:id/complete` | — | Allowed once every question has attempt 1 and either attempt 2 or a skipped retry. Runs the summariser and returns the `Session` report |
| Interview | `POST /sessions/:id/abandon` | — | Optional. "Save and exit" needs no call, because state is saved after every attempt |
| Results | `GET /sessions/:id` (completed) | — | `Session`: `{id, roleId, number, startedAt, completedAt, score, band, skills, strengths: ReportPoint[], focus: ReportPoint[], results: QuestionResult[], bandMessage}` |
| Results | `GET /roles/:roleId/sessions` | — | Summaries, oldest first: `{id, number, startedAt, score, band}[]`, for the progress chart and the baseline |
| Results | `GET /attempts/:attemptId/audio` | — | `302` to a short-lived signed S3 URL for "Play your answer". Returns `410` after the 30-day audio expiry |
| Results | `GET /sessions/:id/report.pdf` | — | Server PDF (FR-SCORE-04, Could). The UI currently uses `window.print()` |
| History | `GET /sessions` | `?roleId=` optional | All of the user's completed sessions, newest first, as the same summary shape. The UI groups them by role |
| Privacy | `GET /me/export`, `POST /me/deletion-request` | — | NFR-06. Export returns a JSON zip asynchronously, by email link. Deletion is queued for an admin to action |

**Fields the UI types need added**

- `Attempt`: `id`, `attemptNo`, `audioUrl`, `feedbackAudioUrl`, `submittedAt`
- `InterviewQuestion`: `category`. The room currently guesses it with a regex
- `Session`: `completedAt`, `bandMessage`, `firstAttemptAvg`, `retryAvg`, `learningAvg`. All dates are full ISO 8601 timestamps; `history/format.ts` currently splits `YYYY-MM-DD`

**Errors.** Every error returns `{error: {code, message}}`. The UI branches on these codes: `not_found`, `cards_not_viewed`, `attempt_limit`, `access_expired`, `session_in_progress`, `ai_unavailable` (offer retry or text mode, FR-INT-09) and `rate_limited`.

## Admin API

The admin endpoints replace the mock services in `prep-admin-ui/src/services/*.ts` one-for-one. Request and response bodies use the types in `src/lib/types.ts`.

- Every route is under `/api/admin` and needs an Admin or Super admin session.
- Every mutation writes an `AuditLog` row, using the action strings the UI already emits ("Sent N invites", "Approved role", …).
- List endpoints take `?cursor=&limit=` and return `{rows, nextCursor, total}`. The UI fetches whole lists today, so the default `limit` should be 200 until it paginates.

**Me and candidates** (`services/candidates.ts`)

| Endpoint | Body / query → response | Rules |
| --- | --- | --- |
| `GET /admin/me` | → `Admin` | Replaces the hard-coded `adm_arjun` and the sidebar name |
| `GET /admin/candidates` | `CandidateQuery` as query params (`search`, `roleIds[]`, `bands[]`, `statuses[]`, `lastActiveWithinDays`, `noChangeInSessions`, `sort`, `dir`) → `CandidateList` | Search is case-insensitive on name and email. Band comes from the latest completed session. `change` = latest − baseline, null when there are fewer than 2 sessions. Nulls sort last. Computed in SQL from a per-assignment stats view |
| `GET /admin/candidates/:id` | → `CandidateDetail` | `assignments[]` with baseline, latest and `sessionsUsed`; `sessions[]` newest first; `activity[]`; `progress[]` oldest first |
| `POST /admin/invites/validate` | `{rows: InviteRowInput[]}` → `{rows: InviteRow[], summary}` | Authoritative version of the CSV check in `lib/csv.ts`. Results: `invalid_email`, `already_invited`, `unknown_role`, `role_not_approved` and `duplicate_in_file` |
| `POST /admin/invites` | `InviteBatchInput` → `InviteBatchResult` | Creates `User(status=invite_pending)`, `Invite`, `RoleAssignment(max_attempts)` and an `InviteBatch`. Queues invite emails whose link expires after `inviteLinkExpiryDays`. Rows that aren't ready are skipped (FR-ADM-01..03, 05) |
| `POST /admin/invites/resend` | `{candidateIds[]}` → `{resent, skipped}` | Pending candidates only. Issues a fresh token and resets `invitedAt` |
| `POST /admin/candidates/:id/revoke-invite` | → `204` | `invite_pending` → `revoked`. The token hash is invalidated |
| `POST /admin/candidates/deactivate` | `{ids[]}` → `{deactivated, skipped}` | Deletes the user's auth sessions at once, and an in-progress interview stops on its next call (FR-ADM-04). Pending rows are revoked |
| `POST /admin/candidates/reactivate` | `{ids[]}` → `{reactivated}` | Exists in services; no UI yet |
| `PATCH /admin/candidates/:id` | `{name?, accessUntil?}` | Access expiry (FR-ADM-05) |
| `POST /admin/candidates/assign-roles` | `{ids[], roleIds[]}` → `{added}` | Archived roles are rejected. Existing assignments are skipped. `maxSessions` defaults to the role setting. The candidate is emailed if the role is Approved |
| `DELETE /admin/candidates/:id/roles/:roleId` | → `204` | Soft-removes the assignment. Past sessions stay in reports |
| `PATCH /admin/candidates/:id/roles/:roleId` | `{maxSessions}` | Per-assignment attempt limit |
| `GET /admin/candidates/export.csv` | `?ids[]=` → `text/csv` | Columns as `exportCandidatesCsv` (FR-REP-04) |
| `GET /admin/saved-filters`, `POST /admin/saved-filters` | `{label, query}` → `SavedFilter` | Stored per admin. The four seeded filters are system rows |

**Roles and content** (`services/roles.ts`)

| Endpoint | Body / query → response | Rules |
| --- | --- | --- |
| `GET /admin/roles` | `?status=` → `JobRole[]` | Includes derived counts, `candidatesAssigned`, and `avgLatestScore` and band (Approved roles only) |
| `POST /admin/roles` | `RoleInput` → `JobRole` | Status `draft`. Default settings: 5 questions, fixed order, 120 s, all cards required, max 5 sessions, weights 20/55/25 and 45/20/20/15 |
| `GET /admin/roles/:id` / `PATCH /admin/roles/:id` | `RolePatch` → `JobRole` | The UI autosaves on every 800 ms debounce, so audit edits are merged into one row per admin per role per 10 minutes. HTML in `description` is sanitised server-side. Each weight group must sum to 100. Archived roles are read-only |
| `GET /admin/roles/:id/approve-requirements` | → `ApproveRequirements` | At least 5 approved questions with ≥ 1 key point (or `questionsPerSession`, whichever is higher), both weight groups sum to 100, and at least 1 approved card |
| `POST /admin/roles/:id/approve` | → `{role, notified}` | Draft → approved. Emails assigned candidates and queues question TTS pre-generation |
| `POST /admin/roles/:id/archive` | → `JobRole` | Hidden from candidates. In-progress sessions may finish. Scores are kept |
| `GET /admin/roles/:id/cards` | → `FlashCard[]` | Sorted by `position` |
| `POST /admin/roles/:id/cards`, `PUT /admin/cards/:cardId` | `FlashCardInput` → `FlashCard` | Tip ≤ 90 chars. Created by an admin → `approved` |
| `PUT /admin/roles/:id/cards/order` | `{orderedIds[]}` → `FlashCard[]` | Must list every card exactly once |
| `POST /admin/cards/:cardId/approve`, `DELETE /admin/cards/:cardId` | → `FlashCard` / `204` | Discard applies to `ai_draft` only, and the remaining cards are renumbered |
| `POST /admin/roles/:id/cards/draft-ai` | `{count?: 3}` → `FlashCard[]` | Async LLM job using the role title, description and skills. Returns `ai_draft` cards with `createdBy: "ai"` and sets `role.lastAiDraftAt` (FR-ROLE-06) |
| `GET /admin/roles/:id/questions` | → `Question[]` | Adds `timesAsked`, `avgFirstTry`, `avgSecondTry` and `avgLearning` from completed sessions |
| `POST /admin/roles/:id/questions`, `PUT /admin/questions/:qid` | `QuestionInput` → `Question` | Text required. Approve by sending `status: "approved"`. Each question also needs a `cardId`, the card it is drawn from, so the candidate's "Review on card N" works |
| `DELETE /admin/questions/:qid` | → `204` | Archives a question that has been asked; deletes a draft. Not in the UI yet |
| `POST /admin/roles/:id/questions/draft-ai` | `{count?: 2}` → `Question[]` | Replaces the UI stub. Drafts include a rubric |
| `POST /admin/questions/:qid/test` | `{answer}` → `TestEvaluation` | Runs the real evaluator with the role's weights. Never stored on a candidate (`isTest: true`). The latest result is cached as `sampleEvaluation` |
| `POST /admin/roles/:id/preview-session` | → candidate session | Test interview (FR-ROLE-07). Runs the candidate flow with `is_preview = true`, kept out of all stats. The UI's Preview tab only reads cards and questions today |

**Sessions, flags, reports** (`services/sessions.ts`, `reports.ts`)

| Endpoint | Body / query → response | Rules |
| --- | --- | --- |
| `GET /admin/candidates/:cid/sessions/:sid` | → `SessionReview` | Full `questions[].tries` with `audioUrl` (signed, until the retention date), `highlights` and `appliedFromFeedback` (FR-REP-02) |
| `GET /admin/sessions/:sid/flags`, `POST /admin/sessions/:sid/flags` | `FlagInput` → `EvaluationFlag` | Never changes scores (FR-REP-05). Store `questionId` along with `questionNumber` |
| `PATCH /admin/flags/:id` | `{status: "resolved", resolution}` | Resolution workflow (UI pending) |
| `GET /admin/reports` | `?roleId&from&to` → `Report` | `dateBasis=completed\|invited` (default `completed`) chooses whether the range filters sessions by completion date or candidates by invite date. Soft-deleted candidates are excluded. Baseline = each candidate's first session ever; latest = their last in the range. Needs attention: latest < 50 or no activity for 14+ days (FR-REP-01, 03) |
| `GET /admin/reports/export.csv` | same query → `text/csv` | Layout as `exportReportCsv` |

**Workspace settings, admins, audit** (`services/settings.ts`)

| Endpoint | Body / query → response | Rules |
| --- | --- | --- |
| `GET /admin/settings`, `PATCH /admin/settings` | `WorkspaceSettings` | Super admin only for privacy and email. One audit row per changed field ("old → new"). A shorter retention takes effect at the next nightly purge |
| `GET /admin/settings/voices/:voice/sample` | → audio | "Play sample" |
| `POST /admin/exports` | → `{exportId, lastExportAt}` | Super admin. Async job builds the candidate, session and score CSVs (no audio). An email links to a signed download |
| `GET /admin/admins`, `POST /admin/admins` | `{email, access}` → `Admin` | Super admin. Email must be unique. Sends an invite |
| `POST /admin/admins/:id/resend`, `PATCH /admin/admins/:id`, `DELETE /admin/admins/:id` | `{access}` | Always keep ≥ 1 active Super admin. An admin cannot remove themself |
| `GET /admin/audit` | `AuditFilters` + cursor → `AuditEvent[]` | Newest first. `to` includes the whole day |
| `GET /admin/audit/actions` | → `string[]` | Distinct actions, for the filter |
| `GET /admin/ai-config`, `PUT /admin/ai-config` | prompt versions, model per prompt role, temperature | Super admin. Required by the SRS (2.2, NFR-12) but no screen exists yet |
| `GET /admin/privacy/requests`, `POST /admin/privacy/requests/:id/complete` | — | Candidate export and deletion requests (NFR-06). No screen yet |

## AI interview pipeline

Each attempt runs as one background job: STT, then delivery metrics, then the LLM evaluator, then TTS. Written feedback goes out as soon as the evaluator finishes, within 8 s at p90 (FR-FB-01). Spoken feedback follows as a separate `feedback.audio_ready` event. The job is idempotent per `(session, question, attemptNo)`.

**Answer flow (SRS 9.1)**

1. The answer arrives at the API. Audio goes to object storage under `audio/{sessionId}/{attemptId}.webm`, with a 30-day lifecycle rule. Typed text is stored as-is.
2. STT (batch in R1, with word timestamps) returns the transcript and words. Live transcription over the WebSocket is a Should (FR-INT-05). The design frames show it, but the current code does not.
3. The metrics step runs in code, not the LLM. It produces `wpm`, `filler_count`, `pause_count` (gaps over 1.0 s) and `duration_s`. Each becomes a `DeliveryMetric`: `{key, label, value, valueText, scale, target, targetText, note, inTarget}`. Targets come from config: pace 120–160 wpm, fillers 0–4, pauses 3–6. The evaluator's user message carries the configured targets next to the measured metrics ("Targets: pace 120–160 wpm, fillers ≤ 4, pauses over one second ≤ 6."), and the prompt refers to them instead of fixed numbers (user decision 2026-10-16, evaluator prompt v5). Typed answers have no voice metrics, so `delivery: []` and the UI hides that block; their evaluator message has no targets line.
4. The evaluator LLM runs at low temperature with JSON-schema output. It returns scores, evidence and feedback (schema below). Invalid JSON is retried once; a second failure marks the attempt `failed` with `ai_unavailable` (FR-INT-09).
5. The attempt is saved and `attempt.evaluated` is pushed. TTS renders the spoken summary (about 30 s), and the audio is cached by content hash.
6. The interviewer prompt produces the retry prompt or the transition to the next question. Question audio is cached per question (SRS 7.3).

**Evaluator output**, validated by the server:

```json
{
  "dimension_scores": {"content": 1-5, "structure": 1-5, "delivery": 1-5, "relevance": 1-5},
  "evidence": [{"dimension": "content", "quote": "...", "note": "..."}],
  "worked": ["..."], "improve": ["..."], "opener": "...",
  "improvement_points": ["..."],
  "delivery_notes": "...", "spoken_summary": "...",
  "follow_up": null,
  "applied": [{"point": "...", "status": "applied|partly|not_applied", "evidence": "..."}]
}
```

Notes on the schema:

- `applied` is present only for attempt 2. The evaluator receives the attempt-1 `improvement_points` and checks each one (FR-RETRY-02).
- `follow_up` is a short probe question, or null. The evaluator sets it only when the answer is too vague to score, at most once per question (FR-INT-07, Could).
- `improvement_points` become the UI's `focus` chips for the second try.

**Scoring (SRS 5).** The defaults below are per-role config.

- Each dimension maps from 1–5 to 0, 25, 50, 75 or 100. These map to the UI's `subScores`.
- Attempt score = 0.45·Content + 0.20·Structure + 0.20·Delivery + 0.15·Relevance.
- Learning score per question = (applied = 1, partly = 0.5, not applied = 0) ÷ number of points × 100. A skipped retry counts as "no change": its A2 is set to A1 and its L to 50, the same as a retry that showed no improvement. This is a user decision of 2026-10-16 that replaces SRS FR-RETRY-05 ("learning score 0"). Scores are stored at completion, so sessions completed earlier keep their L = 0 scores; the per-question report and question-bank averages (`avgLearning`) are computed from attempts and apply L = 50 to every skipped retry, older ones included.
- Session preparedness:

```latex
\text{Preparedness} = 0.20\,\overline{A_1} + 0.55\,\overline{A_2} + 0.25\,\overline{L}
```

- Band: 85–100 Interview ready, 70–84 Nearly ready, 50–69 Developing, 0–49 Not ready yet. Each band carries the SRS 5.4 message.
- `skills` = the per-dimension average across all attempts in the session. `strengths` and `focus` come from the session summariser: top 3 of each, and each maps to the `cardId` of its question for "Review on card N".

**Prompts (SRS 7.2, NFR-12).** There are three prompt roles: `interviewer`, `evaluator` and `summariser`. Each is stored as a versioned `PromptVersion` row, not in code. Only one version per role is active. Every call goes through an `LlmAdapter` interface, with the provider set in config.

**Safety (NFR-05, NFR-09)**

- The candidate transcript is wrapped as delimited data. The prompts tell the model never to follow instructions found inside it.
- Output passes a moderation step and a blocklist for hiring-decision language ("you would be hired", "reject").
- The interviewer persona declines off-topic requests (FR-INT-08).
- The evaluator is told not to penalise accent or non-native grammar that does not hurt clarity.

**Logging (SRS 6, NFR-10).** Every LLM, STT and TTS call writes an `AiCallLog` row: `{session_id, attempt_id, kind, provider, model, prompt_version, input_tokens, output_tokens, audio_seconds, latency_ms, cost_usd, status, error}`. Cost per session is rolled up for the < USD 0.50 target.

## Non-functional requirements

The hard release-1 numbers are: feedback within 8 s at p90, a spoken question within 2 s, 100 concurrent interviews, 99.5% monthly uptime, and under USD 0.50 per 5-question session. The table maps each SRS NFR to what the backend must do to meet it.

| NFR | Target | Backend design |
| --- | --- | --- |
| NFR-01 Performance | API p95 < 300 ms; question audio < 2 s; feedback < 8 s p90 | Pre-generate question TTS when a role is approved, so audio is served from cache or CDN. Batch STT on short clips. Push results over WebSocket instead of polling. Load test the full flow with 100 sessions |
| NFR-02 Scalability | 100 concurrent sessions | Stateless API pods. Redis queue with N workers for the attempt pipeline. Provider concurrency limits are set in adapter config |
| NFR-03 Availability | 99.5%/month; sessions survive refresh | All interview state lives in Postgres after each step, never only in memory. `GET /sessions/:id` restores it. Workers retry jobs with backoff |
| NFR-04 Security | TLS 1.2+, at-rest encryption, hashed tokens, OWASP Top 10 | OTPs, invite tokens and session ids are stored as SHA-256 hashes. Encrypted RDS and S3 (SSE). CSRF protection on cookie auth (SameSite plus an origin check). Server-side authorisation on every admin route. Input validation with a schema library. Short-lived signed audio URLs |
| NFR-05 AI safety | Injection guards, moderation, persona limits | See AI interview pipeline |
| NFR-06 Privacy | Consent before recording; audio removed after 30 days; transcripts kept until deleted; export and delete on request | Store a `consent` record per session (text version plus timestamp). An S3 lifecycle rule and a nightly job null `audio_url` when audio expires; the Super admin sets the retention period. Candidate deletion follows the DPDP Act. The candidate is hidden at once and their audio deleted. All their personal data is hard-deleted within 7 days, including from S3. Backups age out within the 35-day snapshot window. Only an anonymous erasure receipt is kept. Export is a JSON bundle |
| NFR-07 Accessibility | Captions for all speech | Every audio response also returns its text: question text, intro text, `spoken_summary` |
| NFR-09 Fairness | No accent penalty | Evaluator prompt rule. Delivery is scored on clarity, not accent. Bias review of rubrics is a process item |
| NFR-10 Cost | < USD 0.50 per session | Roll up `AiCallLog` per session. Cache TTS. Cap transcript and context tokens. The admin dashboard shows cost per session |
| NFR-11 Observability | Structured logs, error tracking, LLM metrics | JSON logs carry a request id and session id. Sentry (or similar) for errors. Metrics per provider call: latency, failure rate, tokens |
| NFR-12 Maintainability | Prompts, rubrics and weights are config | `PromptVersion`, per-role `scoring_config` and `Question.rubric` are DB-backed and editable in the admin Settings and content editor |

Release 1 needs four background jobs:

- the attempt pipeline
- question TTS pre-generation on role approve
- audio retention purge (daily)
- CSV and data export

## UI vs SRS gaps and open questions

The biggest conflict is the session score. The candidate UI averages each question's best try. The SRS and the admin UI use 20% first try + 55% retry + 25% learning. The backend follows the SRS, and the candidate UI's `lib/session-builder.ts` must be removed. The table lists each conflict found and the decision this spec takes.

| Topic | Candidate UI | Admin UI | SRS | Spec decision |
| --- | --- | --- | --- | --- |
| Session score | Mean of best tries, computed client-side | 20/55/25 formula | 20/55/25 formula (5.3) | Server computes the SRS formula |
| Skipped retry | "Second try skipped" | "retry skipped"; no per-question learning shown | Learning score 0 (FR-RETRY-05) | User decision 2026-10-16: "no change", A2 = A1 and L = 50. Applies to sessions completed from that date; stored scores are not recomputed |
| Strengths / focus | Top and bottom 3 questions by score | — | Session summariser (7.2) | LLM summariser, each item linked to a `cardId` |
| Delivery metrics | pace, fillers, pauses (design shows Length) | wpm, fillerWords, longestPauseSec | wpm, filler count, answer length (FR-FB-04) | Compute all five: wpm, filler\_count, pause\_count, longest\_pause\_s, duration\_s. Each client shows its own subset |
| Applied-from-feedback values | `applied \| partly \| not-yet` | `done \| partial \| missed` | applied, partly, not applied (5.2) | Canonical `applied \| partly \| not_applied` |
| Band ids | kebab-case | `ready \| nearly \| developing \| not_ready` | 4 bands (5.4) | Canonical `interview_ready \| nearly_ready \| developing \| not_ready` |
| Question → card link | Each question has `cardId` | No such field | Not stated | Add `questions.flash_card_id`; required to approve |
| Card count | Hard-coded 12 | Any number of cards | Not fixed | Use the role's approved card count |
| Card gate before interview | Always required | `requireAllCards` per role | Optional per role (FR-CARD-04) | Server enforces the role setting |
| Transcript highlights | — | `match \| issue` highlights per try | Evidence quotes (5.5) | Evaluator returns `highlights[{quote, kind, note, rubricPointId}]` |
| Audio retention copy | "30 days" hard-coded | 7/30/90 setting | 30 days default (NFR-06) | Serve `audioRetentionDays` to the candidate app |
| Rate-limit copy | "15 minutes" | — | e.g. 5 per hour (FR-AUTH-05) | Return `retryAfterSec`; the UI shows the real wait |
| Sample answer outline | Not shown | Not edited | Card field (FR-ROLE-03) | Nullable column; add it to the editor later |
| AI prompt and model config | — | Voice and feedback length only | Super admin manages AI settings (2.2, NFR-12) | API is specified; a screen is needed |
| AI and voice permissions | — | Read-only for Admin in code; editable in `domain-model.md` | Super admin | Super admin only |
| Follow-up question | No UI | — | Could (FR-INT-07) | API supports `followUp`; off by default |
| Live transcript | Batch in code; live in design frames | — | Should (FR-INT-05) | Batch in R1; WebSocket stream as a fast-follow |
| Role-assigned and session-complete emails | "You'll get an email when it's ready" | No template designed | Session-complete optional (7.4) | Send role-assigned on approve or assign; session-complete off |

**Decisions** (product owner, 2026-10-15)

- **Data residency:** all data is hosted in India. Primary region AWS ap-south-1 (Mumbai), backups in ap-south-2 (Hyderabad). The LLM, STT, TTS and email providers must process data in India, through a Mumbai-region managed model or a self-hosted alternative. Confirm this per vendor before M5.
- **Score visibility:** candidates see both the numeric score and the band, as both UIs already do.
- **Transcripts:** admins can see every transcript. The recording consent text must say that admins review answers.
- **Admin structure:** multiple admins in one department, so there is no `org_id`.
- **Report dates:** configurable. `GET /admin/reports` takes `dateBasis=completed|invited` (default `completed`). The Reports screen needs a toggle for it.
- **Candidate deletion:** the system must comply with India's DPDP Act 2023 and permanently erase the data. Deletion runs in two steps:
  - At once: the candidate is hidden from the app and from every report and aggregate. Their logins are revoked and their audio is deleted.
  - Within a 7-day grace period (configurable): every row and file holding their personal data is hard-deleted.

  Only an anonymous erasure receipt is kept. Confirm the legal deadline with counsel.
