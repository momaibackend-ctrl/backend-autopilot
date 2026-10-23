# ADR 026: Missions, repository roles and the project brief

Status: accepted for v0.5. Owner decision. First of three stages; stages 2 and 3 are listed under "Next".

## Context

A product can need several repositories at once, and the Momna port shows why:

- the working Kotlin service, which is deployed and passed its tests;
- its sandbox, where work is assembled before it reaches the working one;
- the Java port, built because the backend developer works in Java.

The Kotlin service stays the reference until the Java port matches it completely. Then it is archived, not deleted, in case it is ever needed again.

None of that was recorded anywhere an agent could read. A repository was just "registered". When a remote agent's session ended (a new chat, or an overflowed context), the next session had nothing to start from. It rediscovered the project by repository name, took the wrong Kotlin repository for the one to compare against, and drifted into staging health checks, Railway and database inspection that had nothing to do with the work. The control plane held every fact it needed: the task, the branch, the 6/45 coverage verdict and the Gradle diagnosis. But no tool handed them over, and the server gave no hint where to begin.

## Decision

**Repository roles.** Each registered GitHub repository can carry a `role` and a one-line `purpose`. Both are stored in the resource document, so no migration is needed.

| Role | Meaning |
|---|---|
| `WORKING` | Deployed and relied on. |
| `SANDBOX` | Where work is assembled before it reaches `WORKING`. |
| `PORT` | A reimplementation on another stack, built until it matches a reference. |
| `ARCHIVE` | Kept for recovery; nothing is developed there. |

`superadmin_repository_role_set` records them. `ARCHIVE` is refused while an open mission still builds in the repository or compares against it. A reference is retired only after the port has been proven to match it.

**Missions.** A mission is a product goal that outlives every session. It is stored in a new `missions` table: key, title, goal, attached tasks and status. The table is additive and every statement is `IF NOT EXISTS`. There are two kinds of goal:

- `PARITY` (target, reference): the target answers every scenario of every contract exactly as the reference does. The proof is an HTTP E2E comparison run (ADR 018–020).
- `DELIVERY` (target): the attached tasks reach READY.

**Progress is derived, never stored.** `missionProgress` (`packages/core/src/mission.ts`) is a pure function. It reads the registrations, each attached task's readiness, the newest comparison job of the target against the reference with its recorded evidence and diagnosis, and the target's current head. It returns steps, each `DONE`, `RUNNING`, `REMAINING` or `FAILING` with its detail and the exact next call with arguments:

- `REPOSITORIES`;
- `TASKS`;
- `PARITY` (PARITY missions only).

A known failure outranks remaining work, and both outrank waiting. A proof made at an older commit than the target's head does not count. A job that ended without evidence is a failure with its own reason. `superadmin_mission_update status=ACHIEVED` is accepted only when the derived progress is complete, so a mission can never read as further along than its evidence.

**The project brief.** `superadmin_project_brief` is the first read of every session. It returns:

- the repositories, each with role, purpose, canonical flag and the missions it serves;
- every mission with its progress;
- open tasks outside missions;
- jobs in flight;
- setup calls for repositories without a role, or a project without a mission;
- one overall `nextAction`;
- the working rules.

**Server instructions.** The MCP server now sends instructions at initialize, so every client sees them before choosing a tool: start with the brief, continue with its `nextAction`, do not rediscover the project from deployments or databases, and treat a failure as a cause to fix. The tool surface version moves to 0.5.11.

All three mutations follow the superadmin rules: Zod input, operation-ID idempotency, `mcp.<tool>` audit, refusal audit, and production denial.

## What stays

Nothing here relaxes a gate. READY, PolicyEngine, the Resource Registry, the production hard stop and secret handling are unchanged. Roles describe; they do not grant. A mission reads evidence; it cannot create any.

## Next

- **Stage 2.** A driver that keeps work moving. Today the scheduled reconciler parks an IMPLEMENTING task in BLOCKED when its job stalls. It should restart the stalled step, and advance a mission's mechanical steps on its own.
- **Stage 3.** Bring every Momna repository into one project with roles, and open the Java parity mission.
- **Later, an internal agent.** Code changes come from the external agent (GPT over MCP) for now. An internal coding agent is a later, separate decision.
