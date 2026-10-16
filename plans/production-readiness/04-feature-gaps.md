# 04 · Feature gaps

These are SRS features that aren't built yet, checked against the code on 2026-10-16, plus the product changes decided after acceptance. The user set the scope on 2026-10-16 (D5): **R1** = build now, **Deferred** = after R1, **Later** = no plan yet.

| # | Item | Source | Scope | Repos |
| --- | --- | --- | --- | --- |
| F1 | Cost per session view | NFR-10 | **R1** | backend, admin |
| F2 | Voice answers in the admin test interview | FR-ROLE-07 | **R1** | admin (backend already supports it) |
| F3 | Sample answer outline editing | FR-ROLE-03 | **R1** | admin (backend field exists) |
| B1 | Candidate "Log out" menu item logs a Base UI `nativeButton` error | bug | **R1** | candidate |
| B2 | Candidate privacy page shows raw "Failed to fetch" | bug | **R1** | candidate |
| B3 | Candidate `theme-provider.tsx:50` calls `event.key.toLowerCase()` when `key` is undefined (autofill keydown) | bug (found in P3) | **R1** | candidate |
| PD1 | Stable audit action keys | D3 | **R1** | backend, admin (check) |
| PD2 | Per-role progress in admin candidate detail | D3 | **R1** | backend, admin |
| PD3 | "Clarity (written)" label for typed answers | D3 | **R1** | backend (mode field), admin, candidate |
| PD4 | Abandoned sessions with an answer count toward the limit | D3 | **R1** | backend (view migration) |
| F4 | Follow-up probe question | FR-INT-07 (Could) | Deferred | backend (enable), candidate |
| F5 | Server PDF report | FR-SCORE-04 (Could) | Deferred | backend, admin, candidate |
| F6 | Live transcript while speaking | FR-INT-05 (Should) | Deferred | backend, candidate |
| F7 | Privacy request status for candidates | NFR-06 | Deferred | backend, candidate |
| F8 | Saved-filter delete | not in spec | Later | backend, admin |
| F9 | Session-complete email | 7.4 (optional, off) | Later | backend |

The deferred and later sections below keep their designs so they can be picked up without re-analysis.

## F1 · Cost per session

`ai_call_logs` already records `costUsd` per LLM/STT/TTS call, with `sessionId`/`attemptId`. With Gemini, the price table in each adapter fills it in (01).

- **Backend:** `GET /api/admin/ai-usage?from&to&roleId?` (Super admin) returns:
  - totals by kind (llm/stt/tts) and by model;
  - average and p90 cost per completed session;
  - sessions over budget (cost > USD 0.50);
  - a daily series.
  
  Compute it in SQL over `ai_call_logs` joined to non-preview sessions, with erased users excluded. Calls with `costUsd = null` count separately as "unpriced".
- **Admin UI:** a "Usage & cost" panel in Settings → AI, with a date range, the totals, cost per session against the USD 0.50 target, and a daily bar chart.
- **Acceptance:** numbers match a hand sum over seeded `ai_call_logs` rows.

## F2 · Voice in the admin test interview

The admin preview runner is typed-only. The backend attempt endpoint already accepts audio for preview sessions. Port the candidate recorder (`components/prep/interview/use-recorder.ts`) into the admin preview runner: MIME negotiation, a 300 s / 25 MiB limit, and a mic-denied fallback to typed. Upload the same multipart, and play back the feedback audio. Admin-only; no backend change expected, so verify the preview route's mode handling first.

## F3 · Sample answer outline

The card editor gets a multiline "Sample answer outline" field mapped to `FlashCard.sampleAnswerOutline`, which is nullable. Check that the admin card DTO and serializer include it, and add it if missing. The AI drafter's output schema should fill it too. Decide whether candidates see it on the study card; the SRS card fields say yes. Check `candidate-cards` serialization.

## F4 · Follow-up probe

The evaluator schema has `follow_up` (null unless the answer is too vague), and the API has `followUp`, but it's off by default and the candidate room never shows it.

- **Backend:** add a role setting `followUpEnabled` (default false) to `RoleSettings`, with an admin toggle. When enabled and the evaluator returns `follow_up` on attempt 1:
  - store it in `session_questions.follow_up_text`;
  - return it in `GET /attempts/:id` and `attempt.evaluated`.
  
  There's at most one per question (FR-INT-07).
- **Candidate UI:** show the probe in the feedback panel as an optional "The interviewer asks…" card. The candidate answers it in the retry. No extra attempt; it shapes attempt 2's prompt.
- **Open question:** does a follow-up change scoring? Proposal: no. It's coaching context only.

## F5 · PDF report

Today the candidate app uses browser print (`@media print`) and the admin "Export PDF" is disabled.

**Option A (recommended):** keep candidate print, and add server PDF rendering only for admin session review. Use a headless-Chromium render of a print route, which needs Chromium in the worker image; or use a pure-JS PDF library.

**Option B:** server PDF for both, as `GET /sessions/:id/report.pdf`.

Either way it's a new dependency, so pick one when this item is scheduled. Deferred after R1.

## F6 · Live transcript (FR-INT-05)

Voice today is record-then-upload, and the WS ignores `audio.chunk`. Two options:

**Option A, Gemini Live API.** The ATS backend runs `gemini-3.1-flash-live-preview` for its realtime interviews; see `xenveo-ats-backend/src/interviews/interview-session.manager.ts` and its LANDMINE note.
- Stream mic chunks over the existing WS to the API.
- The API proxies them to a Live session configured for input transcription only, and emits `transcript.partial`.
- The final answer is still uploaded and batch-processed for scoring, so scoring stays deterministic.

