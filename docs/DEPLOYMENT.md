# Deployment runbook

How to deploy PrepPilot by hand on a Hetzner server. The plan behind it is
[`plans/production-readiness/05-production-ops.md`](../plans/production-readiness/05-production-ops.md).
Hosting is manual. The services run directly on the server under systemd, with no containers, and
this repo provides the code, migrations, bootstrap and this runbook.

## 1. What you deploy

| Piece | Version / notes |
| --- | --- |
| Server | A Hetzner Cloud VM (e.g. CPX31 or larger), Ubuntu 24.04. Hetzner Cloud Firewall allows 22 (your IPs only), 80 and 443. |
| Node.js | 24 (the version CI uses). Install from NodeSource or with a version manager. |
| Backend | This repo, built with `npm ci && npm run build`. It runs as two systemd services: the API and the worker (section 3). |
| PostgreSQL | 16 on the server (or a separate VM), with `citext` and `pgcrypto`. Backups in section 6. |
| Redis | 7 on the server, bound to localhost, password set, `maxmemory-policy noeviction`, AOF on (section 6). |
| Object storage | Hetzner Object Storage (S3-compatible) or any S3 bucket (section 7). |
| Reverse proxy | Caddy (automatic TLS, WebSocket-friendly) or nginx (section 8). |
| Gemini | A paid-tier API key (LLM, speech to text, text to speech). |
| Resend | A verified sending domain. |
| Frontends | The candidate and admin Next.js apps, as systemd services on the same server or elsewhere (section 10). |

## 2. Build on the server

```sh
sudo adduser --system --group --home /srv/preppilot preppilot
sudo -u preppilot git clone git@github.com:xenveo/prep-backend.git /srv/preppilot/backend
cd /srv/preppilot/backend
git checkout <release-tag-or-sha>
npm ci            # its postinstall runs prisma generate; dev dependencies are needed for the build
npm run build     # writes dist/
```

Secrets never live in the checkout. Put the environment in `/etc/preppilot/backend.env`, owned by
root with mode `600`, and let systemd load it (section 3). The repo's `.env` is for local development
only.

## 3. Process roles and systemd

The role is chosen by `PROCESS_ROLE`:

| Role | Command | What runs |
| --- | --- | --- |
| `api` | `node dist/main.js` | HTTP API and WebSocket on `PORT`. No queue processors. |
| `worker` | `node dist/worker.js` | BullMQ processors (pipeline, TTS, email, exports, erasure, the nightly purge) and recovery sweeps. No HTTP server, except `/ready` on `WORKER_HEALTH_PORT` when set. |
| `all` | `node dist/main.js` | API and processors in one process. Single instance only, for trials. |

Production runs `api` and `worker` as separate services, and both need `REDIS_URL`. Example units:

```ini
# /etc/systemd/system/preppilot-api.service
[Unit]
Description=PrepPilot API
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target

[Service]
User=preppilot
WorkingDirectory=/srv/preppilot/backend
EnvironmentFile=/etc/preppilot/backend.env
Environment=NODE_ENV=production PROCESS_ROLE=api PORT=3000
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=5
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/preppilot-worker.service: the same, except
Description=PrepPilot worker
Environment=NODE_ENV=production PROCESS_ROLE=worker WORKER_HEALTH_PORT=3010
ExecStart=/usr/bin/node dist/worker.js
TimeoutStopSec=35
```

- `TimeoutStopSec` for the worker must be at least `WORKER_DRAIN_MS` + 5 s, so in-flight answers can
  finish on a restart. With Redis down, shutdown takes about 3 s.
- If Redis is unreachable at start, the process exits with one clear line after
  `REDIS_CONNECT_TIMEOUT_MS`, and systemd restarts it.
- Enable both: `sudo systemctl enable --now preppilot-api preppilot-worker`. Logs:
  `journalctl -u preppilot-api -f`.

## 4. Database migrations

Migrations never run on boot. Run them once per release, from the checkout, **before** restarting
the services:

```sh
cd /srv/preppilot/backend
sudo -u preppilot env $(sudo cat /etc/preppilot/backend.env | xargs) npx prisma migrate deploy
```

Only `DATABASE_URL` is needed. Check each release's migrations first: if one isn't backward
compatible with the running services, stop them before migrating.

