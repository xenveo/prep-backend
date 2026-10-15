# PrepPilot backend integration plan

Date: 2026-10-15. This plan records the original static review and implementation design. Source integration has since been implemented; see [INTEGRATION_PROGRESS.md](INTEGRATION_PROGRESS.md) for delivered behavior, review fixes and verification evidence. Runtime acceptance remains blocked by the execution environment.

## 1. Objective and source of truth

Connect `prep-admin-ui` and `prep-candidate-ui` to `prep-backend`, preserving the existing screens while replacing demo authentication, fixtures, browser-owned interview state, and simulated AI with the implemented API. Add the missing controls needed to operate those API workflows.

Use these references together:

| Reference | Purpose |
| --- | --- |
| [Admin agent guide](../prep-admin-ui/AGENTS.md) | Coordinator/Coder workflow, ownership, briefs, review gates |
| [Candidate agent guide](../prep-candidate-ui/AGENTS.md) | Candidate conventions and Next.js documentation requirement |
| [Backend agent guide](AGENTS.md) | Backend conventions, module boundaries, authorization and privacy rules |
| [Backend specification](docs/BACKEND_SPEC.md) | Product scope and UI/SRS decisions |
| [Backend implementation plan](docs/BACKEND_IMPLEMENTATION.md) | Architecture and §13 product decisions |
| Backend controllers, Zod schemas, serializers and service implementations under `prep-backend/src/` | What is actually available over HTTP today |
| `prep-admin-ui/src/lib/types.ts`, `src/services/*.ts`; `prep-candidate-ui/lib/types.ts`, `lib/api.ts` | Existing frontend entry points and view models |

The backend README is still the Nest starter README, and the backend implementation document still describes its initial scaffold status. Neither is evidence that endpoints are missing. Conversely, a route mentioned in a specification is not proof it exists. This document marks proposed additions explicitly. Product conflicts not settled by the existing decisions must be raised to the Coordinator rather than invented by a Coder.

Versioned copy: this document and codex/agents/ are stored in prep-backend; workspace-root convenience copies may also exist. This workspace contains three separate Git repositories and no root Git repository. Run checks in the relevant project. Future worktree isolation must be created per repository. The backend guide's instruction to treat sibling UIs as read-only applies to the backend Coder; frontend Coders own their respective applications.

## 2. Current state and integration risks

| Area | Observed implementation | Required integration |
| --- | --- | --- |
| Backend | Auth, content, invites, study, interviews, reports, settings, exports and privacy controllers exist | Consume existing endpoints; close the specific gaps in §7 |
| Backend runtime | PostgreSQL; optional Redis; fake AI/STT/TTS and console mail defaults | Prove local plumbing with fakes, then perform separate real provider acceptance |
| Admin authentication | `(admin)/layout.tsx` renders the shell; fixture store supplies `adm_arjun` | Add login, server-validated identity and role gates |
| Admin data | `src/services/{roles,candidates,sessions,reports,settings}.ts` mutate in-memory fixtures | Replace service bodies and adjust consumers where return contracts differ |
| Candidate authentication | Demo email stored as `pp_session`; any nonempty cookie passes the app layout; demo OTP succeeds | Let backend own the opaque cookie and validate with `/me` |
| Candidate data | Pages import fixture roles/cards/questions directly; `lib/store.ts` persists global `preppilot:v1` localStorage | Move server state to API; remove demo state and isolate transient state by authenticated user |
| Interview | Recorder exposes a playback URL; mock evaluation receives no audio; client builds IDs and final scores | Upload actual Blob; consume server session snapshots, asynchronous attempts and completion |
| Reports/review | Admin fixture numbers ignore real date filters; review assumes two tries and voice metrics | Display real aggregates, absent retries, nullable delivery and retained/expired audio |
| Content authoring | Role approval requires enough approved rubric questions linked to approved cards; UI question input has no linkage field | Add `cardId` type and selector, using admin card UUIDs; an individually approved question may still have null linkage |
| Privacy | Backend rights/export routes exist; candidate privacy controls are absent | Add export/deletion entry points and accurate policy/consent copy |

Changing `lib/api.ts` alone will leave candidate fixtures active. Migrate all direct consumers listed in §6.

## 3. Transport, authentication and deployment contract

### Chosen R1 topology