**Option B, defer.** It's a Should, the batch flow works, and live streaming adds the most risk (sockets per candidate, cost, NFR-02 at 100 sessions).

Deferred after R1 (D5). When built, it's a separate phase with its own load test.

## F7 · Privacy request status

Candidates get a 202 acknowledgement and nothing more. Add `GET /api/me/privacy-requests` (own requests: kind, status, createdAt, completedAt) and show it on the candidate privacy page: "Export sent on …", "Deletion requested on … — pending".

## F8 · Saved-filter delete

`DELETE /api/admin/saved-filters/:id`: owner only, system rows are 404. Audited. Add a remove control on the admin chip.

## F9 · Session-complete email

The template exists but isn't wired. Add a workspace setting (default off), and send it on `complete` through the email queue. Later.

## B1–B3 · Candidate bugs

- **B1:** `components/prep/shell/avatar-menu.tsx`. The Base UI `Menu.Item` rendering a button needs `nativeButton` or a non-button child. Fix it per the installed Base UI docs.
- **B3:** `theme-provider.tsx:50`. Guard the key handler for events without `key`; autofill fires keydown without one.
- **B2:** `components/prep/privacy/privacy-screen.tsx:23`. Map `TypeError: Failed to fetch` and other non-`ApiError` failures to friendly copy, as the admin `settingsErrorMessage` helper does.

## Product changes (PD1–PD4)

These came out of acceptance. The user adopted the recommendation for each on 2026-10-16.

### PD1 · Stable audit action keys

**Problem.** Bulk actions write their count into `action`, and `GET /admin/audit/actions` returns each count as a separate filter entry. The writers are:
- `invites.service.ts:224`: "Sent 3 invites";
- `invites.service.ts:370`: "Resent 2 invites";
- `users.service.ts:119` and `:156`: "Deactivated 4 candidates" and "Reactivated 4 candidates".

**Change.** `action` becomes a fixed string per kind: `Sent invites`, `Resent invites`, `Deactivated candidates`, `Reactivated candidates`. Singular cases use the same key. The count moves into `itemLabel` ("3 candidates"), which the audit table already shows.

**Data migration.** Rewrite existing rows with a regex over those four patterns (`^Sent \d+ invites?$` → `Sent invites`, and so on), moving the count into `itemLabel` where it's empty. Run it in the same migration.

**Admin UI.** The Action filter uses `GET /admin/audit/actions`, so it needs no change. Confirm that nothing in the UI matches on the old strings.

**Acceptance.** After 3 different bulk sends, `/admin/audit/actions` lists `Sent invites` once, and filtering by it returns all 3.

### PD2 · Per-role progress

**Problem.** `CandidateDetail.progress` and `changeSinceFirst` (`candidates-read.service.ts:164-173`) are built from the candidate's sessions across all roles. Scores from different roles aren't comparable.

**Change (backend).**
- Each `progress` point gains `roleId` and `roleTitle`, and its label is numbered per role ("Session 2").
- `changeSinceFirst` is removed in favour of the existing per-assignment `changeSinceBaseline`.
- To keep the change additive, `changeSinceFirst` could instead stay as `null` for one release. Decide in the brief; there's only one consumer, the admin UI.
- Update `reports.types.ts` and the admin `lib/types.ts` together.

**Change (admin UI).**
- The candidate detail progress chart gets a role selector, defaulting to the most recently active role, and plots only that role's sessions.
- The header "+N since first session" uses the selected role's assignment change.

**Acceptance.** demo.candidate (Junior Data Analyst 39, Customer Support 61) shows two separate single-point series and no "+22".

### PD3 · "Clarity (written)" for typed answers

**Problem.** The evaluator scores typed answers' delivery on writing clarity (`evaluator.service.ts:171`), but both UIs label the bar "Delivery".

**Change.**
- Both UIs label the dimension **"Clarity (written)"** when the attempt was typed. The wire field stays `delivery`, so the scoring formula and weights are unchanged.
- **Candidate:** attempts and session results already carry `mode`. The feedback panel (`feedback-panel.tsx`) and the results skills bars (`results-view.tsx`) switch the label by mode. A session's skills bar uses the session's mode.
- **Admin:** session review tries need `mode`. Add `mode: 'voice' | 'typed'` to `Try` in `reports.types.ts` and the mapper if it's absent. `try-card.tsx:32` and the flag rail's dimension names switch the label by mode.

**Acceptance.** Session 636bceda (typed) shows "Clarity (written)" in both UIs, and voice session 4cc51dce still shows "Delivery".

### PD4 · Abandoned sessions count toward the limit

**Problem.** `assignment_stats.sessions_used` counts only `in_progress` and `completed` sessions (the init migration). A candidate can start, read the questions, abandon, and repeat without limit.

**Change.**
- A new migration recreates the view. It counts a session when its status is `in_progress` or `completed`, or when it's `abandoned` and has at least one attempt.
- The start-session check and `attemptsLeft` already read `sessions_used`, so no service change is expected. Verify that in the brief.
- Abandoning with zero answers still costs nothing.

**Copy.** The candidate's "End without report" confirmation should say: "This counts as one of your N sessions if you've answered a question."

**Acceptance.** Abandon after one answer, and `attemptsLeft` drops by 1. Abandon with no answer, and it's unchanged. Unit-test the view logic through the e2e spec, with a new case in `interview.e2e-spec.ts`.