Some migrations also carry data: prompt versions, and the four ServiceNow job roles with their
default flash cards and interview questions (`20261017080000_servicenow_roles`). That one adds
content only to a role with no flash cards yet, so it never overwrites admin edits. It deletes the
old mock roles (Junior Data Analyst, Sales Development Rep, Customer Support Associate), or archives
any a session used. The roles arrive as drafts: an admin reviews each one and approves it.

`prisma/seed.ts` is a **development** seed with demo users: never run it in production. A new production database gets `scripts/bootstrap.ts` instead, once, after its first
migration (section 12).

## 5. Environment variables

Source of truth: `src/config/env.ts`, validated at boot. A bad value stops the process, and the error
names the variable (never its value). Variables marked *(secret)* belong in the host's secret store.

### Process and infrastructure

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | **yes** (`production`) | `development` | `production` turns on `Secure` cookies and HSTS. Set it in the systemd unit. |
| `PORT` | no | `3000` | API listen port. Bind behind the reverse proxy; don't expose it directly. |
| `PROCESS_ROLE` | yes in prod | `all` | `api`, `worker` or `all` (section 3). |
| `WORKER_HEALTH_PORT` | worker: recommended | unset | Worker serves `GET /ready` on this port. Unset means no listener. |
| `DATABASE_URL` *(secret)* | **yes** | — | `postgresql://user:pass@host:5432/db?schema=public&sslmode=require` |
| `REDIS_URL` *(secret)* | yes when split | unset | `rediss://:password@host:6379/0`. Unset means in-process (single `all` instance only). |
| `REDIS_PREFIX` | no | `preppilot` | Namespace for keys, queues and pub/sub channels; `[a-z0-9-]+`. Must differ per environment that shares a Redis server. |
| `TRUST_PROXY` | **yes** behind the proxy | unset | `1` behind Caddy or nginx on the same server. Needed for the per-IP OTP limit. |
| `LOG_LEVEL` | no | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |
| `LOG_PRETTY` | no | `false` | Keep `false` in production: JSON logs to stdout. |
| `SENTRY_DSN` | no | unset | Unused (Sentry is out of scope). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | unset | Reserved; nothing is instrumented yet. |

### Web, cookies and auth

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `PUBLIC_API_URL` | **yes** | `http://localhost:3000` | Public API origin, e.g. `https://api.example.com`. Used in links the API signs. |
| `APP_CANDIDATE_ORIGIN` | **yes** | `http://localhost:3001` | Exact origin of the candidate app: CORS, WebSocket origin check and email links. |
| `APP_ADMIN_ORIGIN` | **yes** | `http://localhost:3002` | Exact origin of the admin app. |
| `SESSION_COOKIE_DOMAIN` | **yes** | unset | Shared parent domain, e.g. `.example.com` (section 8). |
| `SESSION_TTL_DAYS` | no | `7` | |
| `AUTH_SECRET` *(secret)* | **yes** | — | ≥ 16 characters; use `openssl rand -base64 32`. Peppers OTP hashes and signs local storage URLs. Rotating it invalidates outstanding OTPs. |
| `OTP_TTL_MIN` | no | `10` | |
| `OTP_MAX_TRIES` | no | `5` | |
| `OTP_REQUESTS_PER_HOUR` | no | `5` | Per email. |
| `OTP_IP_REQUESTS_PER_HOUR` | no | `20` | Per client IP (needs `TRUST_PROXY`). |
| `OTP_RESEND_COOLDOWN_SEC` | no | `30` | |
| `AI_ADMIN_CALLS_PER_HOUR` | no | `30` | Admin AI drafting limit. |

