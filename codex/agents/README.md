# PrepPilot integration agents

These seven standalone TOML agent definitions implement the workflow in [prep-admin-ui/AGENTS.md](../../../prep-admin-ui/AGENTS.md) for [INTEGRATION_PLAN.md](../../INTEGRATION_PLAN.md).

| Agent name / file | Responsibility |
| --- | --- |
| [`coordinator`](coordinator.toml) | Plan, freeze contracts, assign ownership, dispatch Coders, review and integrate |
| [`coder`](coder.toml) | A bounded general task, especially transport/store foundations or authentication |
| [`backend_coder`](backend_coder.toml) | Backend contract gaps, serializers, authorization and asynchronous jobs |
| [`admin_coder`](admin_coder.toml) | Admin services, authoring, candidates, review/reports and settings/export UI |
| [`candidate_coder`](candidate_coder.toml) | Candidate study, recording, attempts, results/history and privacy UI |
| [`reviewer`](reviewer.toml) | Read-only contract, correctness and security review |
| [`qa`](qa.toml) | Assigned checks and acceptance journeys, with reproducible evidence |

The general Coder can be instantiated for several independent tasks. Role files are reusable instructions, not task assignments or permission grants. Each Coder needs a self-contained brief with exact files and acceptance criteria. Models and reasoning inherit from the parent session. Permissions also inherit; the Reviewer and QA read-only behavior is an instruction, not an independent sandbox. No role changes the parent's approval policy.

## Load the definitions

This repository keeps the versioned definitions in **`prep-backend/codex/agents/`**, relative to the three-project workspace. The original requested workspace source location was **`./codex/agents/` without a leading dot**; convenience copies may still exist there. Codex's documented project discovery location is **`.codex/agents/`**. Merely creating these source files does not register them automatically. Current standalone definitions use `name`, `description` and `developer_instructions`. See the [official custom agent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents).

To enable automatic discovery for a future session, copy the definitions into the native project location from the ProjectPrep workspace root:

```sh
mkdir -p .codex/agents
cp -n prep-backend/codex/agents/*.toml .codex/agents/
```

The copy preserves any existing destination files. If a role already exists, inspect and merge it deliberately. Keep `prep-backend/codex/agents/` as the versioned sources, and refresh the native copies after updates. Start a new Codex session rooted at `ProjectPrep` after installation. Check that the client exposes the role names before dispatch. The files were not copied into `.codex` as part of this planning task.

For this workspace's three separate repositories, launch from `ProjectPrep` so plan paths and both frontend/backend projects resolve consistently. Opening only one child repository may require loading the parent project's instructions/roles explicitly. Older clients with a different configuration schema should be checked against their own supported configuration before installation.

## Start planning

Use this prompt in the workspace session:

```text
Use the coordinator role for PrepPilot integration. Read prep-backend/INTEGRATION_PLAN.md and
the three project AGENTS.md files. Check current code against P0, freeze contracts
and prepare exact ownership briefs. This is planning only; do not implement yet.
```

After implementation is authorized, a suitable prompt is:

```text
Act as the Coordinator described in prep-backend/codex/agents/coordinator.toml. Implement
prep-backend/INTEGRATION_PLAN.md in dependency order. Delegate foundations/auth to coder,
backend gaps to backend_coder, and frontend workflows to admin_coder and
candidate_coder. Launch independent tasks in parallel after contracts are frozen.
Use reviewer and qa for acceptance, send fixes to the same owning Coder, and
report actual checks and remaining blockers. Do not commit or push.
```

The primary session can follow the Coordinator instructions directly, avoiding an unnecessary nested Coordinator thread. If named custom roles are unavailable, read these TOML instructions and attach the complete applicable instructions to supported worker briefs; do not claim that unregistered roles have been loaded.

## Working agreement

- Coordinator owns the plan, contracts and ownership ledger; Coders implement feature code.
- Freeze shared interfaces first. Assign each file to one owner. Expand planning directory scopes into exact file paths in each brief.
- Usually run 2–5 Coders. Keep trivial work proportionate. Reuse the owning Coder for corrections.
- Tell Coders they are not alone; preserve others' work and request reassignment for out-of-scope changes.
- Use repository-specific worktrees only when isolation is needed and authorized. Builds, migrations and shared-database e2e runs need explicit sequencing.
- Frontend Coders run typecheck/lint; Backend Coders also run unit tests. Coordinator runs integration builds and backend e2e when implementing. Planning/documentation work does not trigger application acceptance suites.
- Report files changed, exact validation results, deviations and open issues. Never report checks as passed when they were not run.
- No commits, pushes or other Git-state changes without the user's instruction.

The supplied files were written against the documented standalone TOML format and the local CLI version observed during review, `codex-cli 0.162.1`. TOML parsing is distinct from live discovery or runtime execution; no integration implementation or runtime role activation is implied by these artifacts.
