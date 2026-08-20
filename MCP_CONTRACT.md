# MCP contract v0.4

Local stdio remains compatible with the v0.3 semantic surface. Production uses authenticated stateless Streamable HTTP at `https://qtyfdzjzmgxtrarpgcmn.supabase.co/functions/v1/mcp`. It never exposes a shell or starts subprocesses; execution tools return durable job/run identities.

The remote surface implements: `system_health`, `project_list`, `project_get`, `resource_list`, `resource_register`, `context_get`, `context_import`, `task_create`, `task_get`, `task_list`, `task_analyze`, `task_plan`, `task_execute`, `task_review`, `task_retry`, `task_status`, `artifact_list`, `artifact_read`, `run_list`, `run_get`, `job_list`, `job_get`, `project_snapshot`, and `runtime_status`. Read-only and mutating tools have MCP annotations; `task_execute` is explicitly idempotent and accepts only an allowlisted resource UUID plus a structured change set.

All inputs are Zod-validated. Results are JSON encoded in MCP text content. Domain failures return `isError: true` with `{error:{code,message,details}}`. Mutating calls are audited and use the shared application service.

| Tool | Kind | Contract/result |
|---|---|---|
| `system_health` | read | Version, store, time, production support |
| `project_create` | write | Name, slug, source type, environment, autonomy mode, workspace → Project |
| `project_get`, `project_list` | read | Project lookup/list |
| `resource_register` | write | Explicit project/provider/reference/environment/permissions/secret refs → Resource |
| `resource_list` | read | Project-owned resources |
| `context_import` | write | Versioned typed sections with provenance |
| `context_get` | read | Latest ProjectContext |
| `task_create` | write | Project, external key, title, description, requirements, relationships → Task |
| `task_get`, `task_list` | read | Project-scoped task lookup/list |
| `task_analyze` | write | Dependency gate and requirements artifact |
| `task_plan` | write | Structured ImplementationPlan and ArchitectureGuard result |
| `task_execute` | write/idempotent | Project/task/resource/operation ID plus validated file changes → Git run |
| `task_test` | write | Execute plan-required fixed test classes → TestReport |
| `task_review` | write | IndependentReview and formal READY gate |
| `task_retry` | write | Policy-limited retry from BLOCKED/FAILED |
| `task_status` | read | Task, transitions, runs, artifacts |
| `artifact_list`, `artifact_read` | read | Project-scoped artifact evidence |
| `run_list`, `run_get` | read | Reproducible execution records |
| `git_diff` | read | Diff against recorded base for registered Git resource |
| `project_snapshot` | read | Machine-readable state/audit/version snapshot |
| `runtime_capabilities` | read | Evidence-based current environment capability snapshot |
| `sandbox_github_identity_register` | write | Require an exact expected active GitHub login after dedicated-sandbox confirmation |
| `sandbox_github_repository_register` | write/open-world | Verify private/admin ownership and explicitly allowlist one existing `owner/name` repository |
| `sandbox_supabase_identity_register` | write | Discover one sandbox organization after official login/confirmation |
| `sandbox_supabase_project_register` | write/open-world | Verify and allowlist the exact sole project ref in the dedicated sandbox account |
| `sandbox_supabase_database_configure` | write/open-world | Generate/rotate a registered sandbox database credential and retain references only |
| `sandbox_github_ci_verify` | write/idempotent/open-world | Bind a successful GitHub Actions run to the exact task commit SHA and write `CI_REPORT` |
| `sandbox_github_pull_request_open` | write/idempotent/open-world | For a `READY` task, open/reuse one PR from its exact latest `autopilot/*` branch |
| `sandbox_bootstrap` | write/idempotent/open-world | Create or use a registered GitHub sandbox, create Supabase sandbox, migrate, verify CI, and write manifests |
| `sandbox_repository_delete` | destructive | Delete only a registered sandbox repository with matching confirmation |
| `sandbox_database_delete` | destructive | Delete only a registered sandbox database project with matching confirmation |

There is intentionally no `run_any_command`. Read-only annotations are set on reads; mutations use non-destructive semantic annotations. `task_execute` is idempotent by `(projectId, operationId)`.