### Storage

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `STORAGE_PROVIDER` | **yes** (`s3`) | `local` | `local` writes to the server's disk under `LOCAL_STORAGE_DIR`: acceptable for a single server, but object storage is preferred for durability. |
| `S3_BUCKET` | with `s3` | unset | |
| `S3_REGION` | no | `ap-south-1` | For Hetzner Object Storage use its location, e.g. `fsn1`. |
| `S3_ENDPOINT` | with Hetzner | unset | S3-compatible endpoint, e.g. `https://fsn1.your-objectstorage.com` for Hetzner Object Storage. Leave unset on AWS. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` *(secret)* | with `s3` | — | Read by the AWS SDK; use the Hetzner Object Storage access key and secret. |
| `AUDIO_URL_TTL_SEC` | no | `300` | Lifetime of signed audio URLs. |
| `LOCAL_STORAGE_DIR` | no | `.data/storage` | With `local` only. |

### AI providers

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `LLM_PROVIDER` | **yes** (`gemini`) | `fake` | `fake` returns canned output: never in production. |
| `STT_PROVIDER` | **yes** (`gemini`) | `fake` | |
| `TTS_PROVIDER` | **yes** (`gemini`) | `fake` | |
| `GEMINI_API_KEY` *(secret)* | with `gemini` | unset | **Paid tier only**: free-tier content may be used by Google to improve its products. Configure zero or minimal data retention and record the DPA. |
| `GEMINI_STT_MODEL` | no | `gemini-3.8-flash` | LLM model ids live in the DB (prompt versions), not here. |
| `GEMINI_TTS_MODEL` | no | `gemini-3.8-flash-tts` | |
| `GEMINI_TIMEOUT_MS` | no | `30000` | ≥ 1000. |
| `ANTHROPIC_API_KEY` *(secret)*, `ANTHROPIC_BASE_URL`, `DEEPGRAM_API_KEY` *(secret)*, `ELEVENLABS_API_KEY` *(secret)* | no | unset | Alternative adapters, unused in R1. |

### Mail

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `MAIL_PROVIDER` | **yes** (`resend`) | `console` | `console` delivers nothing and logs the message id only. |
| `MAIL_FROM` | **yes** | `no-reply@preppilot.local` | An address on the Resend-verified domain. |
| `RESEND_API_KEY` *(secret)* | with `resend` | unset | |
| `MAIL_ALLOWLIST` | no | empty | **Leave empty in production.** When set, only listed addresses or `@domain`s get real mail; the rest go to the console outbox and are never delivered. |
| `MAIL_RATE_PER_SECOND` | no | `2` | Match the Resend plan's rate. |
| `SES_REGION` | no | `ap-south-1` | Only with `MAIL_PROVIDER=ses`. |

## 6. Redis and PostgreSQL

- Redis 7 on the same server, bound to `127.0.0.1`, with `requirepass` (or an ACL user). Use TLS (`rediss://`) only if it runs on another host.
- `maxmemory-policy noeviction`. BullMQ breaks if Redis evicts its keys, so size memory to fit rather
  than evict.
- AOF persistence on (`appendonly yes`, `appendfsync everysec`) so queued jobs survive a restart.
- One logical database per environment is enough. If environments share a server, give each a
  distinct `REDIS_PREFIX`: pub/sub ignores the DB index.
- PostgreSQL 16: listen on localhost (or the private network), a dedicated role with a strong
  password, `sslmode=require` if remote. Backups: nightly `pg_dump` (or WAL archiving with pgBackRest
  for point-in-time recovery) copied off the server, plus Hetzner server backups or snapshots. Do one
  restore drill before launch.

## 7. Object storage (S3-compatible)

- A private bucket (Hetzner Object Storage or AWS S3): no public access, no public ACLs.
- Encryption at rest per the provider (the app sends `AES256` on every put; check that the store accepts it).
- Optionally, a lifecycle rule expiring `audio/` after the workspace's `audioRetentionDays` (7, 30 or
  90; default 30), if the store supports it. The nightly purge job deletes expired audio itself, so the
  rule is only a backstop.
- Credentials need `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` and `s3:ListBucket` on the
  bucket. `ListBucket` also matters for `/api/ready`: without it, S3 answers a missing key with 403,
  which reads as storage down.
- Signed URLs live `AUDIO_URL_TTL_SEC` (5 min by default).
- No CORS rule is needed: the UIs load audio with plain `<audio src>` from presigned URLs.

## 8. Domains, reverse proxy, cookies and CORS

- **Domains:** put the API and both apps under one parent domain, e.g. `api.example.com`,
  `app.example.com` and `admin.example.com`. The session cookies (`HttpOnly`, `Secure`,
  `SameSite=Lax`) are set for `SESSION_COOKIE_DOMAIN=.example.com`, so the apps' server rendering can
  forward them. Each app has its own cookie, so signing in to one doesn't sign the other out:
  `pp_session` for the candidate app and `pp_admin_session` for the admin app. The API picks the
  admin cookie for requests whose Origin (or Referer) is `APP_ADMIN_ORIGIN`, and for the admin
  app's server rendering, which sends `X-PrepPilot-App: admin`. The API's `Cross-Origin-Resource-Policy: same-site` header also assumes one site:
  API-served resources from another registrable domain would be blocked.
