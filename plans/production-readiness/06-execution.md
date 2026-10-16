# 06 · Execution, ownership and acceptance

The same workflow as the integration (AGENTS.md "Multi-agent workflow"):
- The backend session is the **Coordinator**.
- Backend tasks go to backend Coders, with exact file ownership per brief.
- Frontend work goes to the admin and candidate sessions in their own repos.
- Nobody commits, pushes or runs destructive DB commands without the user.

## Phases

| Phase | Tasks (parallel within a phase unless noted) | Gate |
| --- | --- | --- |
| **P0** Spike | All decisions are taken (README). Coordinator: list the Gemini models available to the key; run the STT timestamp spike (01) and the TTS output-format check; estimate cost per session. Record the results in 01 and the ledger. | D2 resolved, model ids recorded |
| **P1** Infra | REDIS (03) ∥ MAIL (02). Coordinator merges the `env.ts` / `.env.example` edits | Unit + e2e (in-memory) green; local run with Redis and `PROCESS_ROLE=api` + `worker`; a real OTP email to an allowlisted inbox |
| **P2** Gemini | G-LLM first (it owns the shared client, env and deps), then G-STT ∥ G-TTS | Unit green; `npm run smoke:ai` returns evaluator JSON (`gemini-3.8-flash`), a transcript (`gemini-3.8-flash`) and WAV voicing (`gemini-3.8-flash-tts`) |
| **P3** Real-provider acceptance | Coordinator + both UI agents replay the INTEGRATION_PLAN §10 journeys with Gemini, Resend and Redis | Feedback < 8 s p90 on 20 manual attempts; cost per session ≤ USD 0.50; voice/typed/retry/skip/complete; spoken feedback plays; emails arrive; nothing stuck after a worker restart |
| **P4** R1 features + product changes | F1–F3, B1–B2 and PD1–PD4. Backend Coders and UI agents work in parallel by repo. PD1 and PD4 carry migrations and share one schema owner. P4 can start alongside P2/P3, because its files don't overlap the adapters | Each item's acceptance in 04, plus typecheck, lint and build in the touched repos |
| **P5** Ops | OPS-IMAGE ∥ OPS-CI ∥ OPS-CAL, then OPS-LOAD (needs a production-like deploy). Hosting itself is done manually by the user | Image runs both roles; runbook complete; CI green in all repos; calibration ≥ 80%; load targets met |

## Shared-file rules

- `src/config/env.ts`, `.env.example`, `package.json`/`package-lock.json` and adapter provider wiring are touched by several tasks. Each phase names one owner for them, and the others send their additions to the Coordinator.
- `prisma/schema.prisma` and migrations: one schema owner per phase. Known migrations:
  - the prompt-version data migration with thinking level (P2, G-LLM);
  - the PD1 audit action rewrite;
  - the PD4 `assignment_stats` view.

  PD1 and PD4 go to one P4 backend Coder, so their migrations are created in sequence. Apply them in timestamp order after the P2 migration. If they're created in parallel, rebase the timestamps before merging.
- `src/common/**` belongs to REDIS in P1.
- Never run e2e suites in parallel against one database. Use `prep_db_e2e`; a Redis e2e run uses its own `REDIS_PREFIX`.

## Frontend work by repo

| Repo | Items |
| --- | --- |
| prep-admin-ui | R1: F1 cost panel, F2 voice preview (recorder port), F3 outline field, PD1 check, PD2 per-role progress chart, PD3 label; wav playback check (P2). Deferred: F4 toggle, F8 filter delete |
| xenveo-prep-candidate | R1: B1, B2, PD3 label, PD4 abandon copy, null-pause rendering if D2 = Outcome B, wav playback check (P2). Deferred: F4 follow-up card, F6 live transcript, F7 request status |

Backend P4 tasks: **P4-COST** (F1 endpoint), **P4-CONTENT** (F3 DTO/serializer check, PD3 `Try.mode`), **P4-DATA** (PD1 + PD4 migrations and writers, PD2 progress shape). F2 is admin-only.

## Running locally after P1/P2

```
# backend .env (gitignored) — values already present for the keys
REDIS_URL=redis://localhost:6379/2
REDIS_PREFIX=preppilot
LLM_PROVIDER=gemini   STT_PROVIDER=gemini   TTS_PROVIDER=gemini
GEMINI_STT_MODEL=gemini-3.8-flash   GEMINI_TTS_MODEL=gemini-3.8-flash-tts
MAIL_PROVIDER=resend  MAIL_FROM="Xenveo <noreply@emails.xenveo.com>"
MAIL_ALLOWLIST=<your inbox>
```

The API runs on :4000, the candidate app on :3001 and admin on :3002, as in the acceptance run.

## Progress ledger