Use direct browser requests to the API on a compatible same-site origin. Locally use API `http://localhost:3000`, candidate `http://localhost:3001`, admin `http://localhost:3002`. In production use HTTPS hosts under a common site, with cookie settings reviewed for the chosen hosts. Use `localhost` consistently; do not mix it with `127.0.0.1`.

Introduce `NEXT_PUBLIC_API_BASE_URL=http://localhost:3000/api` and `API_BASE_URL=http://localhost:3000/api` in each frontend's `.env.example` during implementation. These are proposed frontend variables, not existing configuration. The public variable contains only a URL; backend credentials stay in backend env. A server-only base URL may differ in deployment, but URLs returned to the browser must remain publicly reachable.

Backend configuration already exists in [.env.example](.env.example), [app.setup.ts](src/app.setup.ts), and [csrf.guard.ts](src/common/auth/csrf.guard.ts):

- `APP_CANDIDATE_ORIGIN` and `APP_ADMIN_ORIGIN` are the exact allowed CORS origins. Requests use `credentials: "include"`.
- `PUBLIC_API_URL` controls public media links and is also in the mutation Origin/Referer allowlist.
- Backend issues `pp_session`: opaque, HttpOnly, `SameSite=Lax`, path `/`, Secure in production. `SESSION_COOKIE_DOMAIN` is optional. Choose a parent-domain cookie only if frontend server rendering must receive it across production hosts; otherwise plan a deliberate proxy/session-validation boundary.
- CSRF protection checks Origin/Referer. There is no CSRF token endpoint or header. Server-side mutation forwarding must preserve the original allowed Origin/Referer rather than bypassing the browser check.
- A frontend server request must explicitly forward the incoming session cookie to the API and use uncached per-user fetching. Browser `credentials` does not forward cookies for server-side fetches.

Choose one authentication implementation before coding: for R1, browser auth requests go directly to backend and receive its cookie. Replace candidate demo Server Actions with that flow; do not mint a second cookie. Validate protected server routes through `/me` or `/admin/me`, forwarding the incoming cookie when the deployment makes it available. If cookie scope cannot support server validation, resolve the proxy arrangement before shipping the route gate. Do not leave a cookie-presence gate as authentication.

Both frontends use `POST /auth/code`, `POST /auth/verify` and `POST /auth/logout`; there is no separate admin password or admin-login API. OTP body is `{ email, code }` with six digits; magic-link verification uses `{ token }`. Verify returns `{ result: "ok" | "wrong" | "expired" }` and sets the cookie only on success. Code request returns HTTP 200 with `{ result: "sent" }` or `{ result: "rate-limited", retryAfterSec }`; unknown emails deliberately look successful. Show actual cooldown, without revealing invitation eligibility.

After verification, candidate loads `/me`, admin loads `/admin/me`. Resolve nullable names to an appropriate email/initials label. Logout calls the backend (204), clears user caches/transient drafts, closes sockets and navigates to login. A 401 does the same session cleanup; 403 `access_expired` displays expiration; role mismatch or inaccessible resource is 404. Admin settings writes and account management must respect backend Super admin permissions.

### Frontend client contract to freeze first

Create one transport per application: proposed `prep-admin-ui/src/lib/api/{client,contracts,adapters}.ts` and `prep-candidate-ui/lib/backend/{client,contracts,adapters}.ts`. Keep these separate from component view models. No shared runtime package or new fetching dependency is required for R1.

The Coordinator freezes the concrete exported signatures in task briefs before consumers start. Minimum behavior:

```ts
type ApiErrorBody = {
  error: { code: string; message: string };
  [extra: string]: unknown;
};
// ApiError retains HTTP status, error code/message and the complete response body.
// request<T>(path, options?) handles JSON, FormData and empty success responses.
// download(path, options?) returns server bytes for CSV/file download.
// resolveApiUrl(path) resolves /api/... against the API origin, without doubling /api.
```

Handle 204 without attempting JSON parsing. Leave multipart Content-Type to the browser. Encode query arrays as repeated keys; omit undefined filters. Downloads are text/blob responses, not JSON. Use AbortSignal for stale reads and polling teardown. Do not automatically retry mutations except attempts with the same idempotency key. Do not fall back to fixtures after an API failure.

There is no checked-in OpenAPI document or configured Swagger generation. Start with explicit types traced to the backend schemas/serializers. Generating a client from a nonexistent `openapi.json`, as suggested in the older backend plan, is not an integration prerequisite. A future OpenAPI task must own generation and contract drift checks explicitly.

