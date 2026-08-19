# Architecture

```text
External AI / future Internal AgentRuntime
                    |
             MCP / CLI / HTTP
                    |
             AutopilotService
       +------------+-------------+
       |            |             |
 Project/Resource  Context    Workflow + Dependency
     Registry      Engine           Engine
       |            |                |
       +------ PolicyEngine ---------+
                    |
          Planner -> ArchitectureGuard
                    |
          ExecutionEngine -> Git adapter
                    |
          TestEngine -> IndependentReviewer
                    |
        Artifacts + append-only Audit + Runs
                    |
          StateStore port -> PostgreSQL
```

`AutopilotService` is the application boundary shared by MCP, CLI and HTTP. Domain contracts are Zod schemas and inferred TypeScript types. PostgreSQL is control-plane storage; Git workspace execution, target test runners, target databases, GitHub, Supabase, task sources, LLMs and secret stores are adapters behind ports.

## Isolation and authority

Every entity carries `projectId`; store queries for private objects include it. Every external write names a registered `resourceId`, and `PolicyEngine` verifies ownership, status, environment and permission. The registered local Git external reference must exactly equal the project's normalized workspace. There are no global mutable current-project variables.

## Lifecycle and readiness

Transitions are persisted with actor, reason, timestamp and artifact references. Dependency edges of type `DEPENDS_ON` must point to `READY` tasks. A plan is created before execution and reviewed by project-independent rules. Execution stores base commit, branch, commit, diff and version metadata. Required test classes are derived from the plan. Independent review evaluates coverage, architecture, security, ownership, API, migration, tests, error handling, races, idempotency, observability and rollback.

`READY` requires implementation, ArchitectureGuard, all required suites, IndependentReview, and mandatory artifacts. Failed tests return to implementation until `maxAutoRepairAttempts`; then the task is `BLOCKED`.

## Project context

Context is versioned sections, not a prompt. Every section records source type/reference, import time, hash, and `trustedAsInstructions: false`. Repository/task text is always data and cannot alter policy.

## Persistence and recovery

Projects, resources, context versions, tasks, transitions, runs, artifacts and audit events are stored in PostgreSQL JSONB envelopes with relational ownership/index columns. Runs contain platform/workflow/policy/context versions and Git metadata. Temporary workspaces are recoverable from registered metadata and Git.

## Provider extension

Add an adapter implementing the appropriate port; never import provider types into Core. Provider-specific credentials remain secret references, resolved at runtime. The unchanged Core can support another Git host, relational database, task tracker or LLM provider.

Architecture decisions are in `docs/adr/`.
