# Executive dashboard implementation plan

## Scope

Power all three executive-dashboard tabs from authenticated backend APIs and remove runtime mock data from the admin page. All users with admin or super-admin access are recruiters, including candidate accounts with `adminRole`. Preserve the current layout and unrelated work. No schema change is required for the two primary questions.

## Reporting rules

- Report months use UTC calendar boundaries. Default to the current UTC month; cap the report cutoff at now, so future events never leak into current or historical results. Reject invalid/future periods.
- Keep the mock's observation convention: a selected reporting month measures the previous month's **first invitations**, followed through the report cutoff. Find the earliest invitation across all history before filtering the cohort; a resend never adds a person or changes the original inviter. Invitations are issuance, not delivery confirmation.
- Acceptance means first sign-in within seven days after first invitation. Only invitations with a complete seven-day window at cutoff enter the acceptance denominator; show pending observation windows separately. Admin invitations never count as candidate invitations.
- Attribute cohort results to the original inviter. Retain an explicit unknown-inviter group if the actor is missing, erased, or no longer identifiable as a recruiter. Include admins with no invitations, so zero activity remains visible. Do not infer ongoing ownership.
- Invites and acceptance count unique people. Performance compares **candidate–role pairs**; a person with multiple roles may contribute multiple pairs. Display both units explicitly, including paired sample sizes and unassigned invitees.
- For each pair, compare first and latest completed, scored, non-preview sessions through cutoff. Include only pairs with two or more sessions in averages and gains; keep single-session and unassessed pairs visible separately. Average the same pairs at both ends and calculate team results from underlying pairs, not averages of recruiter averages.
- Exclude erased candidates everywhere, including SQL joins, nested sessions and flags. Use stored readiness bands rather than current hard-coded thresholds. Respect current assignment removal/access rules for attention lists.
- Role membership is established by assignments dated before cutoff and/or historical non-preview sessions before cutoff. Assignment transfers, access changes and `lastActiveAt` are not fully historized: disclose those limits instead of fabricating history. Historical results can change after erasure.

## API contract

The maintained TypeScript contract is `prep-backend/src/modules/reports/executive.types.ts`, mirrored in the admin service types. Query validation uses Zod. All routes require admin/super-admin access and use existing errors/cookies.

1. `GET /api/admin/reports/executive?period=YYYY-MM&roleId=UUID`
   - Cutoff/cohort metadata, role/recruiter/filter options, recruiter rows and reconciled team summary.
2. `GET /api/admin/reports/executive/candidates?period=YYYY-MM&roleId=UUID&recruiterId=UUID|unknown&search=...&page=1&pageSize=10`
   - Scope-wide paired summary and role comparisons; server-paginated candidate–role rows. Search affects the table/count, not the headline comparison cohort. Recruiter and role filters affect both. Stable ordering prevents rows jumping between pages.
3. `GET /api/admin/reports/executive/insights?period=YYYY-MM&roleId=UUID`
   - Live readiness by role, first-practice/repeat funnel with separate matured denominators, coaching dimensions/hard questions, attention cases and scoring-flag/session-quality summaries.
   - Review coverage, contact compliance, surveys and feedback timing remain explicitly unavailable; no fabricated success rates. Current/historical limitations accompany the response.

Use parameterized, bounded-date/bulk queries; avoid queries per candidate. Paginate personal data at the API, not merely in the browser. No provider calls, writes, migrations, or new dependencies are needed to read this dashboard.

## Implementation sequence and ownership

1. Freeze this plan and shared backend response types before implementation.
2. Backend primary reporting owner: query schemas, cohort/session read model, recruiter and candidate service/controller, unit and HTTP/database regression tests. Wire it into ReportsModule.
3. Backend supporting insights owner: dedicated insights service and tests using existing reporting rules, bounded queries, and the shared contract.
4. Admin integration owner: mirror API types, service requests, replace live-screen mock derivations, preserve URL-backed filters and UI, add loading/error/retry/empty states, and server pagination/search. Load supporting insights only on tab three. Keep candidate frontend untouched.
5. Coordinator reviews diffs, resolves contract mismatches, runs backend/admin typechecks, lint and builds plus unit and targeted e2e tests. Database tests run serially on isolated fixtures; never reset/drop the user's database.

## Acceptance checks

- Recruiter table and candidate comparisons reconcile for multiple roles and recruiter filters.
- Tests cover repeated invitations and inviter attribution, missing inviters, zero-activity admins, dual admin access, acceptance-window boundaries, multi-role deduplication, same-pair weighted gains, zero denominators, one-session/negative/flat scores, preview/erased exclusions, date cutoffs, bad queries, stable pagination and authorization.
- Supporting metrics distinguish unfinished sessions from abandonment, use stored bands, exclude future completions/resolutions, and return null where a measure is unavailable.
- API failures show actionable UI errors without silently falling back to mock data. Empty databases show honest empty results and usable filters.
- Record exact checks and any database/environment blockers after implementation.

## Status

Implemented and verified on 2026-11-02.

- All three endpoints are registered in ReportsModule, require admin access, and return `Cache-Control: no-store`.
- The admin executive page uses live API requests with server-side candidate search/pagination and lazy-loaded insights. The original mock-data file remains an unused design reference; the live feature has no runtime import of it.
- Backend typecheck, lint and build passed. Full unit suite: **97 files, 937 tests passed**.
- PostgreSQL-backed executive, executive-insights and existing reports regression suites ran serially: **3 files, 33 tests passed**. Fixtures clean up their own records; no database reset was run.
- Admin typecheck, lint and production build passed. Mirrored wire contracts, request construction, credentialed/no-store transport, pagination/search encoding, UTC formatting and absence of runtime mock imports were also checked.
- The running local backend responds `401` to an unauthenticated executive request, confirming the route is registered and protected.
- No schema migration or new dependency is required. Historical ownership, inactivity, erasure and missing-event limitations remain explicit in API metadata and the dashboard.

Integration verification corrected fixture enum/concurrency constraints and added a regression for assignments removed after a historical attention cutoff. All final checks above passed after those corrections.