## 4. Candidate endpoint map

Paths below are relative to `/api`; use backend-issued identifiers. Existing API functions can keep compatible wrappers, but new lifecycle functions and changed async return types are necessary.

| Frontend operation | Implemented request | Response / adaptation |
| --- | --- | --- |
| `requestCode` / `verifyCode` | `POST /auth/code`, `POST /auth/verify` | Unwrap `result`; retain `retryAfterSec` rather than returning only a string |
| Identity / logout | `GET /me`; `POST /auth/logout` | Identity includes role, access expiry and `audioRetentionDays`; logout 204 |
| Dashboard | `GET /roles` | Roles with status, score/bands, attempts left and expiry |
| Role shell / prepare | `GET /roles/:roleId` | `cardsRequired`, `questionsPerSession`, `answerSoftLimitSec`, retry policy |
| `getCards` + study progress | `GET /roles/:roleId/cards` | `{ cards, viewed }`; existing wrapper returns only cards, so introduce a progress-aware operation |
| Mark viewed | `POST /roles/:roleId/cards/:cardId/view` | 204; `cardId` is candidate position, not UUID |
| Card audio | `GET /roles/:roleId/cards/:cardId/audio` | 302 signed media redirect |
| Start session | `POST /roles/:roleId/sessions` | 201 `StartedSession`; persist returned session ID in navigation |
| `getQuestions` replacement | Questions in start response and `GET /sessions/:id` | No candidate `GET /roles/:id/questions` route; use server session snapshots |
| Resume / results | `GET /sessions/:id` | In-progress/completed union; in-progress payload omits ID, so retain route ID |
| `submitAnswer` replacement | `POST /sessions/:id/questions/:questionId/attempts` | Multipart; 202 `{ attemptId }`, not a final `Attempt` |
| Attempt progress | `GET /attempts/:attemptId` | `transcribing`, `evaluating`, `done`, `failed`; final attempt/applied/followUp when available |
| Skip retry | `POST /sessions/:id/questions/:questionId/skip-retry` | 204; refetch authoritative session |
| Complete / abandon | `POST /sessions/:id/complete`; `POST /sessions/:id/abandon` | Complete returns report (200); abandon 204 |
| History | `GET /sessions?roleId=...`; `GET /roles/:roleId/sessions` | History across roles or role session summaries; fetch report by session ID |
| Answer / feedback / question audio | `GET /attempts/:id/audio`, `/attempts/:id/feedback-audio`, `/questions/:id/audio` | 302; handle 410 expired audio without losing transcript/report |
| Export personal data | `GET /me/export` | 202 `{ requestId }`; download link emailed, no immediate file |
| Request deletion | `POST /me/deletion-request` | 202 `{ requestId }`; show queued acknowledgement, not completed-erasure claim |

### Interview state and media

Start body is `{ mode: "voice" | "typed", consent: { recording: true, text, version } }`, including typed mode under the current schema. Persist the exact displayed versioned consent text through this request. Existing product decision requires copy explaining that answers are recorded, analysed and may be reviewed by the admin team. Show retention from `/me`, question count/soft limit from role detail and gate from `cardsRequired`. The API enforces access, card gate and session limits.

A 409 `session_in_progress` includes a sibling `session` object beside `error`. Preserve that extra body and resume it. Dashboard status alone does not identify the session: retain a known route ID, or use the start conflict to discover/resume the active session. Do not synthesize IDs or start a second local interview. For an interrupted first submission, use the same submission identity during network retry.

The recorder must return an actual Blob, MIME type, duration and optional playback URL. Upload FormData fields `attemptNo`, `mode`, `durationSec`, `text` for typed answers, and file field `audio` for voice. Header `Idempotency-Key` is required. The question ID is the one in the server session snapshot, not an array index. Keep the same key and payload for a transport retry; a new submission after terminal processing failure uses a new key. A timeout or abort does not prove that the server cancelled work: reconcile the session before resubmitting.

Limits are 1,500 typed characters, 300 seconds and 25 MiB. Accepted MIME types: `audio/webm`, `video/webm`, `audio/ogg`, `audio/mp4`, `audio/x-m4a`, `audio/mpeg`. Negotiate MediaRecorder support and display useful input errors. Revoke playback object URLs and stop media tracks on disposal.

