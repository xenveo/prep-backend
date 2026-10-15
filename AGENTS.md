# PrepPilot backend: agent guide

NestJS + Prisma + PostgreSQL API for PrepPilot, an invite-only AI interview prep tool. It serves two Next.js clients, `../prep-candidate-ui` and `../prep-admin-ui`. Both are mock-only today; this backend replaces their mocks without changing their screens.

## Read before coding

| Doc | Use it for |
| --- | --- |
| `docs/BACKEND_SPEC.md` | **What** to build: endpoints, shapes, data model, scoring, NFRs, UI-vs-SRS decisions |
| `docs/BACKEND_IMPLEMENTATION.md` | **How** to build it: stack, folder layout, Prisma schema sketch, pipeline, jobs, milestones (M0–M8), product decisions (§13) |
| `docs/SRS.txt` (text) / `docs/Software Requirements Specification AI Interview Prep Tool.pdf` | Source of truth for scope. Requirement IDs (`FR-INT-04`, `NFR-06` …) are cited throughout |
| `../prep-candidate-ui/lib/types.ts`, `lib/api.ts` | Candidate API contract: response shapes must match |
| `../prep-admin-ui/src/lib/types.ts`, `src/services/*.ts` | Admin API contract: one endpoint per service function |

The UIs are read-only references from this repo. Never edit them from here.

When the spec and the SRS disagree, the spec's "UI vs SRS gaps" section and the implementation plan's §13 hold the decisions. Anything not covered there is an open question: ask, don't invent.

## This is not the NestJS / Prisma you know

These versions are newer than most training data. Check the installed code (`node_modules/@nestjs/*/**/*.d.ts`, `node_modules/prisma`, `node_modules/@prisma/client`) before using an API from memory. Heed deprecation notices.

- **NestJS 12**, ESM (`"type": "module"`, `module: nodenext`). Relative imports **must** end in `.js` (`import { X } from './x.service.js'`). `main.ts` uses top-level `await`.
- **Prisma 7.10**:
  - Config lives in `prisma.config.ts`; `DATABASE_URL` is loaded there via `dotenv`, never in `schema.prisma`.
  - The generator is `prisma-client` with output in `src/generated/prisma`. That directory is generated and gitignored, so never edit it. Import from `../generated/prisma/client.js`.
  - The client needs a driver adapter: `PrismaService` builds it with `@prisma/adapter-pg`.
  - `npm install` runs `prisma generate` via `postinstall`. Re-run `npm run prisma:generate` after any schema change.
  - Don't upgrade to the Prisma 8 RC that npm currently tags `latest`.
- `.agents/`, `.claude/skills/`, `.windsurf/` and `skills-lock.json` were added by `prisma init`. They are Prisma's own skill docs, useful for Prisma questions. Treat them as reference, not as project rules.

## Commands

```
npm run start:dev                     # watch mode, http://localhost:3000
npm run typecheck                     # tsc --noEmit
npm run lint                          # oxlint src/ test/
npm test                              # vitest unit tests (src/**/*.spec.ts)
npm run test:e2e                      # vitest e2e (test/**/*.e2e-spec.ts); needs Postgres from .env
npm run build                         # nest build → dist/
npm run prisma:migrate -- --name <n>  # create and apply a migration (dev DB only)
npm run prisma:generate
npm run prisma:studio
```

Local DB: `postgresql://postgres:postgres@localhost:5432/prep_db?schema=public` (`.env`, gitignored; copy from `.env.example`).

## Project conventions

- **Layout:** follow `docs/BACKEND_IMPLEMENTATION.md` §2.
  - `src/common/` holds guards, errors, audit, pagination, rate limit and idempotency.
  - `src/adapters/` holds the LLM, STT, TTS, mail and storage adapters, each an interface plus implementations and a fake.
  - `src/modules/<feature>/` holds the controller, service, DTOs and specs.
  - `src/jobs/` holds the BullMQ processors.
- **Module boundaries:** dependencies run one way, `auth → users → content → interview → reports`. A module calls another module's **service**, never its Prisma queries directly. `PrismaModule` is global; inject `PrismaService`.
- **API shape:**
  - Routes sit under `/api`; admin routes under `/api/admin`.
  - Responses match the UI types exactly (field names and casing). Enum values are canonical in the DB and mapped to each UI's values in serializers (plan §10).
  - Errors are always `{error: {code, message}}`, with codes from the spec.
- **Validation:** Zod schemas for every request body and query, and for every LLM output. Never trust candidate text: it is data, passed to prompts inside delimiters only.
- **Auth:** every route is authenticated unless marked public, and roles are checked server-side (`@Roles(...)`). Unassigned or unapproved roles return `404`, not `403`.
- **Audit:** every admin mutation writes an `AuditLog`, using the action strings the admin UI already emits.
- **Config, not code:** prompts, model ids, scoring weights, delivery targets and retention live in the DB (NFR-12). Secrets and infrastructure live in env vars.
- **Privacy (DPDP Act 2023, India hosting):**
  - Never log transcripts, names or emails; log ids only.
  - Every query on user-owned data must respect erasure stage 1 (`users.deletedAt IS NULL`).
  - New user-linked tables need `ON DELETE CASCADE` so the purge job erases them.