Update this table as tasks land: status, evidence, and any deviations.

| Task | Owner | Status | Evidence |
| --- | --- | --- | --- |
| D1 residency | user | done: no India requirement (2026-10-16) | |
| D4 hosting | user | done: manual, by the user (2026-10-16) | |
| D2, D3, D5 | user | done: recommendations adopted (2026-10-16); D2 settled by the spike | |
| P0 Gemini spike | Coordinator | done 2026-10-16 | See 01 "P0 results": compact transcription accurate (WER ≤ 3%), per-word timestamps too slow; Gemini pause timing unreliable beyond about 20 s; evaluator schema-valid at 6–8 s; TTS WAV 24 kHz and verbatim; about $0.11/session. Two decisions raised: pause source, feedback latency |
| REDIS | backend Coder | done 2026-10-16 | `preppilot:` prefix on all keys, queues and channels (verified in Redis DB 2); PermanentJobError → UnrecoverableError; send-rate limiter; retention 24 h/7 d; recovery sweep (attempts every 2 min, exports hourly, separate locks); `redis` in /api/health. Unit 633/633; e2e in-memory 77/77; e2e on Redis 74/77. The 3 privacy tests use the in-memory-only `queue.drain()`; make them Redis-aware in OPS-CI |
| MAIL | backend Coder | done 2026-10-16 | Resend adapter (`resend` 6.18.1), permanent vs retryable mapping, idempotency key = unique email job id, allowlist routes the rest to the outbox. Live: a real invite was delivered to the allowlisted inbox via Resend; a non-allowlisted login code was suppressed to the outbox |
| Model choice | user | done 2026-10-16: `gemini-3.8-flash` (assessment, generation, transcription) + `gemini-3.8-flash-tts` (interviewer voice); no Live model; interview flow stays record-then-upload | |
| TTS audio format | user | done 2026-10-16: keep uncompressed WAV | |
| Optional OpenAPI / old-file formatting | user | not needed (2026-10-16) | |
| Session numbering | user | done 2026-10-16: keep as is (abandoned sessions consume numbers; progress labels count completed sessions per role) | |
| D2, D6, D7 (pause source, feedback latency, dev allowlist) | user | done 2026-10-16: browser pause meter; split evaluator; allowlist kartik.pavan@atrox.io | |
| G-LLM | backend Coder | done 2026-10-16 (`d8a0cb1`) | Shared GeminiClient + gemini-3.8-flash LLM adapter; migration `gemini_flash` (thinking levels, attempts.speaking_s); live call about 2.5 s |
| G-STT | backend Coder | done 2026-10-16 (`253da57`) | Chrome webm/opus accepted as-is (0% WER on a corpus clip); live voice transcription 3.4–4.1 s for 13–22 s answers |
| G-TTS | backend Coder | done 2026-10-16 (`253da57`) | gemini-3.8-flash-tts WAV 24 kHz; voices en-in-podcaster-7 / charon / en-in-tutor-11; first generation 3.3–3.9 s, cached 3–11 ms |
| G-EVAL (split evaluator) | backend Coder | done 2026-10-16 (`253da57`) | Written feedback (server) typed 4.3–4.7 s, voice 8.2–9.2 s; spoken feedback ready 18–23 s; completion (summariser) 7–10.4 s |
| Candidate pause meter | candidate agent | done 2026-10-16 (candidate `kartik` commit) | AudioWorklet meter; matched corpus truth within 0.1 s (a2, a4, L1); values flow into wpm and pauses |
| P3 acceptance | Coordinator + UI agents | partly done 2026-10-16 | Real-Gemini browser run passed (voice retry/skip, typed, card and question audio, completion, admin review, AI config, voice samples). WS wake fix done (UI shows written feedback about 0.4 s after the server). Follow-ups: TTS WAV is about 48 KB/s (opus/mp3 needs an encoder decision); an evaluator matched/issue contradiction (logged for OPS-CAL); abandoned sessions consume session numbers (product question, with PD4). Still to do: real human voices and noise, cost per real session |
| P4-COST / P4-READ / P4-DATA | backend Coders | done 2026-10-16 (`19bd1ef`, `92221b1`) | /admin/ai-usage live (about $0.036 per real Gemini session); outline; fixed audit action keys + row migration; per-role progress; answer mode on tries and the session report; abandoned-with-answer sessions count (view migration); TTS calls log their model; .mp4 answers served as audio/mp4 |
| F1–F3, PD1–PD3 (admin) | admin agent | done 2026-10-16 (admin `f2c27c1`) | All 5 live checks passed: cost panel, voice test interview (written feedback 8.2 s), outline editor and preview, per-role chart, Clarity (written) |
| B1–B3, PD3–PD4, F3 (candidate) | candidate agent | done 2026-10-16 (candidate `2333507`) | Console clean of B1/B3; Clarity (written) / Delivery / clarity labels; abandon copy with sessions left (4 → 3 verified); real outline renders and is read aloud |
| F4–F7 | — | deferred after R1 | |
| OPS (P5) | backend Coders + UI agents | done 2026-10-16 (load test pending) | Docker dropped (manual Hetzner hosting, runbook rewritten for systemd + Caddy). /api/ready and worker /ready; API security headers; Redis fail-fast boot, bounded shutdown, worker drain; production bootstrap script; seed rubric links fixed; Prisma `importFileExtension`; CI in all 3 repos (backend e2e 78/78 on in-memory and Redis); frontend CSP (candidate: nonce, browser-verified, 0 violations); calibration tool + evaluator consistency fix (prompt v2). Real calibration needs about 30 SME-scored answers per role from the user |
| Scoring rules (user, 2026-10-16) | user; backend Coder | done 2026-10-16 | Skipped retry = no change (L = 50, A2 = A1), replacing SRS FR-RETRY-05's L = 0: `SKIPPED_RETRY_LEARNING` in `scoring/score.ts`, also used by the report and question-bank SQL. Stored session scores are not recomputed; per-question `avgLearning` averages are computed from attempts, so they apply L = 50 to older skipped retries too. No score floor. Configured delivery targets passed to the evaluator (user-message "Targets:" line for voice answers; migration `evaluator_configured_targets`, evaluator prompt v5). Evaluator prompt v4 lenient anchors (migration `evaluator_lenient_anchors`) |
| FR-INT-07 follow-up question (user, 2026-10-16) | Coordinator; admin + candidate agents | done 2026-10-16 | Per-role `settings.followUpEnabled` (default off, no migration). On attempt 1 the evaluator may ask one probe; it frames the retry (no new attempt type, timing unchanged), and attempt 2 is scored with the probe as context. The gate sits in the evaluator user message, so DB prompt versions are unchanged. Resume view carries `results[i].followUp`. Admin switch in role settings; candidate callout on first-try feedback and the second-try room. Live Gemini run (JDA, typed): a vague first try (25) got "Could you share one specific project you worked on and the tools you used?"; the retry answering it scored 95 with no new probe; flag restored off |
| FR-SCORE-04 PDF report (user, 2026-10-16: both audiences, pdfmake) | backend Coder; admin + candidate agents | done 2026-10-16 | `pdfmake@0.3.11` (bundled Roboto; no Devanagari glyphs, accepted), URL access off, file access limited to the font dir. One renderer (`reports/pdf/`), two routes: `GET /sessions/:id/report.pdf` (owner; 409 `session_in_progress`) and `GET /admin/candidates/:cid/sessions/:sid/report.pdf` (same scope as the review; a read, not audited, like the CSV). `no-store`, role-slug filename, no name in filename or metadata. Content: score, band, averages, formula (admin), strengths/focus (candidate), per-try sub-scores (typed → "Clarity (written)"), voice delivery, worked/improve, transcripts, applied items, footer "Practice feedback only. Not a hiring decision." Live: candidate and admin downloads on voice and typed sessions match the pages; render < 250 ms. Unit 879, e2e 86 |
| No named answer method (user, 2026-10-16) | Coordinator | done 2026-10-16 | Typed paragraph answers kept getting "use the STAR method" feedback. The evaluator call 1 template no longer receives the rubric's expected structure: structure is judged on how easy the answer is to follow, in any format, and a feedback rule bans naming or asking for a framework or acronym (such as STAR) or another format. Migration `evaluator_no_named_structure` (new active evaluator version; `expected_structure` stays in the question bank, unused by scoring). Live Gemini run (JDA, 5 typed paragraph answers, 3 rubric-STAR): no STAR or method wording; strong answers 100, vague ones 30/30/59 with "name specific checks / tell one real story" advice. Unit 888, e2e 87 |
| Login cookies + any-code accounts (user, 2026-10-16) | Coordinator | done 2026-10-16 (deploy pending) | Separate admin cookie `pp_admin_session` (candidate keeps `pp_session`), chosen by Origin/Referer = APP_ADMIN_ORIGIN or the admin SSR's `X-PrepPilot-App: admin`, so signing in to one app no longer signs the other out. Briefly reverted (`3bbe0a1`) after an admin lockout; the prod logs and auth_sessions showed the cookie worked (one superadmin sign-in, accepted at once). The lockout came from pm2 keeping the old allowlist until `--update-env`, then the shared superadmin account using up the 5/hour code-request limit. Fix: any-code accounts (`superadmin@xenveo.com`, `demo.candidate@example.com`) skip the request limit and get no emailed code |
