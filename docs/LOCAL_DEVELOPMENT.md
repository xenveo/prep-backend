# Local login mode

Run the backend with a local PostgreSQL database and a shortcut for the local super-admin account:

```sh
cd prep-backend
npm install
# Configure .env from .env.example with a local DATABASE_URL and AUTH_SECRET.
# Apply pending migrations to that local database if needed:
npm run prisma:deploy
npm run start:local
```

This command loads `.env`, prepares the workspace settings/prompts/system filters and the `superadmin@xenveo.com` account using the existing idempotent bootstrap, then starts the API in watch mode. It requires an already migrated database on `localhost`, `127.0.0.1` or `::1`; it refuses production mode and remote database URLs. A user pending erasure is not restored. Bootstrap failure stops startup.

In another terminal, start the admin frontend:

```sh
cd prep-admin-ui
npm run dev
```

Open `http://localhost:5174/login`, enter **superadmin@xenveo.com**, continue to the OTP screen, and enter **any six digits**, such as `123456` or `000000`. No login-code email is sent for this account. The usual real session cookie and backend authorization still apply. Other accounts continue through their normal email-code flow.

The local command scopes the existing any-code setting to this exact address. It sets the API URL to `http://localhost:3000` (or the `PORT` in `.env`), the admin origin to `http://localhost:5174`, and candidate origin to `http://localhost:5173`. It removes deployed cookie-domain/proxy behavior for local requests and runs API and jobs together. These overrides apply only to the child processes; `.env` is not edited, and normal startup commands keep their existing behavior.

Local mode always binds the API to IPv4 loopback (`127.0.0.1`), overriding any inherited `API_BIND_HOST`, so the any-code shortcut is unavailable through the machine's LAN interfaces. Continue using the `localhost` URLs above. Normal startup keeps its existing listening behavior unless `API_BIND_HOST` is explicitly configured. Production rejects any-code mode even if an allowlist is supplied.

Restart `npm run start:local` after updating to this version: an already-running process keeps its previous listening interface until it restarts.

Both frontend API variables, `NEXT_PUBLIC_API_BASE_URL` and `API_BASE_URL`, should point to `http://localhost:3000/api` (their default). If you change the backend `PORT`, update both variables accordingly. Use `localhost` consistently for the frontends and API so session cookies work.

`Ctrl+C` stops the local process tree. Running the command again reuses the local account and workspace data. It does not reset the database or create mock candidates or sessions.