- **Scoring:** keep it in pure functions under `modules/interview/scoring/`, with unit tests for band edges (49/50, 69/70, 84/85) and the skipped-retry case.
- **Tests:** a unit spec beside each service. Use e2e for HTTP flows, with fake adapters and no real provider calls in tests.
- **Style:** Prettier (`.prettierrc`) and oxlint. Match surrounding code, and prefer editing existing files to creating new ones. No dead code, debug output or unplanned dependencies.

# Multi-agent workflow

Work is done by one **Coordinator** and several **Coder** agents running in parallel. The Coordinator plans, architects and reviews; Coders implement.

## Roles

### Coordinator (planner, architect, reviewer)

The Coordinator never implements feature code itself. It:

1. **Plans:** reads the request, the spec section and the milestone in the implementation plan, then breaks the work into tasks.
2. **Architects:** decides module boundaries, Prisma models, DTOs and Zod schemas, service interfaces and adapter contracts *before* any Coder starts, so Coders don't have to guess or collide. A schema change goes through one owner, the Coordinator or a single designated Coder.
3. **Dispatches:** launches Coders in parallel (one message, multiple Agent calls), each with a self-contained brief.
4. **Reviews:** reads every Coder's diff, checks it against the plan, the spec and the conventions above, runs verification, and sends fixes back (via SendMessage to the same Coder) until it passes.
5. **Integrates:** resolves cross-task issues, runs migrations and the final typecheck, lint, test and build, then reports to the user.

### Coder

Each Coder owns one task and implements exactly that. It:

- Edits **only** the files listed in its brief (its "ownership set").
- Follows the interfaces, DTOs and models the Coordinator specified; it does not redesign them.
- Never edits `prisma/schema.prisma` or creates migrations unless the brief names it as the schema owner.
- Runs `npm run typecheck`, `npm run lint` and `npm test` on its work before reporting.
- Reports back: files changed, anything that deviates from the brief, and open questions. It does not commit.

If a Coder needs a change outside its ownership set, it stops and reports it rather than making the edit.

## Parallel execution rules

- **Decompose by file ownership.** Two Coders must never edit the same file. `schema.prisma`, `app.module.ts` and shared `common/` files are typical collision points: the Coordinator owns them or sequences the work.
- **Contracts first.** Prisma models, DTO and Zod schemas, service method signatures and adapter interfaces are defined up front, in the briefs or in stub files the Coordinator writes, so parallel Coders build against the same contract.
- **Parallel by default, sequential only on real dependencies.** Independent tasks launch together in one message. A task that needs another's output (usually a migration) waits for it.
- **Use worktree isolation** (`isolation: "worktree"`) when tasks touch adjacent files or run builds, migrations or e2e tests that could interfere. E2e runs share one database, so don't run them in parallel against the same `DATABASE_URL`.
- **Keep it proportionate.** Trivial or single-file changes: the Coordinator does them directly, with no Coders. Typically 2–5 Coders; more only when tasks are truly independent.

## Task brief template

Every Coder brief must be self-contained (the Coder has no other context):

```
Goal:        one sentence on what and why (cite spec section / FR id)
Files owned: exact paths to create/edit (and nothing else)
Contract:    models / DTOs / Zod schemas / signatures / response shapes to implement or consume
Context:     docs sections and files to read first, conventions that apply
Constraints: what NOT to do (e.g. don't touch schema.prisma, don't add deps)
Done when:   concrete acceptance criteria + commands to run
Report:      files changed, deviations, open questions
```

## Review checklist (Coordinator)

- Matches the plan, the spec and the contract; nothing outside the ownership set changed.
- Response shapes match the UI types; error codes come from the spec.
- Auth guard and role checks are present, admin mutations are audited, and input is validated with Zod.
- No personal data in logs. Erasure filters are applied, and new user-linked foreign keys cascade.
- ESM `.js` import suffixes, and Prisma imports from `src/generated/prisma`. No new dependencies, dead code or debug output unless the plan called for them.
- `npm run typecheck`, `npm run lint` and `npm test` pass; for integration, `npm run test:e2e` and `npm run build` pass too.
- Edge and error cases are handled (404 versus 403, idempotent retries, provider failures that fall back to text mode).
- Diffs from different Coders fit together: imports resolve, migrations apply cleanly from scratch, and shared contracts are honored.

## Rules for all agents

- Check the installed NestJS and Prisma APIs (see above); do not rely on memory of older versions.
- Never commit, push or modify git state unless the user asks. Only the Coordinator may do so, and only on request.
- Never run destructive DB commands (`prisma migrate reset`, `db push --force-reset`, dropping tables) without the user's go-ahead.
- Never put real secrets in code, docs or `.env.example`.
- Prefer editing existing files to creating new ones; match the surrounding style.
