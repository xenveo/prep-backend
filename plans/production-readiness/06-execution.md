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
| P0 Gemini spike (4 checks in 01) | Coordinator | pending | Models available to the key confirmed 2026-10-16 |
| REDIS | backend Coder | pending | |
| MAIL | backend Coder | pending | |
| Model choice | user | done 2026-10-16: `gemini-3.8-flash` (assessment, generation, transcription) + `gemini-3.8-flash-tts` (interviewer voice); no Live model; interview flow stays record-then-upload | |
| G-LLM | backend Coder | pending | |
| G-STT | backend Coder | pending | |
| G-TTS | backend Coder | pending | |
| P3 acceptance | Coordinator + UI agents | pending | |
| P4-COST / P4-CONTENT / P4-DATA | backend Coders | pending | |
| F1–F3, PD2–PD3 (admin) | admin agent | pending | |
| B1–B2, PD3–PD4 (candidate) | candidate agent | pending | |
| F4–F7 | — | deferred after R1 | |
| OPS-IMAGE / CI / CAL / LOAD / API | backend Coder | pending | |