Use polling as the correctness path after 202; add WebSocket events to reduce latency. Proposed polling policy: start around one second, back off to five seconds, stop on terminal status/navigation/logout, and provide a recoverable waiting state after a bounded foreground wait. Do not mark a server job failed solely because the browser wait ended.

Raw WebSocket is available at `/ws/sessions/:uuid` and `/api/ws/sessions/:uuid` on the API host, using the session cookie and an allowed Origin. Use `wss` in production. Server events are `attempt.transcribed`, `attempt.evaluated`, `feedback.audio_ready`, `attempt.failed`; client JSON `ping` receives `pong`. There is no Socket.IO, SSE, live audio upload or event replay. Deduplicate by attempt ID, tolerate late audio after evaluation, refetch session/attempt after reconnect, and handle close 4401 as revoked access. Voice R1 is record-then-upload; sending `audio.chunk` does not perform STT.

Render retry/skip/next from server results and `currentQuestion`. Typed delivery may be absent. Final completion is explicit and returns server scores, bands, learning, strengths/focus and card links. `/complete` synchronously awaits summarisation before HTTP 200, rather than returning a queued job. Show a completion loading state; after a timeout or refresh, reconcile `GET /sessions/:id` and retry the idempotent completion only if the session is still in progress. Remove runtime use of `buildSession`, `buildApplied`, `generateAttempt`, mock scoring and mock status derivation. Comparison uses server attempts, with a missing second try represented honestly.

## 5. Admin service-to-endpoint map

All paths are relative to `/api`. Preserve existing service entry points where possible; revise explicit incompatible contracts with their consumers. Presentation helpers such as `sampleInviteCsv`, date labels and `weakestDimension` remain local utilities.

| Service / operation | Implemented request | Integration detail |
| --- | --- | --- |
| roles: list/get/create/update | `GET /admin/roles`, `GET /admin/roles/:id`, `POST /admin/roles`, `PATCH /admin/roles/:id` | UUID paths; list optional status; settings patch contains complete settings object |
| requirements / approve / archive | `GET /admin/roles/:id/approve-requirements`; `POST .../approve`, `POST .../archive` | Display server requirement checklist/counts; do not reproduce mock approval logic |
| cards: list/save | `GET/POST /admin/roles/:id/cards`; `PUT /admin/cards/:cardId` | Existing `saveFlashCard` branches create/update by input ID |
| reorder / approve / discard | `PUT /admin/roles/:id/cards/order` `{ orderedIds }`; `POST /admin/cards/:id/approve`; `DELETE /admin/cards/:id` | UUIDs; discard 204; refetch counts/order after mutations |
| AI card draft | `POST /admin/roles/:id/cards/draft-ai` `{ count }` | 200 result or 202 job ID; blocked on gap G1 for reliable async completion |
| questions: list/save | `GET/POST /admin/roles/:id/questions`; `PUT /admin/questions/:qid` | Extend frontend question/input with `cardId: string | null`; save explicit selected card UUID |
| additional question controls | `POST /admin/roles/:id/questions/draft-ai`; `DELETE /admin/questions/:qid` | Existing API, new frontend service/control if included; same G1 for drafts |
| sample evaluation | `POST /admin/questions/:qid/test` `{ answer }` | Real `TestEvaluation`; no mock length-derived scores |
| preview interview | `POST /admin/roles/:id/preview-session` | Same start consent contract; real preview session excluded from aggregates; see G3 |
| candidates: list/get | `GET /admin/candidates`; `GET /admin/candidates/:id` | List `{ rows, total, totalUnfiltered }`, not cursor pagination |
| validate invite / context | `POST /admin/invites/validate` `{ rows }`; `GET /admin/invites/context` | Validation rows contain role names; response `{ rows, summary }` |
| send / resend invites | `POST /admin/invites`; `POST /admin/invites/resend` `{ candidateIds }` | Invitation rows use role IDs; retain backend bulk counts/errors |
| revoke / deactivate / reactivate | `POST /admin/candidates/:id/revoke-invite`; `POST /admin/candidates/deactivate`, `/reactivate` `{ ids }` | Revoke 204; bulk success/skipped counts come from API |
| assign / remove role | `POST /admin/candidates/assign-roles` `{ ids, roleIds }`; `DELETE /admin/candidates/:id/roles/:roleId` | Remove 204; follow server draft/approved/archived policy |
| candidate/assignment edits | `PATCH /admin/candidates/:id`; `PATCH /admin/candidates/:id/roles/:roleId` `{ maxSessions }` | Available if controls are added; no direct fixture mutation |
| saved filters | `GET/POST /admin/saved-filters` | User-owned; save original filter schema, not flattened HTTP query |
| candidate CSV | `GET /admin/candidates/export.csv` with repeated `ids` | Server CSV; endpoint does not accept candidate search/filter query |
| session review | `GET /admin/candidates/:cid/sessions/:sid` | Handle one or two tries, nullable delivery, signed `audioUrl` |
| submit/list/resolve flags | `POST/GET /admin/sessions/:sid/flags`; `PATCH /admin/flags/:id` | Resolve `{ status: "resolved", resolution }`; keep exact server dimension/issue enums |
| report / report CSV | `GET /admin/reports`, `GET /admin/reports/export.csv` | Required role UUID; `from`, `to`, `dateBasis=completed|invited` |
| workspace settings | `GET/PATCH /admin/settings` | GET both admin roles; PATCH Super admin only; omit read-only fields |
| current admin / admin list | `GET /admin/me`; `GET /admin/admins` | Replace fixture identity; nullable name; server access enum |
| invite/resend/access/remove admin | `POST /admin/admins`; `POST /admin/admins/:id/resend`; `PATCH/DELETE /admin/admins/:id` | Super admin only; backend enforces self-removal/last Super admin constraints |
| audit/actions | `GET /admin/audit`; `GET /admin/audit/actions` | Audit envelope `{ rows, nextCursor, total }`; paginate or deliberately unwrap first page with visible continuation |
| workspace export | `POST /admin/exports`; `GET /admin/exports/:id` | Start `{ exportId, lastExportAt }`; poll queued/running/done/failed/expired; files expire after 24 hours |
| privacy request operations | `GET /admin/privacy/requests`; `POST /admin/privacy/requests/:id/complete` | Super admin only; cursor envelope; new admin controls needed |
| voice sample / AI config | `GET /admin/settings/voices/:voice/sample`; `GET/PUT /admin/ai-config` | Sample redirects; AI config Super admin only, separate from workspace settings |

