# Architecture

```text
External AI / future Internal AgentRuntime
                    |
   HTTP MCP / CLI / HTTP / Operator Console
                    |
       AutopilotService + SuperadminService
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

`AutopilotService` is the project lifecycle boundary shared by MCP, CLI and HTTP. `SuperadminService` composes the same ports and services for global administration, enforces the `SUPERADMIN` principal role, owns mutation idempotency and emits one `mcp.<tool>` audit event per semantic change. Superadmin bypasses membership lookup only: it never bypasses resource ownership, PolicyEngine, command policy, formal READY gates, immutable evidence or production denial. Domain contracts are Zod schemas and inferred TypeScript types. PostgreSQL is control-plane storage; Git workspace execution, target test runners, target databases, GitHub, Supabase, task sources, LLMs and secret stores are adapters behind ports.

`SandboxBootstrapService` is a separate application boundary for external provisioning. It requires `AUTONOMOUS_STAGING`, dedicated account/organization resources, semantic provider calls, idempotency IDs, manifest artifacts and `resource_created` audit events. It cannot provision production.

## Isolation and authority

Every entity carries `projectId`; store queries for private objects include it. Every external write names a registered `resourceId`, and `PolicyEngine` verifies ownership, status, environment and permission. The registered local Git external reference must exactly equal the project's normalized workspace. There are no global mutable current-project variables.

## Lifecycle and readiness

Transitions are persisted with actor, reason, timestamp and artifact references. Dependency edges of type `DEPENDS_ON` must point to `READY` tasks. A plan is created before execution and reviewed by project-independent rules. Execution stores base commit, branch, commit, diff and version metadata. Required test classes are derived from the plan. Independent review evaluates coverage, architecture, security, ownership, API, migration, tests, error handling, races, idempotency, observability and rollback.

`READY` requires implementation, ArchitectureGuard, all required suites, IndependentReview, and mandatory artifacts. Failed tests return to implementation until `maxAutoRepairAttempts`; then the task is `BLOCKED`.

## Project context

Context is versioned sections, not a prompt. Every section records source type/reference, import time, hash, and `trustedAsInstructions: false`. Repository/task text is always data and cannot alter policy.

## Persistence and recovery

Projects, resources, context versions, tasks, transitions, runs, artifacts and audit events are stored in PostgreSQL JSONB envelopes with relational ownership/index columns. Runs contain platform/workflow/policy/context versions and Git metadata. Temporary workspaces are recoverable from registered metadata and Git.

Before an external PostgreSQL control plane is available, the Dockerless bootstrap registry persists the same `StateStore` contract in `.autopilot/state.json`; it contains no secret values. `DotEnvSecretProvider` separately stores replaceable runtime secrets in the ignored `.env`. With `DATABASE_URL`, runtime automatically composes the PostgreSQL store.

The remote v0.5 deployment uses Supabase Postgres and has no persistent filesystem workspace. Repeat-safe checksummed migrations also populate `migration_markers`. `admin_operations` provides operation-ID replay protection; `system_settings` and `console_screens` are server-driven semantic configuration. Every GitHub Actions run creates an ephemeral target checkout from the registered repository identity and restores the persisted task branch/exact SHA for repair.

## Provider bootstrap

GitHub provisioning uses the authenticated official CLI and verifies its identity against a confirmed `GITHUB_ACCOUNT` resource. Supabase provisioning uses the official CLI, generates the database password internally, redacts its command position, and stores only secret references in state. PostgreSQL migrations use checksums, an advisory lock, a migration ledger, a transaction, rollback metadata and a destructive-SQL denylist. Supabase Auth/Storage use the scoped Management API adapter.

## Provider extension

Add an adapter implementing the appropriate port; never import provider types into Core. Provider-specific credentials remain secret references, resolved at runtime. The unchanged Core can support another Git host, relational database, task tracker or LLM provider.

Architecture decisions are in `docs/adr/`.

## Remote runtime v0.5

```text
Browser (GitHub Pages static export)
        | Supabase Auth JWT; exact-origin CORS
        v
Cloudflare DNS/proxy (optional; stable public hostname)
        |
Kamal proxy -> stateless portable runtime (/control-api, /mcp, OAuth metadata)
        v
Supabase Edge Control API / HTTP MCP
        | service-role PostgREST and Storage
        v
AutopilotService -> PolicyEngine -> durable ExecutionJob
                                      |
                              GitHub workflow_dispatch
                                      |
                     ephemeral checkout / tests / review
                                      |
                         Postgres + private Storage
```

The container is a provider-neutral public origin, not a second control plane. It forwards the existing authenticated protocols and owns only stable public discovery URLs. Its only state is readiness cache data; it can be destroyed or moved without data migration. Direct Supabase Edge URLs remain available as emergency endpoints. Cloudflare Tunnel is not required, and Render is not part of the request path or deployment architecture. See `docs/adr/014-portable-public-runtime.md` and `BOOTSTRAP_NEW_SERVER.md`.

The browser never receives a service-role key, GitHub credential, target secret or direct table policy. Edge validates the Supabase JWT and operator/project membership before using its service role. Polling every five seconds reads durable state; large artifact bodies are hydrated from the private bucket by the server-side adapter.

The HTTP MCP has two distinct credentials. The ordinary token creates a `PROJECT_OPERATOR` principal restricted to an explicit project ID list. The dedicated superadmin token creates a `SUPERADMIN` principal and is never accepted by the browser. Operator Console users have persisted `OPERATOR`/`SUPERADMIN` roles; only the latter may skip membership checks. Dashboard aggregation is membership-filtered for ordinary operators.

Remote source and deployment are GitHub-driven. Pages and Edge are short-lived/serverless. Execution runs only in fixed GitHub Actions workflows, and workflow inputs contain a job UUID rather than repository paths, URLs or credentials. Database claim/lease and operation-id uniqueness prevent duplicate concurrent work; scheduled reconciliation handles lost callbacks without an always-on worker.

The optional always-on public gateway is deployed by Kamal to a standard Linux Docker host. Kamal health-gates and drains each replacement container through `/up`; the container also exposes `/health/live` and `/health/ready`. Restarting it cannot enqueue or repeat work because dispatch/idempotency/checkpoint/heartbeat/terminal state remains in PostgreSQL and GitHub Actions.

The API Explorer derives endpoints from `API_CONTRACT` OpenAPI artifacts. Validation and API requests create immutable artifacts and audit events. Saved scenarios support sequential steps, extraction of response values, non-secret `{{variable}}` interpolation, and server-memory-only bearer handoff. Production and unregistered targets fail before network access. `HttpScenarioRunner` is the single executable implementation behind both the Console scenario route and the published `superadmin_scenario_run` MCP tool; it resolves its target only from the scenario's own registered `HTTP_API` resource and is bounded by timeout, redirect, response-size and step limits.

## Future full product assembly

```text
Product tasks / task source + DesignSourceAdapter + frontend repository
                              |
                    contract synchronization
                              |
              backend + frontend implementation
                              |
                  integrated test environment
                              |
                    full product validation
```

`DesignSourceAdapter` and `FrontendTaskSourceAdapter` are provider-neutral ports with local and unconfigured implementations. Figma, frontend execution, and integrated product validation are deliberately not implemented in v0.3.
