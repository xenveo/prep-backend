# PrepPilot production readiness plan

Date: 2026-10-16. Follows [INTEGRATION_PROGRESS.md](../../INTEGRATION_PROGRESS.md): the UI↔API integration passed runtime acceptance on fake providers. This plan covers what is still missing before PrepPilot can run for real users.

## Goal

1. Run the interview pipeline on **real AI**: Google Gemini for the LLM, speech-to-text and text-to-speech.
2. Send **real email** through Resend.
3. Run on **Redis**: BullMQ queues, pub/sub and rate limits, with an API process and a worker process.
4. Close the **feature gaps** found during acceptance.
5. Make it **deployable and operable**: container, CI, health checks, load test and evaluator calibration.

## Decisions already taken (user, 2026-10-16)

| Topic | Decision |
| --- | --- |
| AI provider | **Gemini only**, through `@google/genai`. The existing Anthropic, Deepgram and ElevenLabs adapters stay in the code but aren't used. |
| AI models | **`gemini-3.8-flash`** for assessment, generation and transcription of uploaded answers. **`gemini-3.8-flash-tts`** for the interviewer's voice: cached question audio, feedback clips, card audio and samples. No Live model; the interview isn't a live conversation. See [01](01-gemini.md). |
| Interview flow | **Unchanged from the SRS/spec: record-then-upload.** The AI asks, the candidate records, the answer is uploaded on finish, then batch transcription, evaluation, written and spoken feedback, one retry, comparison. No real-time voice conversation in R1. |
| Email | **Resend**, sender `Xenveo <noreply@emails.xenveo.com>` (the domain is verified on the Xenveo Resend account, shared with the ATS backend) |
| Queue / realtime | **Redis** is required outside unit tests |
| Error tracking | **Skip Sentry.** Structured pino logs stay, and OpenTelemetry is optional (see 05) |
| Data residency | **No India data-residency requirement.** This supersedes the residency rows in `docs/BACKEND_SPEC.md` and in `docs/BACKEND_IMPLEMENTATION.md` §1/§13. Providers are chosen on quality and cost. |
| Hosting | **Done manually by the user later.** This plan delivers a deployable image and env documentation, not infrastructure. |
| Reference implementation | `xenveo-ats-backend`: `src/ai/gemini.service.ts` (error mapping, model check, timeouts) and `src/mail/drivers/resend.driver.ts` (retryability, idempotency key) |

## Decisions taken on recommendation (user, 2026-10-16)

| ID | Topic | Decision |
| --- | --- | --- |
| D2 | **Delivery metrics with Gemini** | The P0 spike decides it ([01](01-gemini.md#p0-spike-before-p2)). If `gemini-3.8-flash` word timestamps are accurate enough, keep pace, fillers and pauses. Otherwise pace and fillers come from the transcript and the measured duration, and pauses show as unavailable. No further user input is needed. |
| D3 | **Product changes from acceptance** | All four are adopted as R1 work items PD1–PD4 in [04](04-feature-gaps.md#product-changes-pd1pd4): stable audit action keys, per-role progress, a "Clarity (written)" label for typed answers, and abandoned sessions with an answer counting toward the limit. |
| D5 | **R1 scope** | In R1: F1 cost view, F2 voice in the admin test interview, F3 sample answer outline, and bugs B1–B2, together with PD1–PD4. Deferred until after R1: F4 follow-up question, F5 PDF report, F6 live transcript, F7 privacy request status. Later: F8 saved-filter delete, F9 session-complete email. |

## Files

| File | Covers |
| --- | --- |
| [01-gemini.md](01-gemini.md) | `gemini-3.8-flash` LLM and STT adapters, `gemini-3.8-flash-tts` voice adapter, model config, costs, the spike |
| [02-resend-email.md](02-resend-email.md) | Resend mail adapter, sender and domain, retries, dev safety |
| [03-redis-and-jobs.md](03-redis-and-jobs.md) | Redis setup, key and queue namespacing, API/worker split, job recovery, rate limits, pub/sub |
| [04-feature-gaps.md](04-feature-gaps.md) | Product gaps (live transcript, PDF, follow-up, admin voice preview, cost view, …) and UI bugs |
| [05-production-ops.md](05-production-ops.md) | Docker, CI, health/readiness, logs, load test, evaluator calibration, moderation, OpenAPI, security, backups |
| [06-execution.md](06-execution.md) | Phases, agent ownership across the three repos, acceptance gates, the progress ledger |

## Phase overview

```
P0  Decisions + Gemini spike ─────────────┐
P1  Redis + Resend (infra)  ──────────────┤ parallel
P2  Gemini LLM → STT ∥ TTS adapters ───────┘ (LLM first, needs the P0 spike)
P3  Real-provider acceptance (dev budget) ── needs P1 + P2
P4  R1 features + product changes PD1–PD4 ── parallel with P2/P3 (no shared files)
P5  Production ops: container, CI, load test, calibration ── needs P3
```

Secrets (`GEMINI_API_KEY`, `RESEND_API_KEY`) live only in the gitignored `.env`. They never go in `.env.example`, docs or code.
