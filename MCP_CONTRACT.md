# MCP contract v0.2

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
| `sandbox_github_identity_register` | write | Detect active GitHub identity after dedicated-sandbox confirmation |
| `sandbox_supabase_identity_register` | write | Discover one sandbox organization after official login/confirmation |
| `sandbox_bootstrap` | write/idempotent/open-world | Create GitHub/Supabase sandbox, migrate, verify CI, and write manifests |
| `sandbox_repository_delete` | destructive | Delete only a registered sandbox repository with matching confirmation |
| `sandbox_database_delete` | destructive | Delete only a registered sandbox database project with matching confirmation |

There is intentionally no `run_any_command`. Read-only annotations are set on reads; mutations use non-destructive semantic annotations. `task_execute` is idempotent by `(projectId, operationId)`.