Candidate filter HTTP encoding is flat: map UI `sort: { columnId, direction }` to `sort` and `dir`, with repeated `roleIds`, `bands`, `statuses`. Saved filters keep their nested shape. Audit/privacy default page limit is 200, maximum 500; do not silently truncate an existing all-events view.

Invite validation body uses `{ email, name, roles: string[] }` (role names). Actual invite body uses `{ source, fileName?, rows: [{ email, name, roleIds }], accessUntil?, maxSessions? }`. Date-only `accessUntil` ends at 23:59:59.999 UTC on that date under the backend contract. Avoid changing that date through local timezone conversion.

Reports must pass the same date basis/range to the report and export. Replace the fixed October 2026 `TODAY`/`NOW_ISO` and illustrative fixture statistics. Foundations owns `prep-admin-ui/src/lib/format.ts`: freeze current-time and timezone behavior instead of its fixed-date defaults and wall-clock parsing that ignores ISO offsets. The admin owner also updates date presets in `src/features/settings/audit-section.tsx`. The backend seed creates no sessions, so legitimate empty reports must render correctly. Keep PDF disabled until an implementation is explicitly assigned.

`exportAllData()` currently only updates a fixture timestamp. Extend it and its consumer to retain export ID, poll status and expose downloadable files. Candidate personal export is a different emailed workflow. Downloads must not imply completion merely because the start request succeeded.

## 6. View models and mock removal

