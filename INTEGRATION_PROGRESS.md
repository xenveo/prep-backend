# Integration implementation ledger

Started: 2026-10-15. User authorized implementation using `codex/agents/README.md`.

## Frozen decisions

- The primary session acts as Coordinator. Workers read the supplied TOML instructions directly; custom roles have not been installed into `.codex` during this session.
- Local origins: API `http://localhost:3000/api`, candidate `http://localhost:3001`, admin `http://localhost:3002`. Browser auth requests go directly to API with credentials. Protected server rendering validates forwarded `pp_session` through the API, never by cookie presence. Production server gates require an appropriate shared cookie domain.
- Frontend transports export `ApiError` retaining status/code/full body; `request`, `download`, `resolveApiUrl`, `apiUrl`, `queryString`. Callers serialize JSON explicitly. FormData keeps the browser's boundary header.
- Candidate navigation uses `/roles/:roleId/interview?sessionId=:uuid`. Sessions/questions/scores/progress originate on the backend. Completed reports and in-progress state remain distinct DTOs.
- G1: admin-owned `GET /api/admin/ai-jobs/:id` returns `{ status: queued|running|done|failed, result?, code? }`; terminal results expire after 24 hours and may be evicted earlier by bounded retention. Missing or another owner's job is 404. Both queue implementations support lookup.
- G2: `GET /api/me` includes `candidatesCanDeleteData`. Candidate export remains emailed; deletion remains an acknowledged request until processed.
- G3: a separate admin test route consumes preview sessions and regular owner-scoped attempt endpoints; existing content preview remains available.
- Consent has a stable version and exact displayed text explaining recording, analysis and admin review. The current backend requires consent for both typed and voice starts.

## Ownership and dependencies

The exact ownership sets are recorded in each dispatched brief. These boundaries remain exclusive; new paths require Coordinator assignment.

| Task | Owner | Boundary | Status |
| --- | --- | --- | --- |
| P1-B | backend_implementation | Queue types/implementations/specs, content job-status controller/module/spec, auth me/service/spec, worker script | Implemented; reviewed |
| P1-T | foundations | Both transport/contract folders and env examples; admin types/format; candidate types/api/store/user | Implemented; reviewed |
| P2-AUTH | auth_implementation | Both auth routes/components, server identity helpers, protected layouts and shell identity/logout | Implemented; reviewed |
| P2-A | admin_implementation | Admin roles/candidates/reports/session services and their authoring/review/report consumers | Implemented; reviewed |
| P2-A settings | admin settings child | Admin settings service and existing settings feature files | Implemented; reviewed by admin owner and independent reviewer |
| P2-A preview | admin preview child | New preview service/runner/test route and existing preview screen | Implemented; typed preview runner |
| P2-C | candidate_implementation | Candidate role/history/privacy pages; dashboard/study/prepare/interview/feedback/comparison/results/history components and media hooks | Implemented; reviewed |
| P3 | reviewer / QA, then owning Coders | Read-only review and verification; fixes return to original owners | Source review findings resolved; runtime acceptance environment-blocked |

Admin settings and preview work are independent child tasks; this temporarily exceeds the usual 2–5 Coders to avoid serializing separate UI workflows. Shared files stay with foundations. Authentication does not edit the admin settings service. No two workers own the same file. All workers were told to preserve concurrent edits and avoid Git-state mutations.

Pre-existing candidate changes observed before implementation: `components/prep/auth/code-entry.tsx`, `components/prep/chip.tsx`, `components/ui/button.tsx`. Preserve them; auth edits to code-entry must build on the user's working copy.

## Runtime acceptance (2026-10-16)

Run on a machine with permitted networking. The backend Coordinator worked with one agent per frontend repository, all on fake LLM/STT/TTS providers and console mail.

**Setup.** The API runs on **:4000** because another local project holds :3000. Backend `.env` sets `PORT=4000` and `PUBLIC_API_URL=http://localhost:4000`. Both frontends have a gitignored `.env.local` pointing at `http://localhost:4000/api`. `prep_db` was migrated and seeded. A separate `prep_db_e2e` (migrated and seeded) runs e2e via a `DATABASE_URL` override, so the dev data stays untouched. Redis is not configured, so queues are in-process.

