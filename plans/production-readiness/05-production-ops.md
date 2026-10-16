# 05 · Production operations

What the services need in order to be deployed, observed and trusted. Sentry is out of scope (user decision).

## Container images (dropped 2026-10-16)

> **Decision:** the user hosts manually on a Hetzner server, with no containers. The Dockerfile was removed. `docs/DEPLOYMENT.md` covers the systemd-based deploy (Node 24, Caddy, Postgres, Redis, Hetzner Object Storage). The text below is kept for history.

The user will host this manually. This phase delivers what a manual deploy needs: an image, documented env vars and a runbook. It provisions no infrastructure. There's no `Dockerfile` today. Add one multi-stage `Dockerfile` that builds a single image used for both processes:
- **build stage:** `npm ci`, `prisma generate`, `nest build`;
- **runtime stage:** `node:22-slim` (or the repo's Node version), `npm ci --omit=dev`, `dist/` and the generated client, running as a non-root user.

The entrypoint is selected by `PROCESS_ROLE`: `node dist/main.js` for the API and `node dist/worker.js` for the worker. Migrations run as a separate one-off task (`npx prisma migrate deploy`), never on API boot.

Add a `.dockerignore` (excluding `.env*`, `.data/`, `node_modules`, `dist`). If F5 option A is chosen, the worker needs Chromium; decide that before finalising the image.

Frontends deploy as Next.js apps, on whatever host the user chooses. Each needs `NEXT_PUBLIC_API_BASE_URL` and `API_BASE_URL` set for the environment.

Add `docs/DEPLOYMENT.md`, a runbook for the manual deploy. It covers:
- every env var, with whether it's required;
- the process roles;
- the migration step;
- Redis requirements (`noeviction`, AOF);
- cookie, domain and CORS settings;
- the health endpoints;
- a post-deploy smoke checklist.

## Environments and config

| Env | API origin | Frontends | Providers | Redis | DB |
| --- | --- | --- | --- | --- | --- |
| local | `http://localhost:4000` | 3001 / 3002 | fake or Gemini (opt-in), console or Resend + allowlist | local DB 2, prefix `preppilot` | local `prep_db` |
| production (user-hosted) | user's API domain | user's frontend domains | Gemini, Resend | Redis 7, TLS, noeviction | Postgres 16 with backups/PITR |

Production cookies:
- `SESSION_COOKIE_DOMAIN` is the shared parent domain, so frontend server rendering can forward `pp_session`.
- Cookies are `Secure`. CORS origins are exact.
- `TRUST_PROXY` is set to the load balancer hop count.
- `PUBLIC_API_URL` is the public API origin.

Secrets come from the host's secret store, never from image layers.

## CI

`.github/workflows/ci.yml`, or the equivalent on the chosen host. There's no CI today. On each push and PR to `main`/`kartik`:

1. Backend: `npm ci`, typecheck, lint, `npm test`, `npm run build`.
2. Backend e2e: a Postgres 16 service container, `prisma migrate deploy` plus seed, then `npm run test:e2e`, in in-memory queue mode.
3. Backend e2e with Redis: the same suite with a Redis 7 service, `REDIS_URL` and `REDIS_PREFIX` set, to exercise BullMQ and pub/sub.
4. Each frontend repo: `npm ci`, typecheck, lint, build.

CI never runs live provider tests (no Gemini or Resend calls). Each repo is separate, so each gets its own workflow.

## Health and readiness

- `GET /api/health`: liveness (process up), cheap.
- `GET /api/ready`: DB `SELECT 1`, Redis `PING` (in api/worker mode), and storage reachability. The load balancer and orchestrator use it.
- The worker needs a health signal for the orchestrator: a tiny HTTP listener on `WORKER_HEALTH_PORT` serving `/ready` (Redis and DB), or a heartbeat key in Redis.

## Logging and metrics (no Sentry)

- Pino JSON logs to stdout. Every line carries a request id, and the session/attempt id where relevant. **Never** transcripts, names, emails or prompt text. Retention ≤ 35 days (DPDP note in the implementation plan §13).
- Errors: unhandled exceptions log at `error` with a stack. Alert on the error-log rate at the log platform (CloudWatch metric filter or equivalent).
- AI metrics come from `ai_call_logs`: latency p50/p90 per kind, failure rate and cost per session (F1 surfaces the cost). Alert when feedback p90 goes above 8 s or the failure rate above 5% over 15 min.
- OpenTelemetry: optional. The env var already exists. Instrument HTTP, Prisma and BullMQ only if a collector is available in the chosen host. Not required for R1.

## Load test (NFR-01, NFR-02)

A k6 script under `test/load/` drives 100 concurrent candidate sessions through the real API:
login (a seeded batch with OTPs read via a test-only hook, or pre-created sessions) → start → 5 × (attempt 1 voice upload, attempt 2 or skip) → complete.

Targets:
- API p95 < 300 ms;
- question audio < 2 s;
- feedback p90 < 8 s from upload to `attempt.evaluated`;
- zero lost attempts.

Run it against a production-like deploy (the user's host, or locally with the API/worker split) with real Gemini on a capped budget. Read the cost per session from `ai_call_logs`. A test-only OTP hook must be impossible to enable in production: env-gated and refused when `NODE_ENV=production`.

## Evaluator calibration (SRS 5.5)

`scripts/calibrate.ts` runs at least 30 human-scored sample answers per role through the evaluator, using the active prompt version and model. It reports per-dimension agreement within ±1 level and a confusion summary. The target is ≥ 80% agreement.

The answer set is a JSON fixture of `{ roleSlug, questionId, answerText, humanScores }`. Answers must be synthetic or consented, with no real candidate data in the repo. Re-run it whenever the evaluator prompt or model changes, and record the result in the prompt version's notes.

## Moderation (NFR-05)

The hiring-verdict blocklist exists (`modules/ai/moderation.ts`). With Gemini:
- set `safetySettings` explicitly on every call;
- treat `SAFETY`/`PROHIBITED_CONTENT` finish reasons as the moderation signal: one regeneration, then the safe generic feedback that already exists.

No separate moderation API is needed.

## OpenAPI (gap G5)

Add `@nestjs/swagger` generation from the Zod schemas (as `openapi.json`, served at `/api/docs` outside production) and commit the generated file. A CI step fails on drift. This gives the frontends a checked contract. Generated clients are optional; the hand-written transports keep working. Optional; not required for R1.

## Security checklist before launch

- [ ] Run the `security-review` skill (or an equivalent) over the backend and both UIs.
- [ ] Rotate all secrets used during development, including the Gemini and Resend keys that appeared in chat transcripts, and the `AUTH_SECRET`.
- [ ] CSP and security headers on both frontends; `helmet` (or the equivalent) on the API.
- [ ] Rate limits verified with Redis (OTP per email/IP, AI admin calls).
- [ ] S3: SSE on, a lifecycle rule on `audio/` matching `audioRetentionDays`, no public ACLs, short signed URLs.
- [ ] Backups: Postgres point-in-time recovery, a restore drill, and the documented post-restore erasure re-run (implementation plan §13).
- [ ] DPDP: vendor DPAs recorded (Google, Resend), and zero or minimal data retention configured with Gemini.

## Ownership (Phase 5)

| Task | Files |
| --- | --- |
| OPS-IMAGE | `Dockerfile`, `.dockerignore`, `package.json` scripts, the readiness endpoint and worker health, `docs/DEPLOYMENT.md` |
| OPS-CI | `.github/workflows/*` in each of the three repos |
| OPS-LOAD | `test/load/**`, the test-only login hook (env-gated) |
| OPS-CAL | `scripts/calibrate.ts`, `test/fixtures/calibration/**` |
| OPS-API | swagger setup, `openapi.json`, CI drift check |