- **CORS:** only `APP_CANDIDATE_ORIGIN` and `APP_ADMIN_ORIGIN`, exact, scheme included, no trailing slash.
- **TLS** ends at the reverse proxy. Set `TRUST_PROXY=1` so `req.ip` is the client, not the proxy.
- **WebSockets:** the proxy must pass `Upgrade` requests on `/api/ws/sessions/:id` and keep idle
  connections open (300 s or more). Caddy does both by default; nginx needs the `Upgrade`/`Connection`
  headers and `proxy_read_timeout 300s`.
- **Uploads:** allow request bodies of at least 25 MB (the voice answer limit). Caddy has no limit by
  default; nginx needs `client_max_body_size 30m`.
- **Example Caddyfile:**

  ```caddyfile
  api.example.com {
    reverse_proxy 127.0.0.1:3000
  }
  app.example.com {
    reverse_proxy 127.0.0.1:3001
  }
  admin.example.com {
    reverse_proxy 127.0.0.1:3002
  }
  ```
- **Security headers** come from the API itself: `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, CORP `same-site` and, with `NODE_ENV=production`, HSTS. There's no
  `X-Powered-By`. Frontend CSP is set in each frontend.

## 9. Health endpoints

| Endpoint | Process | Use | Answers |
| --- | --- | --- | --- |
| `GET /api/health` | API | Liveness and uptime monitoring | Always `200 {status:'ok', db, redis}` while the process is up. |
| `GET /api/ready` | API | Post-restart gate, external monitoring | `200 {status:'ready', db:'ok', redis:'ok'\|'disabled', storage:'ok'}`, or `503` with `status:'not_ready'` and the failing parts marked `'error'`. |
| `GET /ready` on `WORKER_HEALTH_PORT` | worker | Local check (`curl 127.0.0.1:3010/ready`); don't expose it publicly | Same body and status codes. Other paths are `404`. |

Each check (DB `SELECT 1`, Redis `PING`, storage lookup) has a 1 s timeout, and they run in
parallel, so the probe answers within about 1 s. Point an external uptime monitor at
`https://api.example.com/api/ready` with a timeout of 3 s or more.

## 10. Frontends

Each Next.js app is built and run the same way as the backend: a checkout under `/srv/preppilot`,
`npm ci && npm run build`, then a systemd service running `npx next start -p 3001` (candidate) or
`-p 3002` (admin) with `NODE_ENV=production`, behind the reverse proxy. Each needs, at build time:

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_API_BASE_URL` | `https://api.example.com/api` (browser calls) |
| `API_BASE_URL` | The same, or an internal URL for server-side calls, still ending in `/api` |

Their origins must equal `APP_CANDIDATE_ORIGIN` and `APP_ADMIN_ORIGIN` exactly.

With `STORAGE_PROVIDER=s3`, audio and export downloads redirect to presigned S3 URLs, which the
apps' Content Security Policy blocks unless it lists the bucket's origin. Set the optional **build
time** variable `CSP_STORAGE_ORIGINS` to that origin, e.g.
`https://<bucket>.fsn1.your-objectstorage.com` for Hetzner Object Storage (several origins: space or
comma separated), and
rebuild the app when it changes:

- **Admin app:** needed, or review audio and CSV exports fail with a CSP error.
- **Candidate app:** needed for card, question and answer audio. It validates entries the same way.

## 11. Release checklist

1. On the server: `git fetch && git checkout <sha>`, `npm ci`, `npm run build`.
2. Run `npx prisma migrate deploy` (section 4). On a new environment's first deploy, run the
   bootstrap next (section 12).
3. Restart the worker, then the API: `sudo systemctl restart preppilot-worker preppilot-api`. Wait for
   `/ready` and `/api/ready` to return 200.
4. Rebuild and restart the frontends if they changed.
5. Run the smoke checks (section 13).

## 12. First deploy