| Check | Result |
| --- | --- |
| Backend typecheck, lint, build | Passed |
| Backend `npm test` (full, socket tests included) | 75 files / 584 tests passed |
| Backend `npm run test:e2e` (against `prep_db_e2e`) | 7 files / 77 tests passed |
| Admin typecheck (now `next typegen && tsc --noEmit`), lint, build | Passed; 26/26 pages |
| Candidate typecheck, lint, build | Passed; 9/9 pages |
| Candidate journeys in headless Chrome | Passed: OTP (wrong, cooldown, unknown email), study persistence and card gate, typed interview with retry/skip/double-submit/409 resume/reload, voice upload with WS event order and playback, mic denied → typed, abandon, logout invalidation, second-user isolation (404s), export and deletion requests |
| Admin journeys (API and SSR) | Passed: auth/CSRF/role refusal, authoring and card linkage, approval requirements, preview exclusion, invites/revoke/resend/deactivate/assign, saved filters, CSVs, session review, flags, reports (incl. empty range), settings, admins, audit paging, AI config, workspace export |
| Cross-check | Session score 39 (A1 49, A2 49, L 10) agrees between the candidate report, admin review and reports, and with the hand-computed SRS formula |

**Fixes made during acceptance**

- *Backend:*
  - Removed admins and revoked candidates can be re-invited.
  - Hidden users' emails count as taken in invite validation and are never sent to the client.
  - Audit and privacy-request lists use a keyset `(timestamp, id)` cursor.
  - Privacy export completion is race-safe and returns 409 while an export is in flight.
  - Export status reaches `failed` only on the last retry.
  - The export-ready email links to `/settings/privacy?exportId=`.
  - New `POST /admin/candidates/export.csv {ids}`, max 5000, with a 256 KB JSON body limit.
  - Session review returns `secondScore: number | null` plus `retrySkipped`.
  - Report `stats.change` is null without a repeat session.
  - `approvedQuestions` counts only qualifying questions.
  - Testing a question on an archived role returns 409.
  - CORS exposes `Content-Disposition`.
  - The e2e `/me` assertion was updated for `candidatesCanDeleteData`.
- *Admin UI:*
  - typecheck script.
  - Saved filters chosen by `isDefault`/query.
  - Bogus band values tolerated; Revoked filter added.
  - Skipped-retry and null-second-score rendering.
  - Server CSV filenames.
  - POST CSV export.
  - `?exportId=` export page.
  - Friendly settings errors.
- *Candidate UI:* no changes.

**Not covered here.**
- Real providers and India residency.
- The AI draft 202/job-status path and the AI quota 429, which can't be reached with the fake LLM.
- Privacy-complete 409 with an export in flight (unit-tested only).
- Natural OTP expiry.
- Split API/worker with Redis.

**Known limitation.** With the in-process queue, a process restart drops in-flight jobs. An export was seen stuck in `running` after a watch-mode restart. BullMQ retries stalled jobs. A startup recovery sweep is an open follow-up.

**Open product questions.**
- Audit action labels include counts ("Sent 3 invites"), which fragments the Action filter.
- Admin candidate progress compares scores across roles.
- The typed-answer "Delivery" score measures writing clarity but is unlabeled.
- Abandoned sessions don't count toward the session limit.

## Verification evidence (sandboxed run, 2026-10-15)

- Local PostgreSQL process listens on port 5432, but both TCP connections and `/tmp` Unix socket connections are denied with `EPERM` by the execution sandbox. No database was provisioned, migrated or seeded by the Coordinator. Database-backed e2e and browser journeys remain blocked until a permitted connection is available.
- Standard builds in both frontends fail inside the Turbopack CSS worker with port-binding `EPERM`. Both supported webpack alternatives fail resolving `fonts.googleapis.com` for the existing Google font dependencies (`Plus Jakarta Sans`, and candidate `Geist Mono`). Neither failure proves an application compile defect; neither counts as a successful production build.

