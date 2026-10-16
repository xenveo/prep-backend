# 03 · Redis, queues and background jobs

The backend already supports Redis. When `REDIS_URL` is set, it uses:
- BullMQ queues (`src/common/queue/bullmq-queue.service.ts`);
- Redis pub/sub for interview WebSocket events (`src/common/events/redis-event-bus.ts`);
- Redis rate limits.

Acceptance ran without Redis, on in-process fallbacks. This phase makes Redis the normal mode everywhere except unit tests.

## 1. Namespacing (must do first)

Redis is shared on this machine (the ATS backend uses `localhost:6379`, DB 0) and may be shared in hosted environments too. Today:
- BullMQ queues use the default `bull:` prefix with generic names (`email`, `export`, `attempt`, …).
- Pub/sub channels are named like `session:{id}`.
- **Pub/sub ignores the DB index**, so a channel published by one app is received by any app subscribed to the same name on that server.

Changes:
- New env `REDIS_PREFIX=preppilot`.
  - BullMQ: pass `prefix: REDIS_PREFIX` to every `Queue`, `Worker` and `QueueEvents`.
  - Rate-limit keys and pub/sub channels: prefix with `${REDIS_PREFIX}:`.
  - Put all three in one helper, e.g. `RedisService.key()`, so nothing builds a raw key.
- Locally, use a separate logical DB as well (`REDIS_URL=redis://localhost:6379/2`).
- Unit test: every Redis key and channel the app touches starts with the prefix.

## 2. Local setup

`.env`: `REDIS_URL=redis://localhost:6379/2`, `REDIS_PREFIX=preppilot`. `docker-compose.yml` already has a `redis` service for machines without a native Redis. Run:

```
npm run start:dev                 # PROCESS_ROLE=all, everything in one process
# or, to exercise the split:
PROCESS_ROLE=api npm run start:dev
npm run build && PROCESS_ROLE=worker npm run start:worker
```

e2e keeps the in-memory mode (no `REDIS_URL` in `vitest.config.e2e.ts`). A separate e2e job with Redis runs in CI (see 05).

## 3. API / worker split

| Process | Runs | Notes |
| --- | --- | --- |
| `api` (`node dist/main.js`, `PROCESS_ROLE=api`) | HTTP + WebSocket gateway | Enqueues jobs and subscribes to pub/sub for WS relay |
| `worker` (`node dist/worker.js`, `PROCESS_ROLE=worker`) | Queue processors: attempt, tts-pregen, email, ai-draft, export, purge, erasure | Scale on queue depth |

Checks:
- The `start:worker` script was fixed earlier; re-verify it.
- Graceful shutdown: on SIGTERM, workers finish the current job (BullMQ `worker.close()`) and the API drains WebSockets.
- AI-draft job status (`GET /admin/ai-jobs/:id`) must work across processes. The Redis queue implementation already stores outcomes; verify this with the split running.

## 4. Job recovery (known gap)

**Problem.** With the in-process queue, a restart loses in-flight jobs. During acceptance an export stayed in `running` for good. BullMQ re-runs stalled jobs, but DB status columns can still lag: an export left in `running`, or an attempt left in `transcribing`/`evaluating`.

**Fix.** Add a startup sweep in the worker (`PROCESS_ROLE` worker or all) with an hourly repeat:
- **Exports:** `queued` or `running` with `updatedAt` older than 10 min. Re-enqueue with the same deterministic job id (`export-${id}`), which BullMQ dedupes. After 3 sweeps, mark `failed`.
- **Attempts:** `received`, `transcribing` or `evaluating` older than `STALE_RUN_MS` (2 min). Re-enqueue with the attempt's deterministic job id. The pipeline's existing stale-claim logic decides whether to run. After the retry limit, mark `failed` and publish `attempt.failed` (`retryable: true, textModeOffered: true`), so the candidate UI offers a retry instead of waiting for ever.
- **AI drafts:** no DB status. The Redis outcome store covers this.

Unit-test the sweep with fixed clocks. Add an e2e test with the in-memory queue: create a stale `running` export, then boot and see it re-run.

## 5. Queue settings to review

| Queue | Concurrency (worker) | Attempts / backoff | Notes |
| --- | --- | --- | --- |
| attempt | about 10 per worker; tune against Gemini RPM (01) | 3, exponential | NFR-01 latency is critical; keep this queue separate from the slow ones |
| tts-pregen | 2 | 3 | Bursts on role approve |
| email | rate-limited to `MAIL_RATE_PER_SECOND` | 3 (permanent errors not retried) | BullMQ limiter |
| ai-draft | 2 | 1 (the admin retries manually) | |
| export | 2 | 3 | Status flapping already fixed |
| purge / erasure | 1 | 3 | Cron `0 2 * * *` (IST) |

Set `removeOnComplete` / `removeOnFail` age limits (for example 24 h and 7 d) so Redis doesn't grow without bound. Job payloads hold ids only, never transcripts or emails; the privacy rule and the earlier review fix require this.

## 6. Production Redis

- **Service:** Redis 7 on the user's host, with TLS (`rediss://`) and AUTH. BullMQ needs `maxmemory-policy noeviction`, otherwise jobs can be evicted silently.
- **Persistence:** AOF on. Redis holds queued jobs, which are the only copy of an un-run attempt's work trigger. The DB status plus the recovery sweep make that safe, but AOF reduces the churn.
- **Health:** `/api/health` already reports `db`. Add `redis: ok|down`, and make readiness fail when Redis is down in api/worker mode.

## Ownership (Phase 1)

Task **REDIS**: `src/common/infra/redis.service.ts`, `src/common/queue/bullmq-queue.service{,.spec}.ts`, `src/common/events/redis-event-bus.ts`, the rate-limit Redis store, the new recovery sweep (`src/jobs/recovery/` or `modules/privacy` + `modules/interview/pipeline` hooks; decide in the brief), the health check, the `env.ts` Redis keys, and the `.env.example` Redis section. These are mostly `common/` files, so this task has exactly one owner.
