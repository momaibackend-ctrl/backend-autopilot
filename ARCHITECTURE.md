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

Transitions are persisted with actor, reason, timestamp and artifact references. Dependency edges of type `DEPENDS_ON` must point to `READY` tasks. A plan is created before execution and reviewed by project-independent rules. Execution stores base commit, branch, commit, diff and version metadata. Required test classes are derived from the plan. Independent review evaluates coverage, architecture, security, ownership, API, migration, tests, generative coverage, error handling, races, idempotency, observability and rollback.

Planning classifies scope by intent rather than by keyword: a clause that names an API or a migration only to forbid it counts as evidence against that change, so `apiChanges` and `databaseChanges` -- and therefore the artifacts the gate demands -- follow what the task actually asks for. The same pass produces a verification profile: every layer (`UNIT`, `INTEGRATION`, `PROPERTY`, `CONTRACT`, `MIGRATION`, `SECURITY`, `REGRESSION`, plus the `HTTP_CONTRACT` and `MIGRATION_MANIFEST` evidence layers) is recorded as `REQUIRED` or `NOT_APPLICABLE` with a stated reason, and the profile travels with the plan so `superadmin_task_readiness` can report it before any work runs. `PROPERTY` is required where an algorithmic invariant exists -- state machines, time/DST, numeric logic, deterministic hashing or bucketing, idempotency, parsers, ordering and bounds, complex transformations -- and refused, in writing, where none does.

An epic is verified separately from its members, at one named head commit. Per-task gates cannot see composition failures -- a later task can break an earlier task's contract without either task's gate noticing -- so `superadmin_epic_verify` aggregates the members into one matrix over `CONTRACTS`, `CONSUMERS`, `INVARIANTS`, `INTEGRATION_DEPENDENCIES`, `SECURITY_PRIVACY`, `MIGRATIONS` and `JOURNEYS`, deriving each dimension's requirement from what the members declared. Member evidence produced at an earlier commit is stale, not passing: it blocks. Every dimension resolves to `PASS`, `NOT_APPLICABLE` with a reason, or `BLOCKED` with a remediation, and `EPIC_VERIFICATION_REPORT` carries the exact SHA, the matrix and the evidence ids. Aggregate results are recorded as `EPIC_DIMENSION_EVIDENCE` artifacts bound to the commit they ran on, with a mandatory attributable `source`.

A required generative layer is never satisfied by a suite's exit code. `PROPERTY_BASED_REPORT` carries property and generated-case counts, shrinking state, replay seeds and counterexamples parsed from the runner's own output (jqwik on the JVM, fast-check on Node, or a project-emitted `reports/property-based-report.json`). A green build with no properties is `UNVERIFIED`, and `UNVERIFIED` does not reach `READY`.

`READY` requires implementation, ArchitectureGuard, all required suites, IndependentReview, and mandatory artifacts. Failed tests return to implementation until `maxAutoRepairAttempts`; then the task is `BLOCKED`.

## Canonical development repository

A project's **Canonical Development Repository** is a role a registered repository plays -- "this is
the one source of further development" -- not a name, a host, or a claim about production. The
binding references a registered `GITHUB_REPOSITORY` resource rather than carrying its own
owner/name, so there stays exactly one repository registry: the resource answers what Autopilot may
touch at all, the binding answers which of those the project develops in. Bindings are versioned and
append-only; a replaced one becomes `SUPERSEDED` and is never deleted.

"At most one `ACTIVE` binding per project" is a durable database invariant, not an application
convention: a partial unique index on `(project_id) WHERE status='ACTIVE'`, plus a `FOR UPDATE` row
lock inside one atomic promotion function that both promotion and metadata rollback go through. Two
concurrent promotions cannot both win regardless of how their callers interleave.

Promotion and export are deliberately separate operations. Promotion assigns the role and copies no
Git, creates no repository, renames nothing and moves no organization. Export mirrors history into
another registered repository and, on its own, changes nothing about which repository is canonical;
making an export target canonical is a second explicit decision. Both have a read-only dry run, and
both mutations pin the exact state that dry run saw -- a moved head or a changed binding version is
`STALE_PROMOTION_PLAN`, never a silent retarget. Metadata rollback restores a previous binding and
has no code path that reaches a repository.

Once a project has an `ACTIVE` binding, new work resolves its repository server-side: a task that
already executed keeps its pinned repository, and a caller-supplied `resourceId` may only confirm
the canonical one. A project with no binding behaves exactly as it did before bindings existed,
which is what keeps every historical project working. Canonical does not mean floating: the binding
says where the base comes from, and execution still resolves the default branch to an exact commit
and persists it on the job.

Git-level transfer runs in a fixed control-repository workflow -- the control plane has no
subprocess -- and verification reads the target back for identity, heads, default branch, every
required ref and tag, and reachability of the source head. A transfer that cannot be proved is
`BLOCKED`, never partial success. Secret and configuration **values** never travel: `SECRET_CONFIG_HANDOVER`
carries reference names, purposes, owners and per-item setup status, and there is no parameter
anywhere on the export path through which a value could enter. `DEVELOPER_HANDOVER_REPORT` checks
objective facts about the canonical repository at an exact commit, including that ordinary local
development requires no MCP client and no Superadmin token. Details are in
`docs/canonical-development-repository.md`.

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

The browser never receives a service-role key, GitHub credential, target secret or direct table policy. Edge validates the Supabase JWT and operator/project membership before using its service role. Polling every five seconds reads durable state; large artifact bodies are hydrated from the private bucket by the server-side adapter.

The HTTP MCP has two distinct credentials. The ordinary token creates a `PROJECT_OPERATOR` principal restricted to an explicit project ID list. The dedicated superadmin token creates a `SUPERADMIN` principal and is never accepted by the browser. Operator Console users have persisted `OPERATOR`/`SUPERADMIN` roles; only the latter may skip membership checks. Dashboard aggregation is membership-filtered for ordinary operators.

Remote source and deployment are GitHub-driven. Pages and Edge are short-lived/serverless. Execution runs only in fixed GitHub Actions workflows, and workflow inputs contain a job UUID rather than repository paths, URLs or credentials. Database claim/lease and operation-id uniqueness prevent duplicate concurrent work; scheduled reconciliation handles lost callbacks without an always-on worker. Reconciliation is time-based as well as callback-based: because `workflow_dispatch` answers with an empty body, the runner stamps its own run id when it claims a job, and any active job that goes unclaimed past the dispatch grace period, holds an expired lease, or exceeds the hard timeout is terminalized with a coded reason. No job stays `RUNNING` indefinitely.

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