| Check | Result |
| --- | --- |
| Backend `npm run typecheck`, `npm run lint`, `npm run build` | Passed |
| Backend focused queue/auth/job-controller tests | 5 files / 73 tests passed |
| Final backend `npm test -- --exclude src/modules/interview/pipeline/session.gateway.spec.ts` | 73 files / 527 tests passed |
| Earlier full backend `npm test` | Five socket tests failed because `listen` is denied with `EPERM`; not a full-suite pass |
| Admin `npm run typecheck`, `npm run lint` | Passed; zero lint warnings |
| Candidate `npm run typecheck`, `npm run lint` | Passed; zero lint warnings |
| Coordinator's final combined frontend typecheck/lint/diff checks | Passed in both projects after all review fixes |
| Admin and candidate default builds / webpack alternatives | Blocked by Turbopack port-binding `EPERM` / Google Fonts DNS `ENOTFOUND`, respectively |
| `git diff --check` in all three projects | Passed |
| Foundation isolated behavior harness (`/tmp/preppilot-foundation-check.cjs`) | Passed: stale identity after logout, identity errors, refresh, 204/errors/credentialed multipart/query transport, timestamp offsets |
| Candidate hook harness (`/tmp/candidate-flow-check.cjs`) | Three cases passed: lost second-attempt response, restored pending WebSocket completion, lost skip-retry response |
| Authenticated browser journeys, PostgreSQL e2e, actual recording/playback and live providers | Not run: local networking/listening denied; not established by static or mocked checks |

The temporary harnesses are validation evidence from this session, not committed test suites or new project dependencies.

## Delivered behavior

- Backend: admin-owned draft-job status for both queue implementations, bounded outcome retention with safe failures, candidate deletion policy in `/me`, and corrected worker entrypoint.
- Both frontends: real OTP/invitation login, backend session ownership, server identity/role validation, logout/invalidation, credentialed transport, full errors, multipart/download support and environment templates.
- Admin: real services and consumers for content, card linkage, drafts, candidates/invites, review/audio/flags, report ranges/date basis/CSV, Super admin prompt configuration/privacy/export, audit pagination and typed test interviews.
- Candidate: server study progress and policy, persisted versioned consent submission, actual recorded Blob upload, idempotent asynchronous attempts, WebSocket updates with polling recovery, retry/skip/completion, server reports/history/privacy controls and server audio playback.
- Production paths no longer import demo stores, mock scoring, local session builders or fixture auth. Existing demonstration modules remain isolated where needed for the component sheet.

Review fixes include terminal queue snapshot races, avoiding retained email/attempt payloads, initial account-cache isolation, uncertain attempt/skip completion, historical report access after role removal, progress chronology, autosave ordering/retry and stale audio teardown/error state.

## Run and finish acceptance in a permitted environment

1. Use the three-port setup in [INTEGRATION_PLAN.md §9](INTEGRATION_PLAN.md#9-local-setup-and-staged-rollout). Each frontend now has `.env.example`; defaults target the local API. Backend prerequisites, migrations and development seed remain as documented there. This implementation adds no database migration.
2. Start backend, candidate on 3001, and admin on 3002. Read development OTP/invite messages from backend `.data/storage/outbox` when using console mail. Do not use old frontend demo codes.
3. Exercise the acceptance journeys in [INTEGRATION_PLAN.md §10](INTEGRATION_PLAN.md#10-verification-and-completion-criteria), then run backend e2e and all standard builds with permitted local networking and Google Fonts access.
4. Before production, set the public/server API URLs and compatible HTTPS origins/cookie domain. Browser recording requires an allowed secure context. Validate signed storage downloads/media routing and real provider behavior separately from fake adapters.

Admin test interviews currently accept typed answers. Candidate interviews support typed and recorded voice answers. Server consent storage retains the consent version through the existing backend schema; this integration passes the displayed text and version in the start request. No migration, provider deployment, Git commit or push was performed.

See [INTEGRATION_PLAN.md](INTEGRATION_PLAN.md) for endpoint mappings and acceptance journeys. Source implementation is complete; release acceptance still requires the environment-dependent checks above.

## Repository handoff

The integration documents and agent definitions are now versioned in `prep-backend` at the user’s request. Workspace-root copies remain available as convenience copies. Commit/push status is reported in the conversation; earlier no-commit statements above describe the implementation stage.