| Contract difference | Resolution |
| --- | --- |
| Candidate roles accept slug/UUID; admin route IDs are UUIDs | Use IDs returned by the relevant API; remove fixture ID translation and manufactured session IDs |
| Candidate cards use positional numeric IDs; admin cards use UUIDs | Preserve both contracts; candidate position is role-scoped display/navigation data, not an admin mutation key |
| Question `cardId` in candidate projection can be 0 when unlinked | Do not render a link to card 0; support valid linkage in authoring and show server role-readiness requirements |
| Candidate card fields `strong`/`mistakes` vs admin `strongAnswerPoints`/`commonMistakes` | Backend already serializes each view; do not remap fields twice |
| Candidate bands `not-ready`, `developing`, `nearly-ready`, `interview-ready`; admin `not_ready`, `developing`, `nearly`, `ready` | Keep serializer-specific enums; canonical DB enums are internal |
| Candidate applied `applied/partly/not-yet`; admin `done/partial/missed` | Consume the projection for that frontend |
| Admin review assumes `[Try, Try]` and non-null delivery | Change to variable-length tries and nullable metrics; add `audioUrl: string | null`; never invent a second recorded answer |
| Candidate score averages local best tries | Replace with server report; server uses configured scoring/snapshot rules including skipped retries |
| Admin question model omits backend `cardId` | Add the field and selector before role approval acceptance |
| Admin profile names/updated-by may be null | Render fallback labels; remove fixture assumptions |
| Relative `/api/...` media paths | Resolve against API origin; keep signed URLs transient, reacquire through authenticated routes when available |

Candidate files that bypass the API today:

- `lib/store.ts`: fixture roles/sessions, local progress/drafts/completion. Replace with server-backed state; clear the legacy `preppilot:v1` data rather than importing demo sessions into real accounts.
- `lib/user.ts`, `app/(auth)/actions.ts`, `app/(auth)/layout.tsx`, `app/(app)/layout.tsx`, `app/(app)/page.tsx`: demo identity/session checks.
- `app/(app)/roles/[roleId]/layout.tsx`, `prepare/page.tsx`, `study/page.tsx`, `interview/page.tsx`: fixture role/card/question loading.
- `components/prep/{dashboard,study,prepare,interview,results,history}/`: local-store consumers; specifically `interview/interview-flow.tsx` imports mock AI and `session-builder.ts`.
- `components/prep/shell/top-bar.tsx`, `components/prep/results/results-view.tsx`, `components/prep/history/history-view.tsx`: fixture role lookups.
- Recorder in `components/prep/interview/use-recorder.ts`: expose audio bytes, not just object URL. `hooks/use-speech.ts` is browser text-to-speech; integrate server audio playback in its consumers, with any browser fallback explicitly defined.

Admin removal covers runtime imports of `src/services/{store,fixtures,latency}.ts` and `src/data/sample-data.json`. Keep deliberate component-sheet examples isolated from production flows. Remove fake offsets/averages and client audit creation; the server writes mutation audits. Preserve genuine formatting/band helpers and other presentation-only code. Delete mock modules only after checking all imports.

Use existing loading, empty and error components. Disable duplicate mutation controls, show field errors, preserve unsaved forms when requests fail, and refetch affected role counts/candidate/report state after successful mutations. Do not introduce a visual redesign as part of this integration.

## 7. Contract gaps and decisions before dispatch

| ID | Finding | Planned resolution / gate |
| --- | --- | --- |
| G1 | AI card/question draft may return 202 `{ jobId }`; no HTTP job-status controller exists | Backend Coder adds an authenticated admin-owned job status/result contract before reliable drafting is accepted. Proposed `GET /admin/ai-jobs/:id` with `queued/running/done/failed`, result rows or safe error code. Coordinator must freeze result type, ownership, storage/TTL and both in-memory/Redis behavior. This route does not exist yet. Content-list polling alone cannot attribute completion/failure to a job. |
| G2 | Candidate `/me` has retention but no `candidatesCanDeleteData` policy; no privacy screens | Extend `/me` with a narrowly scoped policy field (proposed) or freeze a dedicated safe policy endpoint. Candidate owner adds export/deletion UI; server still enforces policy. No candidate status endpoint exists; show acknowledgement and emailed export outcome accurately. |
| G3 | Admin preview endpoint exists, but current preview screen is a local authoring preview | Preserve the existing preview and add a real test-session launch. Decide an admin-owned preview runner route before dispatch; reuse backend attempt lifecycle without sending admins through candidate-only routes. Preview session stays excluded from reports. |
| G4 | Admin UI lacks full AI config and privacy request operations; exports are timestamp-only | Settings owner adds Super admin controls/services for existing endpoints, including export completion, request management and AI config. These are required operational additions within integration scope. |
| G5 | No OpenAPI artifact and several UI types differ from actual API | Use explicit transport contracts and view adapters now; add OpenAPI only as a separately assigned improvement. |