A new environment's database is empty: no settings, prompts or admins, so nobody can log in.
Once per environment:

1. **Migrate:** run `npx prisma migrate deploy` as in section 4. The migrations also insert the
   prompt versions and the ServiceNow job roles with their default content (section 4).
2. **Bootstrap:** from the server checkout (it has the dev dependencies the script needs):

   ```sh
   BOOTSTRAP_ADMIN_EMAIL=ops@example.com BOOTSTRAP_ADMIN_NAME="Ops Lead" \
     DATABASE_URL=... node --import tsx scripts/bootstrap.ts
   # or keep the variables in a file outside the repo:
   node --env-file=/secure/path/bootstrap.env --import tsx scripts/bootstrap.ts
   ```

   It creates only what production needs:
   - the workspace settings row: the defaults, sender name "PrepPilot" and no reply-to (set
     both in the admin app's settings);
   - version 1, active, of each prompt role that has no rows yet;
   - the system saved filters;
   - the first super admin, `BOOTSTRAP_ADMIN_EMAIL` (required), with `BOOTSTRAP_ADMIN_NAME`
     (optional), as an active `super_admin`. If the address already exists, the user is made an
     active super admin with no access expiry. A user pending erasure is refused.

   It creates no candidates or demo admins. It is idempotent: a re-run prints
   `Bootstrap complete: nothing to do.` It prints ids only (exit code 0 done, 1 failed). It never
   overwrites existing settings, prompts or an admin's name; it only resets a changed system
   saved filter to its definition in code.
3. **Start** the worker and the API (section 3), and wait for `/ready` and `/api/ready` to return
   200.
4. **Log in** to the admin app as `BOOTSTRAP_ADMIN_EMAIL`: request a code through the normal OTP
   flow, and it arrives by mail. Then set the sender name and reply-to, invite the other admins,
   and review and approve the job roles.

Then run the smoke checks below.

## 13. Post-deploy smoke checks

- [ ] `curl -i https://api.example.com/api/health` returns 200; the security headers and HSTS are present, and there's no `X-Powered-By`.
- [ ] `curl -i https://api.example.com/api/ready` returns 200 with `db`, `redis` and `storage` all `ok`.
- [ ] The worker's `/ready` returns 200.
- [ ] Login: request an OTP for a real invited address; the mail arrives from the verified domain, and the code signs you in on both apps.
- [ ] Typed interview: start a session, answer one question in text mode; feedback arrives.
- [ ] Voice: question audio plays; a recorded answer is transcribed and evaluated, and its playback works.
- [ ] Admin: the dashboard loads, a candidate's review plays audio, and one setting change appears in the audit log.
- [ ] Logs are JSON with request ids and contain no transcripts, names or emails.

## 14. Before launch: secrets and checks

- **Rotate every secret used in development**: `AUTH_SECRET`, the Gemini and Resend keys (they appeared
  in chat transcripts), database and Redis passwords, and any AWS keys. Production values live only
  in `/etc/preppilot/*.env` (mode `600`), never in the repo, `.env` files committed anywhere, or chat.
- Gemini: paid tier, zero or minimal data retention, and a DPA recorded. Resend: verified domain, DPA
  recorded, `MAIL_ALLOWLIST` empty.
- Backups: Postgres PITR on, one restore drill done, and the post-restore erasure re-run documented
  (implementation plan §13).
- The rest of the security checklist is in the plan:
  [05-production-ops.md, "Security checklist before launch"](../plans/production-readiness/05-production-ops.md#security-checklist-before-launch).

## 15. CI

`.github/workflows/ci.yml` runs on every push and pull request to `main` and `kartik`, on Node 24,
with three jobs:

| Job | Services | Steps |
| --- | --- | --- |
| `unit` | none | `npm ci`, typecheck, lint, unit tests, build |
| `e2e` | `postgres:16` | `prisma migrate deploy`, dev seed, `test:e2e` with the in-process queue |
| `e2e-redis` | `postgres:16`, `redis:7` | As `e2e`, with `REDIS_URL` and `REDIS_PREFIX` set, so queues run on BullMQ |

Tests use fake LLM, speech to text and text to speech providers and console mail, so CI needs no
provider keys or secrets. `AUTH_SECRET` is a dummy, CI-only value in the workflow.
