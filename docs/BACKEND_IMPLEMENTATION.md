# PrepPilot backend: implementation plan

Status: written 2026-10-15. M0 started: NestJS 12 + Prisma 7.10 scaffolded, no models yet.

**Stack decided (2026-10-15): NestJS + Prisma ORM + PostgreSQL.**

This file says **how** to build the backend. **What** to build is in the backend spec: `docs/BACKEND_SPEC.md`
(live version: <https://claude.ai/code/artifact/087bdc70-db63-405d-9281-8ab62d5e5941>)

Sources:

- SRS: `docs/Software Requirements Specification AI Interview Prep Tool.pdf` (release 1 scope); plain-text extract in `docs/SRS.txt`
- Candidate UI: `../prep-candidate-ui/` (Next.js). Contract: `lib/types.ts`, `lib/api.ts`, `lib/store.ts`
- Admin UI: `../prep-admin-ui/` (Next.js). Contract: `src/lib/types.ts`, `src/services/*.ts`

Both UIs are mock-only today: no `fetch` calls and no env vars. The backend's job is to make those mock functions real without changing the screens.

---

## 1. Decisions

| Area | Choice | Notes |
| --- | --- | --- |
| Language / framework | TypeScript, Node 22 LTS, NestJS 11 | **Decided.** Matches both clients and shares their types |
| ORM / migrations | Prisma | **Decided.** One schema file, typed client, `prisma migrate` with migrations in git; raw SQL migrations for partial indexes and views |
| Validation | Zod schemas (`nestjs-zod`) | Same schemas drive the OpenAPI output |
| API docs / clients | `@nestjs/swagger` → `openapi.json` → `openapi-typescript` client in each UI | Replaces `lib/api.ts` and `src/services/*` |
| DB | PostgreSQL 16 (`citext`, `pgcrypto`) | **Decided.** AWS RDS in ap-south-1, Multi-AZ |
| Queue / cache | Redis 7 + BullMQ | Attempt pipeline, TTS, purge, exports, rate limits |
| Object storage | AWS S3 in ap-south-1, SSE on | Lifecycle rule on the `audio/` prefix |
| Realtime | NestJS WebSocket gateway (`ws`), Redis pub/sub adapter | Workers publish, the gateway pushes to the client |
| LLM | `LlmAdapter` interface; first impl Anthropic (Claude) | Model per prompt role comes from DB config |
| STT | `SttAdapter`; first impl Deepgram (word timestamps) | Batch in R1, streaming later |
| TTS | `TtsAdapter`; first impl ElevenLabs or Azure | Cached by content hash |
| Email | `MailAdapter`; first impl Amazon SES (Postmark as fallback) | SPF and DKIM on the sending domain |
| Errors / logs | Pino JSON logs, Sentry, OpenTelemetry traces | Request id and session id on every log line |
| Tests | Vitest (unit), Supertest + Testcontainers (Postgres, Redis) for e2e | Adapters are faked in tests |
| Deploy | Docker images: `api`, `worker`. ECS Fargate, RDS, ElastiCache and S3, all in **AWS ap-south-1 (Mumbai)**; backups and DR in ap-south-2 (Hyderabad) | Data residency: India only (DPDP Act 2023) |
| Provider residency | Every external provider must process in India | LLM: a Claude model served through a Mumbai-region managed endpoint (e.g. Bedrock), checked before M5. STT: a vendor with India processing, or self-hosted Whisper on GPU in ap-south-1. TTS: Azure Central India or an equivalent. Email: SES ap-south-1 |

---

## 2. Repository layout

New repo `prep-backend/`, next to the two UIs.

```
prep-backend/
  prisma/
    schema.prisma
    migrations/
    seed.ts                 # roles, cards and questions from the UIs' mock data
  src/
    main.ts                 # HTTP + WS bootstrap
    worker.ts               # BullMQ worker bootstrap (separate process)
    config/                 # env schema (zod), typed ConfigService
    common/
      auth/                 # SessionGuard, RolesGuard, @CurrentUser, @Roles()
      errors/               # AppError(code), exception filter → {error:{code,message}}
      audit/                # AuditService + @Audited() interceptor
      pagination/
      rate-limit/           # Redis token bucket
      idempotency/          # Idempotency-Key interceptor
    adapters/
      llm/                  # LlmAdapter + anthropic.adapter.ts + fake.adapter.ts
      stt/                  # SttAdapter + deepgram.adapter.ts + fake
      tts/                  # TtsAdapter + elevenlabs.adapter.ts + fake
      mail/                 # MailAdapter + ses.adapter.ts + console (dev)
      storage/              # S3 wrapper: put, signed GET, delete
    modules/
      auth/                 # /auth/code, /auth/verify, /auth/logout, /me
      users/                # candidates and admins, invites, assignments
      content/              # job roles, flash cards, questions, AI drafting
      interview/            # sessions, attempts, scoring, WS gateway
        pipeline/           # attempt job: stt → metrics → evaluate → tts
        scoring/            # pure functions; unit-tested hardest
        prompts/            # prompt rendering, schema for each prompt role
      reports/              # admin dashboards, CSV, flags
      settings/             # workspace settings, AI config, privacy requests
      activity/             # activity_events writer
    jobs/                   # BullMQ processors: attempt, tts-pregen, purge, export, email
  test/
    e2e/
    fixtures/
  docker-compose.yml        # postgres, redis, minio, mailpit
  Dockerfile
```

Module dependencies run one way: `auth → users → content → interview → reports`. `common` and `adapters` are shared. Modules never import a sibling's repository directly; they call its service.

---

## 3. Environment

```
NODE_ENV, PORT
DATABASE_URL
REDIS_URL
S3_BUCKET, S3_REGION, S3_ENDPOINT (minio in dev), AUDIO_URL_TTL_SEC=300
APP_CANDIDATE_ORIGIN, APP_ADMIN_ORIGIN       # CORS + CSRF origin check + email links
SESSION_COOKIE_DOMAIN, SESSION_TTL_DAYS=7
OTP_TTL_MIN=10, OTP_MAX_TRIES=5, OTP_REQUESTS_PER_HOUR=5, OTP_RESEND_COOLDOWN_SEC=30
LLM_PROVIDER=anthropic, ANTHROPIC_API_KEY
STT_PROVIDER=deepgram, DEEPGRAM_API_KEY
TTS_PROVIDER=elevenlabs, ELEVENLABS_API_KEY
MAIL_PROVIDER=ses, MAIL_FROM, SES_REGION
SENTRY_DSN, OTEL_EXPORTER_OTLP_ENDPOINT
```

Prompt text, model ids, temperatures, scoring weights and delivery targets are **not** env vars. They live in the DB (`prompt_versions`, `job_roles.settings`, `workspace_settings`), per NFR-12.

---

## 4. Database (Prisma sketch)

The field-level spec is in the spec doc's "Data model" section. This is the starting schema; enums are canonical (see §10). Small models are written on one line to save space. Prisma needs one field per line, so expand them when you create `schema.prisma`.

```prisma
enum UserRole       { candidate admin super_admin }
enum UserStatus     { invite_pending active deactivated revoked }
enum InviteStatus   { pending accepted revoked expired }
enum RoleStatus     { draft approved archived }
enum Seniority      { entry junior mid senior }
enum ContentStatus  { ai_draft approved archived }
enum CardCategory   { behavioural situational role_knowledge motivation }
enum Difficulty     { easy medium hard }
enum SessionStatus  { in_progress completed abandoned failed }
enum AnswerMode     { voice typed }
enum AttemptStatus  { received transcribing evaluating done failed }
enum Band           { not_ready developing nearly_ready interview_ready }
enum FlagStatus     { open resolved }

model User {
  id              String     @id @default(uuid())
  email           String     @unique @db.Citext
  name            String?
  title           String?
  role            UserRole
  status          UserStatus @default(invite_pending)
  accessExpiresAt DateTime?
  firstLoginAt    DateTime?
  lastActiveAt    DateTime?
  deletedAt       DateTime?  // erasure stage 1 (hidden); the row is hard-deleted by the purge job
  createdAt       DateTime   @default(now())
  updatedAt       DateTime   @updatedAt
  assignments     RoleAssignment[]
  sessions        Session[]
  authSessions    AuthSession[]
}

model Invite {
  id        String       @id @default(uuid())
  email     String       @db.Citext
  userId    String
  invitedBy String
  batchId   String?
  tokenHash String       @unique
  status    InviteStatus @default(pending)
  sentAt    DateTime
  expiresAt DateTime
}

model InviteBatch { id String @id @default(uuid()) createdBy String source String fileName String? sent Int skipped Int createdAt DateTime @default(now()) }

model AuthCode {
  id        String    @id @default(uuid())
  email     String    @db.Citext
  codeHash  String
  expiresAt DateTime
  tries     Int       @default(0)
  usedAt    DateTime?
  createdAt DateTime  @default(now())
  @@index([email, createdAt])
}

model AuthSession {
  id         String    @id @default(uuid())
  userId     String
  tokenHash  String    @unique
  lastSeenAt DateTime
  expiresAt  DateTime
  revokedAt  DateTime?
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model JobRole {
  id              String     @id @default(uuid())
  slug            String     @unique
  title           String
  descriptionHtml String     @default("")
  seniority       Seniority
  keySkills       String[]
  status          RoleStatus @default(draft)
  settings        Json       // RoleSettings
  approvedAt      DateTime?
  approvedBy      String?
  lastAiDraftAt   DateTime?
  updatedBy       String?
  createdAt       DateTime   @default(now())
  updatedAt       DateTime   @updatedAt
  cards           FlashCard[]
  questions       Question[]
}

model RoleAssignment {
  id          String    @id @default(uuid())
  userId      String
  jobRoleId   String
  assignedBy  String
  assignedAt  DateTime  @default(now())
  maxAttempts Int?
  removedAt   DateTime?
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([userId, jobRoleId])
}

model FlashCard {
  id                  String        @id @default(uuid())
  jobRoleId           String
  position            Int
  category            CardCategory
  question            String
  strongAnswerPoints  String[]
  sampleAnswerOutline String?
  commonMistakes      String[]
  tip                 String        @db.VarChar(90)
  status              ContentStatus @default(approved)
  createdBy           String?       // null = AI
  approvedBy          String?
  approvedAt          DateTime?
  role                JobRole       @relation(fields: [jobRoleId], references: [id])
  @@unique([jobRoleId, position])
}

model CardView { userId String flashCardId String viewedAt DateTime @default(now()) @@id([userId, flashCardId]) }

model Question {
  id               String        @id @default(uuid())
  jobRoleId        String
  flashCardId      String?
  text             String
  category         CardCategory
  difficulty       Difficulty
  rubric           Json          // {keyPoints:[{id,point,example}], redFlags:[], expectedStructure}
  status           ContentStatus @default(approved)
  sampleEvaluation Json?
  audioKey         String?       // cached TTS
  role             JobRole       @relation(fields: [jobRoleId], references: [id])
}

model Session {
  id              String        @id @default(uuid())
  userId          String
  jobRoleId       String
  number          Int
  status          SessionStatus @default(in_progress)
  mode            AnswerMode
  isPreview       Boolean       @default(false)
  currentQuestion Int           @default(1)
  startedAt       DateTime      @default(now())
  completedAt     DateTime?
  durationS       Int?
  firstTryAvg     Float?
  retryAvg        Float?
  learningAvg     Float?
  score           Int?
  band            Band?
  skills          Json?
  strengths       Json?         // [{text, cardId}]
  focusAreas      Json?
  bandMessage     String?
  weightsSnapshot Json
  promptVersions  Json
  user            User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  questions       SessionQuestion[]
  attempts        Attempt[]
  @@unique([userId, jobRoleId, number])
  // partial unique index (raw SQL migration): one in_progress per (userId, jobRoleId)
}

model SessionQuestion {
  sessionId    String
  questionId   String
  position     Int
  retrySkipped Boolean @default(false)
  followUpText String?
  session      Session @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  @@id([sessionId, position])
}

model Attempt {
  id               String        @id @default(uuid())
  sessionId        String
  questionId       String
  attemptNo        Int           // 1 | 2
  mode             AnswerMode
  status           AttemptStatus @default(received)
  idempotencyKey   String
  transcript       String?
  words            Json?
  audioKey         String?
  audioExpiresAt   DateTime?
  durationS        Float?
  wpm              Float?
  fillerCount      Int?
  pauseCount       Int?
  longestPauseS    Float?
  dimensionScores  Json?         // {content,structure,delivery,relevance} 0..100
  score            Int?
  learningScore    Int?
  feedback         Json?         // worked, improve, opener, focus, deliveryNotes, applied[], highlights[], spokenSummary
  feedbackAudioKey String?
  evidence         Json?
  error            String?
  submittedAt      DateTime      @default(now())
  session          Session       @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  @@unique([sessionId, questionId, attemptNo])
  @@unique([sessionId, idempotencyKey])
}

model Consent        { id String @id @default(uuid()) sessionId String userId String kind String textVersion String givenAt DateTime @default(now()) ip String? }
model EvaluationFlag { id String @id @default(uuid()) sessionId String questionId String questionNumber Int dimension String issue String note String? status FlagStatus @default(open) resolution String? createdBy String createdAt DateTime @default(now()) resolvedBy String? resolvedAt DateTime? }
model SavedFilter    { id String @id @default(uuid()) adminId String? label String query Json isDefault Boolean @default(false) }
model ActivityEvent  { id String @id @default(uuid()) userId String text String at DateTime @default(now()) @@index([userId, at]) }
model AuditLog       { id String @id @default(uuid()) actorId String? action String entity String entityId String? itemLabel String before Json? after Json? ip String? at DateTime @default(now()) @@index([at]) }
model WorkspaceSettings { id Int @id @default(1) data Json updatedAt DateTime @updatedAt }
model PromptVersion  { id String @id @default(uuid()) role String version Int model String temperature Float template String outputSchema Json? active Boolean @default(false) createdBy String createdAt DateTime @default(now()) @@unique([role, version]) }
model AiCallLog      { id String @id @default(uuid()) sessionId String? attemptId String? kind String provider String model String? promptVersion Int? inputTokens Int? outputTokens Int? audioSeconds Float? latencyMs Int costUsd Decimal? @db.Decimal(10,5) status String error String? at DateTime @default(now()) }
model ExportJob      { id String @id @default(uuid()) requestedBy String kind String status String fileKey String? createdAt DateTime @default(now()) finishedAt DateTime? }
model PrivacyRequest { id String @id @default(uuid()) userId String kind String status String createdAt DateTime @default(now()) completedAt DateTime? }
model ErasureReceipt { id String @id @default(uuid()) emailSha256 String requestedBy String requestedAt DateTime hiddenAt DateTime purgedAt DateTime? s3ObjectsDeleted Int? }  // no personal data; proof of erasure
```

Add with raw SQL in migrations:

- A partial unique index: `sessions (user_id, job_role_id) WHERE status = 'in_progress'`
- A view `assignment_stats` (baseline, latest, best, sessions used, change) used by `GET /roles`, `/admin/candidates` and reports
- Erasure stage 1 (hidden):
  - A Prisma client extension adds `user: {deletedAt: null}` to every read of `User` and of user-owned models (`RoleAssignment`, `Session`, `Attempt`, `CardView`, `ActivityEvent`).
  - Raw SQL views and report queries join `users` and filter `u.deleted_at IS NULL` explicitly.
- Erasure stage 2 (purge): every foreign key to `users.id` (and from attempts and flags to `sessions.id`) is `ON DELETE CASCADE`. `ai_call_logs.session_id` and `attempt_id` are `ON DELETE SET NULL`. A single `DELETE FROM users WHERE id = $1` therefore removes everything relational.

---

## 5. Cross-cutting implementation

### Auth (FR-AUTH-01..06)

1. **`POST /auth/code`**
   1. Normalise the email.
   2. Check the Redis rate limit, both per email and per IP.
   3. Look up the user. If the user is invited or active and not expired, create an `AuthCode` (6 digits from `crypto.randomInt`, stored as an HMAC-SHA256 with a server pepper) and enqueue the email.
   4. **Always** return `sent`, unless the rate limit was hit.
   5. Delete older unused codes for that email.
2. **`POST /auth/verify`**
   1. Use a constant-time compare.
   2. Each failure does `tries++`. When `tries ≥ 5`, mark the code used and return `expired`.
   3. On success:
      - mark the code used
      - user `invite_pending → active`, and set `firstLoginAt`
      - invite → `accepted`
      - write the activity event "First login"
      - create the `AuthSession`: a 32-byte random token, stored as SHA-256
      - set the cookie
3. **`SessionGuard`** (global)
   1. Read the cookie, hash it and load the session with its user.
   2. Reject when the session is revoked or expired, the user is not active, or `accessExpiresAt` has passed.
   3. Slide `expiresAt`, writing at most once every 5 minutes.
   4. Update `lastActiveAt`.
4. **`RolesGuard`** with `@Roles('admin','super_admin')`: on every `/admin/*` controller. Super-admin-only routes say so explicitly.
5. **CSRF**: `SameSite=Lax`, plus an `Origin`/`Referer` allowlist check on non-GET requests.
6. **Deactivation**: `UPDATE auth_sessions SET revoked_at = now()` for the user. The interview gateway also closes the user's sockets.

### Errors

`AppError(code, httpStatus, message)`. A global filter turns it into `{error: {code, message}}`. The code list is in the spec ("Errors"). Prisma `P2002` maps to `409 conflict`.

### Audit (FR-ADM-06)

`@Audited('Approved role', {entity: 'job_role'})` on admin handlers writes `AuditLog` once the handler succeeds. Role autosave edits are merged: if the same actor and role have an "Edited role" row in the last 10 minutes, update it instead of inserting. Workspace settings write one row per changed field, with the text "old → new".

### Idempotency

The attempts endpoint takes an `Idempotency-Key`. `@@unique([sessionId, idempotencyKey])` returns the existing attempt on a replay.

### Rate limits

- Auth: 5 code requests per email per hour, plus 20 per IP per hour.
- AI drafting and test evaluation: 30 calls per admin per hour, to cap cost.

---

## 6. Interview engine

### State machine (server-side)

```
session: in_progress ──complete──▶ completed
              │
              └─abandon / admin deactivation─▶ abandoned

per question (position p):
  awaiting_attempt_1 ─submit─▶ attempt1 processing ─done─▶ awaiting_retry
  awaiting_retry ─submit─▶ attempt2 processing ─done─▶ question_done
  awaiting_retry ─skip-retry─▶ question_done
  question_done ─▶ currentQuestion = p+1
```

Question state is derived from `attempts` and `session_questions.retry_skipped`; no extra status column. `GET /sessions/:id` returns `pending` when an attempt is not `done` or `failed`, so a page refresh shows the processing state again (NFR-03).

### Starting a session (`POST /roles/:roleId/sessions`)

1. Check four things:
   - the role is assigned and Approved
   - the user's access hasn't expired
   - `sessionsUsed < maxAttempts`
   - if `requireAllCards` is set, every approved card has a `CardView`

   On a failure, return `403` with the matching code.
2. If a session is already in progress, return `409` with it.
3. Pick `questionsPerSession` approved questions, in fixed or random order. Insert `SessionQuestion` rows.
4. Snapshot the weights and the active prompt versions onto the session, so later config edits don't change old scores.
5. Store the `Consent`.
6. Render the intro with the interviewer prompt. A templated fallback is fine for R1. Return it with cached audio.

### Attempt pipeline (BullMQ queue `attempt`, concurrency per worker ≈ 10)

```ts
async function processAttempt(attemptId) {
  // 1. STT (voice only)
  // 2. metrics
  // 3. evaluate (LLM, schema-validated, 1 retry)
  // 4. score + persist, publish 'attempt.evaluated'
  // 5. TTS of spoken_summary → S3, publish 'feedback.audio_ready'
}
```

- **Upload.** The API streams the multipart audio straight to S3 (`audio/{sessionId}/{attemptId}.webm`), sets `audioExpiresAt = now + audioRetentionDays`, inserts the `Attempt`, enqueues, and returns `202`. Typed text skips STT.
- **STT.** Call `SttAdapter.transcribe(buffer, {language: 'en', wordTimestamps: true})` → `{text, words[{w, start, end}]}`. Log it to `AiCallLog`.
- **Metrics** (`scoring/metrics.ts`, pure functions):
  - `wpm` = word count ÷ (last word end − first word start) × 60
  - `fillerCount` = matches from a configurable lexicon (`um, uh, er, like (filler), you know, kind of, sort of, basically, actually, I mean`), with "like" counted only when it isn't a verb or preposition (simple heuristic in R1)
  - `pauseCount` = gaps > 1.0 s between words; `longestPauseS` = the longest gap
  - `durationS` = audio length

  Each value is mapped to `DeliveryMetric` using the target and scale config: pace 120–160 on a scale of 80–200, fillers 0–4 on 0–12, pauses 3–6 on 0–8. `valueText` and `note` come from simple templates ("172 wpm · a bit fast").
- **Evaluation.**
  1. Render the evaluator prompt with: the role title, the question, the rubric, the expected structure, the transcript wrapped in `<candidate_answer>` tags, the delivery metrics, and for attempt 2 the attempt-1 `improvement_points`.
  2. Call `LlmAdapter.json({model, temperature: 0.2, schema})`.
  3. Validate with Zod. On failure, retry once with the validation error appended. On a second failure, set `status = failed`, publish `attempt.failed {retryable: true, textModeOffered: true}`, and save.
- **Moderation.** Check the output against a hiring-decision blocklist (and the provider's moderation). A hit triggers one regeneration; a second hit fails safe with generic feedback text and the scores kept.
- **Scoring** (`scoring/score.ts`, pure, unit-tested):

  ```ts
  levelToScore = {1: 0, 2: 25, 3: 50, 4: 75, 5: 100}
  attemptScore = Σ dim(score) × dimensionWeights[dim] / 100
  learning = (Σ applied: 1, partly: 0.5, not_applied: 0) / points × 100   // attempt 2 only
  ```

- **TTS.** `TtsAdapter.speak(text, voice)`. The S3 key is `tts/{sha256(voice + text)}.mp3`, and the request is skipped if the key already exists.

The p90 budget for FR-FB-01 (8 s):

| Step | Budget |
| --- | --- |
| Upload | ≈ 0.5 s |
| STT | ≈ 1.5 s |
| LLM | ≈ 4 s |
| Persist and push | ≈ 0.2 s |

TTS runs after the push and is not counted. Track every step as an OTel span.

### Completing a session (`POST /sessions/:id/complete`)

1. Check every question is done.
2. Compute:
   - `A1` = mean of attempt-1 scores
   - `A2` = mean of attempt-2 scores, using the attempt-1 score where the retry was skipped
   - `L` = mean learning score (skipped retries count as 0)
   - `score = round(w1·A1 + w2·A2 + wL·L)` using `weightsSnapshot`
   - `band` from thresholds 85, 70 and 50
   - `skills` = the per-dimension mean over all attempts
3. Run the summariser prompt → `strengths[3]` and `focusAreas[3]`. Each item references a question; the server maps it to that question's card `position` to give `cardId`. Set `bandMessage` from the SRS 5.4 table.
4. Set `completedAt` and `durationS`. Refresh `assignment_stats`. Write the activity event. Optionally queue the session-complete email.

### WebSocket gateway

- **Connecting.** The client connects to `WS /ws/sessions/:id`. Authenticate with the cookie on upgrade and check that the user owns the session.
- **Delivery.** Workers publish to the Redis channel `session:{id}`, and the gateway relays to sockets.
- **Events:**
  - `attempt.transcribed`
  - `attempt.evaluated` (the full `Attempt` in the candidate UI shape, plus `applied[]`)
  - `feedback.audio_ready`
  - `attempt.failed`
- **Polling fallback.** Also available as `GET /attempts/:id`.
- **Future (FR-INT-05 live transcript).** Accept `audio.chunk` binary frames, proxy them to the streaming STT, and emit `transcript.partial`.

### Prompts (`modules/interview/prompts/`)

Three roles: `interviewer`, `evaluator` and `summariser`.

- **Storage.** Templates are stored in `prompt_versions`. They are seeded from `prompts/*.md` files on first migration, then edited only through the admin AI config.
- **Rendering.** Handlebars-style rendering with escaping. Candidate text is always placed inside delimiters, and the system prompt states that it is data.
- **Evaluator rules:**
  - stay a coach
  - no hiring verdicts
  - don't penalise accent or non-native grammar that keeps clarity
  - cite quotes from the transcript as evidence
  - give an opener only, never a full model answer (FR-FB-07)
- **Evaluator output schema** (Zod): see the spec doc's "AI interview pipeline". Add `highlights[{quote, kind: 'match'|'issue', note, rubricPointId?}]` for the admin session review.

---

## 7. Content and admin features

- **AI drafting** (`POST /admin/roles/:id/cards/draft-ai`, `/questions/draft-ai`)
  - Runs as a BullMQ job. The HTTP call waits up to 15 s, otherwise it returns `202` and the UI refetches.
  - The prompt takes the role title, the description (HTML stripped), key skills, seniority and the existing cards (to avoid duplicates).
  - Output: cards that pass the schema (tip ≤ 90 characters), or questions with rubric key points and red flags. They are inserted as `ai_draft`, and `lastAiDraftAt` is set.
- **Test evaluation** (`POST /admin/questions/:qid/test`): the same evaluator with the role's weights. The result is saved only as `questions.sample_evaluation`, never as an attempt.
- **Approve role**
  1. In one transaction, check the requirements: ≥ `max(5, questionsPerSession)` approved questions that have rubric key points and a card link, ≥ 1 approved card, and both weight groups summing to 100.
  2. Set the status.
  3. Then enqueue `tts-pregen` (the audio for every approved question) and the role-available emails to assigned candidates.
- **Preview session**: `isPreview = true`, owned by the admin. Every report and stats query filters with `WHERE NOT is_preview`.
- **Reports**: SQL in `reports/report.sql.ts`, using CTEs over `sessions` (completed, not preview, user not erased) joined with `assignment_stats`.
  - `GET /admin/reports?roleId&from&to&dateBasis=completed|invited`. The default is `completed`, which filters sessions by `completedAt` in the range.
  - With `invited`, the report covers the cohort of candidates whose invite `sentAt` falls in the range, with all their sessions.
  - CSV export takes the same parameter and prints it in the `Range` row.
  - The admin UI's Reports screen needs a date-basis toggle and a real date picker. The "needs attention" rule, the hardest questions (lowest average first try, minimum 3 asks) and the weakest-dimension note follow the admin UI's `services/reports.ts`.
- **CSV**: stream with `csv-stringify`. The column orders are exactly those in `exportCandidatesCsv` and `exportReportCsv`.
- **Settings**: `workspace_settings` is a single-row JSON document (it also holds `erasureGraceDays`, default 7), validated with the `WorkspaceSettings` Zod schema. Changing the audio retention updates `audioExpiresAt` for existing attempts in a background job.

---

## 8. Background jobs

| Queue | Trigger | Work |
| --- | --- | --- |
| `attempt` | attempt POST | STT → metrics → evaluate → TTS |
| `tts-pregen` | role approved, question edited | Question TTS, cached by hash |
| `email` | auth, invites, approvals | Render the template, send through `MailAdapter`, retry 3× with backoff |
| `ai-draft` | admin draft request | Draft cards or questions |
| `purge` | daily cron 02:00 | Delete S3 audio where `audioExpiresAt < now()` and null the keys; drop transcripts past `transcriptRetention`; expire invites and auth codes |
| `export` | admin export, candidate export | Build CSV or JSON files, upload to S3, email a signed link (expires in 24 h) |
| `erasure-hide` | candidate request (if `candidatesCanDeleteData`) or super admin deletion | **Stage 1, immediate:** set `users.deletedAt`, revoke auth sessions and close sockets, delete all of the user's S3 audio (answers and feedback), cancel pending jobs for their sessions, write an `ErasureReceipt`, and schedule `erasure-purge` after `erasureGraceDays` (default 7). From then on the candidate is gone from the candidate app, admin lists, reports, aggregates and CSV exports |
| `erasure-purge` | delayed job (grace period over), or super admin "erase now" | **Stage 2, permanent (DPDP Act 2023):** `DELETE FROM users` with the cascade from §4 (invites, codes, sessions, attempts and transcripts, card views, consents, activity, flags, privacy requests). Sweep S3 for any remaining `audio/{sessionId}/*` and export files that mention the user. Redact the user from `audit_logs` (`item_label` → "Deleted candidate", personal data stripped from `before`/`after`). Delete their data at third-party processors (configure zero retention with the LLM, STT and TTS vendors so there is nothing to delete). Set `ErasureReceipt.purgedAt`, then email a confirmation to the address on file before it is dropped |

Email templates (MJML or React Email) live in `src/jobs/email/templates/`:

- `login-code`
- `candidate-invite`
- `admin-invite`
- `role-assigned`
- `session-complete` (off by default)

Copy comes from the admin UI's email preview.

---

## 9. Frontend integration (later step)

Both UIs keep their screens and swap only the data layer.

**prep-candidate-ui**

1. Generate `lib/api-client.ts` from `openapi.json`. Re-implement each function in `lib/api.ts` on top of it, keeping the same names and return types.
2. Replace `lib/store.ts`:
   - `viewed` → `GET /roles/:id/cards`
   - `interviewing` and `drafts` → `GET /sessions/:id`
   - `sessions` → `GET /sessions`
3. Replace the server actions in `app/(auth)/actions.ts` so they proxy to `/auth/*` and forward the `Set-Cookie`. Alternatively, serve the API on the same site under `/api` and drop the proxy.
4. Delete `lib/session-builder.ts`, `buildApplied`, `generateAttempt` and the status derivation. The server is now the source of truth.
5. Upload the `MediaRecorder` blob on submit and open the WebSocket in `interview-flow.tsx`.
6. Read `audioRetentionDays` and the card count from the API instead of hard-coding them.

**prep-admin-ui**

1. Replace the bodies of `src/services/*.ts` with API calls, keeping the signatures. Delete `store.ts`, `fixtures.ts` and `latency.ts`.
2. Replace the hard-coded `adm_arjun` with `GET /admin/me`. Add the login screens: reuse the candidate auth flow, or add an `/admin/login` route on the same API.
3. Compute relative "last active" labels from real timestamps (`src/lib/format.ts` already does this); remove the fixed `TODAY`.

---

## 10. Canonical enums and UI mapping

| Concept | API value | Candidate UI | Admin UI |
| --- | --- | --- | --- |
| Band | `not_ready`, `developing`, `nearly_ready`, `interview_ready` | `not-ready`, `developing`, `nearly-ready`, `interview-ready` | `not_ready`, `developing`, `nearly`, `ready` |
| Applied status | `applied`, `partly`, `not_applied` | `applied`, `partly`, `not-yet` | `done`, `partial`, `missed` |
| Flash card id shown to the candidate | `position` (1-based) | `FlashCard.id: number` | `FlashCard.position` |
| Delivery | `wpm`, `fillerCount`, `pauseCount`, `longestPauseS`, `durationS` | `pace`, `fillers`, `pauses` metrics | `wpm`, `fillerWords`, `longestPauseSec` |

Mapping lives in the API's response serializers for R1, so the UIs need no type changes. A later cleanup should move both UIs to the canonical values.

---

## 11. Testing and acceptance

- **Unit**: scoring (weights, the skipped retry, band edges 49/50/69/70/84/85), metrics (filler lexicon, pauses), prompt rendering (injection delimiters), CSV column order.
- **e2e** (Testcontainers, fake adapters):
  - Login: an invited email logs in; an uninvited email gets the same response and no code; the rate limit holds; the code expires after 10 minutes and is single use.
  - A candidate sees only approved, assigned roles; others return 404.
  - The card gate, then start, then 5 × (attempt 1, attempt 2 or skip), then complete. The score matches a hand-computed fixture.
  - A refresh mid-attempt resumes correctly. An idempotent replay creates no duplicate.
  - Deactivation revokes the session at once.
  - Admin: invite CSV validation, approve requirements, report numbers against seeded sessions, the audit rows written.
- **Evaluator calibration** (SRS 5.5): a script runs ≥ 30 human-scored sample answers per role through the evaluator and reports agreement within ±1 level. The target is ≥ 80%.
- **Load** (k6): 100 concurrent sessions submitting attempts, with the real providers on a staging budget. Check feedback p90 < 8 s and question audio < 2 s (NFR-01/02). Read the cost per session from `ai_call_logs`; the target is < USD 0.50.

---

## 12. Milestones

| # | Milestone | Contents | Done when |
| --- | --- | --- | --- |
| M0 | Skeleton | Repo, docker-compose, config, Prisma schema + seed from the UI mocks, error filter, logging, CI | `GET /health` passes; seed loads 3 roles |
| M1 | Auth | OTP flow, sessions, guards, mail adapter (console + SES), rate limits | Candidate UI login works against the API |
| M2 | Admin content | Roles, cards, questions, approve and archive, audit, admin `me` | Admin UI roles and content editor run without mocks |
| M3 | Users and invites | Invites (single and CSV), assignments, deactivate, candidate list and detail, saved filters | Admin invites a candidate who then logs in |
| M4 | Candidate study | `GET /roles` with status, cards, card views | Dashboard and study screens run without mocks |
| M5 | Interview engine | Sessions, attempt upload, pipeline with real adapters, scoring, WS, complete, results, history | Full candidate journey end to end; acceptance criteria 3–6 pass |
| M6 | Reports and review | Session review, flags, reports, CSV exports | Admin reports and review screens run without mocks |
| M7 | AI authoring and settings | AI drafting, test evaluation, preview session, workspace settings, admins, AI config API | FR-ROLE-06/07 and super admin settings work |
| M8 | Privacy and hardening | Retention purge, export and delete requests, moderation, load test, calibration, Sentry and OTel dashboards | NFR targets met; acceptance criterion 8 passes |

M2/M3 and M4 can run in parallel after M1. M5 is the critical path.

---

## 13. Product decisions (2026-10-15)

| Question | Decision | Effect on implementation |
| --- | --- | --- |
| Data residency | India only | All infrastructure in AWS ap-south-1, DR in ap-south-2. Every provider must process in India (§1). Vendor check before M5 |
| Score visibility | Candidates see numeric score **and** band | Response shapes as specced; no change to either UI |
| Transcript access | Admins see all transcripts | No per-session consent gate. The consent text says "Your answers are recorded, analysed and may be reviewed by your admin team." |
| Admin structure | Multiple admins, one department | No `org_id`, no tenancy. Admin vs Super admin only |
| Report dates | Configurable: completion date or invite date | `dateBasis` parameter (§7); admin UI toggle needed |
| Candidate deletion | Comply with the DPDP Act 2023: erase the data | Two stages (§4, §8). Hidden at once with audio deleted, then a hard delete of all personal data after a 7-day grace period. Only an anonymous `ErasureReceipt` is kept |

DPDP notes for implementation:

- **Backups:** RDS snapshot and PITR retention is 35 days, with S3 versioning expiring noncurrent versions after 35 days. Erased data therefore leaves backups within 35 days. Never restore a backup without re-running the purge for every `ErasureReceipt` newer than the snapshot.
- **Logs:** application logs must not contain transcripts, emails or names. Log user and session ids only, and keep log retention ≤ 35 days.
- **Processors:** turn on zero data retention, or the shortest retention available, with the LLM, STT, TTS and email vendors. Record each vendor's DPA.
- **Still to confirm with counsel:** the legal deadline for completing erasure (7 days is assumed), and whether an anonymous receipt keyed by an email hash is acceptable proof.