The API does not provide live audio streaming, SSE, hiring decisions, public signup or PDF reports. The integration must not present those as working features. Follow-ups beyond existing product scope need a separate task.

## 8. Execution phases and agent ownership

The workflow follows the admin guide: one Coordinator plans and reviews, normally 2–5 Coders implement independent tasks. Read `codex/agents/README.md` for the supplied agent roles. The files define behavior; each dispatch must still name an exact ownership set. Directory scopes below are planning boundaries that the Coordinator expands into concrete paths before launch.

| Phase / task | Owner | Planned files / responsibility | Dependencies and completion gate |
| --- | --- | --- | --- |
| P0: contract freeze | Coordinator | This plan, task briefs and ownership ledger; decide topology and G1–G4 interfaces | Record HTTP/view signatures, auth flow, preview route and error behavior before consumers start |
| P1-B: backend gaps | `backend_coder` | Only assigned files under backend content/jobs/auth schemas/privacy as needed; `app.module.ts` or shared files assigned explicitly | G1 async contract and G2 policy projection available; no unassigned schema edits |
| P1-T: frontend foundations | `coder` | Proposed transport folders; `prep-admin-ui/src/lib/{types,format}.ts`; `prep-candidate-ui/lib/{api,types,store,user}.ts`; each frontend `.env.example` | API errors, multipart/download support, current-time formatting and authoritative store interfaces frozen; may run beside P1-B against agreed signatures |
| P2-AUTH: both app auth | `coder` | Admin new `src/app/(auth)/**`, protected layout, auth helpers; candidate auth actions/layout/components and protected root layout/page | Depends P1-T. Explicitly list files, including shell consumers; validate role/session server-side |
| P2-A: admin workflows | `admin_coder` | `src/services/{roles,candidates,sessions,reports,settings}.ts`, corresponding `src/features/**`, assigned media components and preview route | Depends P1-T; draft/policy consumers wait for P1-B. Real content/invites/review/reports/settings/export/preview |
| P2-C: candidate workflows | `candidate_coder` | `app/(app)/roles/**`, history/privacy routes; `components/prep/{dashboard,study,prepare,interview,feedback,compare,results,history}/**`, explicitly including `interview/use-recorder.ts`; assigned audio playback hooks | Depends P1-T; consumes agreed auth interfaces. Real study, attempts, retry/skip/resume/results/history/privacy |
| P3: review and acceptance | `reviewer`, `qa`, Coordinator | Read-only review and validation; fixes go back to the responsible Coder | Gates in §10 pass; blockers and evidence recorded |

P2-AUTH, P2-A and P2-C can run together after foundations only when file sets do not intersect. The foundations owner retains candidate `lib/*`, admin `src/lib/types.ts` and transport ownership throughout; consumer Coders request interface fixes through the Coordinator. Serialize `src/services/settings.ts` between auth identity wiring and admin settings work. Assign candidate shell files once. Never split `roles.ts` between role/content Coders concurrently.

Backend shared files (`app.module.ts`, `common/`, `schema.prisma`, migration files) have one named owner. Database changes require an explicit schema owner and migration sequencing. The Coordinator may author documentation, contracts and tiny stubs, but delegates feature implementation. Worktrees are optional when supported; use them for adjacent edits/build interference, and never run e2e suites concurrently against one database. All agents share a workspace unless isolation has actually been established.

Every brief contains:

```text
Goal:        one concrete result and reason; cite task/gap/requirement
Files owned: exact paths to create/edit; no overlapping ownership
Contract:    DTOs, signatures, response envelopes, states, error codes
Context:     source files, applicable AGENTS.md and documentation
Constraints: dependencies, schema owner, no unplanned packages or git mutations
Done when:   observable behavior and project-specific commands
Report:      files changed, commands/results, deviations, blockers, open questions
```

Coders must be told that they are not alone in the codebase and must accommodate others' edits. They request reassignment for out-of-scope edits. Reviewers/QA report findings; Coders implement fixes. No agent commits, pushes, resets or changes branches without the user's instruction.

## 9. Local setup and staged rollout

The following are implementation/acceptance instructions, not commands executed during this planning task.

1. In `prep-backend`, copy `.env.example` to a local `.env` if absent, configure secrets locally, and start PostgreSQL with `docker compose up -d postgres`. Use `PROCESS_ROLE=all`, fake providers, console mail and local storage initially. Redis/MinIO are optional for this single-process configuration.
2. With dependencies installed, run `npm run prisma:generate`, `npm run prisma:deploy`, then `npm run prisma:seed` against a disposable development database. The seed is idempotent but is development data; inspect it before targeting any populated database. It provides content/admins/candidates and no completed interviews. `SEED_ADMIN_EMAIL` can add a known Super admin. `demo.candidate@example.com` and `demo.candidate2@example.com` are seeded candidates. The console mail adapter writes development `.eml` messages under `LOCAL_STORAGE_DIR/outbox` (default `prep-backend/.data/storage/outbox`); logs contain message IDs, not OTPs. Read actual OTP/magic-link mail there, not frontend demo codes, and keep these private files out of source control.
3. Run `npm run start:dev` in backend. After frontend integration env is added, run candidate `npm run dev -- --port 3001` and admin `npm run dev -- --port 3002` in separate terminals. Confirm `/api/health`, origins and public media reachability.
4. First accept login → admin content/invite → candidate study → typed interview → report/review. Then accept voice upload/playback, reconnect/recovery, authoring jobs, exports and privacy. Make completed sessions through real API flows to exercise report data.
5. For split API/worker or multiple instances, configure shared `REDIS_URL`, `PROCESS_ROLE=api` for HTTP and `PROCESS_ROLE=worker` for workers. Use `node dist/worker.js` after build; backend `start:worker` currently omits `.js`, so validate that script before relying on it. Process-local queues/events/rate limits are unsuitable for separate processes.
6. Before production acceptance, use the selected real providers and production-like storage/media routing. Fake STT/TTS/LLM passing proves transport and state handling only. Preserve existing India-hosting/provider requirements from the backend product decisions; provider readiness is a separate release gate, not established by this static audit.

Roll out to seeded/internal users first. Monitor request/worker failures by IDs without logging names, email, transcripts or answer text. Rollback is deployment rollback of affected clients/API versions with compatible contracts; never reactivate fixtures as a production fallback or undo real candidate progress through browser state.

## 10. Verification and completion criteria

During implementation, each frontend Coder runs `npm run typecheck` and `npm run lint` in the affected frontend. Backend Coders run `npm run typecheck`, `npm run lint`, `npm test`; the Coordinator sequences backend `npm run test:e2e` against a disposable PostgreSQL database and runs `npm run build` in all three applications. The frontend packages currently have no test script: do not invent one in a brief or report a nonexistent suite as passed. Add focused coverage only where it verifies meaningful behavior, such as idempotent recovery or nullable review data.

| Acceptance journey | Evidence required |
| --- | --- |
| Authentication | OTP/magic link success, wrong/expired code, cooldown, unknown email response, reload validation, logout and expired/revoked sessions; candidate cannot open admin data |
| Admin authoring | Create role/cards/questions, link questions to cards, real approval requirements, reorder/discard, approve/archive, slow/failed AI drafts, sample evaluation and preview exclusion |
| Invites/assignment | CSV validation including duplicate/invalid rows, send/resend/revoke, assignment/removal, deactivate/reactivate, saved filters and real account eligibility |
| Study and permissions | Approved assigned roles only; progress persists after reload/login; variable card counts; optional card gate; access/attempt limits enforced by server |
| Typed interview | Start with consent, async evaluation, retry and skipped retry, explicit completion; numeric scores/bands agree between candidate and admin |
| Voice/media | Actual uploaded Blob is processed; feedback arrives before/after audio; browser denial offers typed mode; signed/expired audio handled |
| Recovery | Duplicate click/network retry does not duplicate attempts; 409 resumes active session; refresh and reconnect reconcile pending/failed work; slow completion/uncertain response reconciles through session GET before retry; next user sees no prior user's data |
| Admin review/reports | Typed/null delivery, absent second try, flags/resolution, empty reports then real completed data, date basis/range filters, server CSV selection and download |
| Settings/privacy | Super admin restrictions, nullable identity, real audit pagination, voice sample, AI config, workspace export done/failed/expired, candidate emailed export and deletion acknowledgement |
| Mock removal | No production imports/calls to fixture stores, demo auth, mock AI/session-builder or global demo state; component demos remain isolated |

Done means the relevant journeys pass against the real API, checks pass with exact evidence, and no unresolved contract gap is hidden behind a simulated success. This document and agent definitions do not claim that those implementation gates have passed.
