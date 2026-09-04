# MCP contract v0.5

The deployed endpoint is authenticated stateless Streamable HTTP:

```text
POST https://shzdgtatfonznkprnxrz.supabase.co/functions/v1/mcp
Authorization: Bearer <token>
Accept: application/json, text/event-stream
```

`AUTOPILOT_MCP_TOKEN` creates a `PROJECT_OPERATOR` restricted to configured project IDs. The independent `AUTOPILOT_SUPERADMIN_MCP_TOKEN` creates a global `SUPERADMIN`. Neither credential can bypass PolicyEngine, explicit Resource Registry ownership, production denial, secret redaction, workflow gates or command policy.

## OAuth 2.1 (ChatGPT-compatible) authentication

A bearer token that does not match either static token is tried as a Supabase Auth access token (a normal session, or one issued by Supabase's OAuth 2.1 Authorization Server — both validate identically). The token is verified through the same operator/role check `control-api` already uses (`authenticatedOperator`): identity, active status, and allowlist are all re-checked, and only a resolved `SUPERADMIN` operator is granted an MCP principal — a successful OAuth sign-in that resolves to a non-superadmin operator is rejected with 401, never silently downgraded. OAuth scopes requested by the client are informational only; they are not a security boundary, and are never the sole gate for superadmin access.

Discovery/token endpoints (Supabase Auth, unchanged by this project). The GoTrue settings these
depend on -- OAuth server enabled, dynamic registration allowed, and the consent path that resolves
onto the Pages console -- are not deployable from `supabase/config.toml`; they are asserted after
every deploy by `scripts/configure-oauth-server.ts`:

```text
Protected resource metadata:   https://shzdgtatfonznkprnxrz.supabase.co/functions/v1/mcp/.well-known/oauth-protected-resource
Authorization Server metadata: https://shzdgtatfonznkprnxrz.supabase.co/auth/v1/.well-known/oauth-authorization-server
Authorization endpoint:        https://shzdgtatfonznkprnxrz.supabase.co/auth/v1/oauth/authorize
Token endpoint:                https://shzdgtatfonznkprnxrz.supabase.co/auth/v1/oauth/token
Dynamic client registration:   https://shzdgtatfonznkprnxrz.supabase.co/auth/v1/oauth/clients/register
```

PKCE (S256) is mandatory. A 401 from the MCP endpoint carries `WWW-Authenticate: Bearer resource_metadata="<protected resource metadata URL>"` per RFC 9728, and the MCP endpoint itself serves that metadata (unauthenticated `GET`) at the sub-path above — required because ChatGPT's connector performs automatic discovery against the MCP server's own 401 challenge rather than accepting manually-entered authorization/token URLs. Dynamic client registration (RFC 7591) is enabled, since ChatGPT self-registers via DCR rather than using a pre-registered client (Supabase does not support the newer Client ID Metadata Documents mechanism ChatGPT prefers). Self-registration alone grants no access — every resulting token still requires a signed-in SUPERADMIN operator to approve on the consent screen, and the MCP server independently re-verifies the SUPERADMIN role before any tool call succeeds. The authorization consent screen is served by the Operator Console (`apps/operator-console/app/oauth-consent`), gated by the existing magic-link operator sign-in — it never has access to the static superadmin token.

Every audit event now carries an `authMethod` of `STATIC_TOKEN` or `OAUTH`; OAuth-authenticated events record the real operator email as `actor` instead of a generic token identity.

Every input is Zod-validated. Read and mutation annotations are declared on each MCP tool. Domain failures return `isError: true` and a typed `{error:{code,message,details}}`. Every superadmin mutation requires an `operationId`, is replay-safe through `admin_operations`, and records a redacted `mcp.<tool>` audit event with actor, project, object input/result and timestamp.

## Read-compatible tools

`system_health`, `runtime_status`, `project_list`, `project_get`, `resource_list`, `context_get`, `task_list`, `task_get`, `task_status`, `artifact_list`, `artifact_read`, `run_list`, `run_get`, `job_list`, `job_get`, and `project_snapshot`.

## Superadmin tools

| Domain | Tools |
|---|---|
| Whole system | `superadmin_system_overview` |
| Projects | `superadmin_project_list`, `superadmin_project_get`, `superadmin_project_create`, `superadmin_project_update`, `superadmin_project_delete` |
| Resources | `superadmin_resource_list`, `superadmin_resource_get`, `superadmin_resource_create`, `superadmin_resource_update`, `superadmin_resource_binding_update`, `superadmin_resource_delete` |
| Context | `superadmin_context_list`, `superadmin_context_get`, `superadmin_context_create`, `superadmin_context_update`, `superadmin_context_delete` |
| Tasks/lifecycle | `superadmin_task_list`, `superadmin_task_get`, `superadmin_task_create`, `superadmin_task_update`, `superadmin_task_transition`, `superadmin_task_analyze`, `superadmin_task_plan`, `superadmin_task_execute`, `superadmin_task_retry`, `superadmin_task_review`, `superadmin_task_rebase_onto_current_base`, `superadmin_task_delete` |
| Jobs | `superadmin_job_list`, `superadmin_job_get`, `superadmin_job_create`, `superadmin_job_cancel` |
| Runs | `superadmin_run_list`, `superadmin_run_get`, `superadmin_run_delete` |
| Artifacts | `superadmin_artifact_list`, `superadmin_artifact_get`, `superadmin_artifact_create`, `superadmin_artifact_update`, `superadmin_artifact_delete` |
| Scenarios | `superadmin_scenario_list`, `superadmin_scenario_get`, `superadmin_scenario_create`, `superadmin_scenario_update`, `superadmin_scenario_delete`, `superadmin_scenario_run` |
| Validations | `superadmin_validation_list`, `superadmin_validation_get`, `superadmin_validation_run`, `superadmin_validation_delete` |
| Settings | `superadmin_setting_list`, `superadmin_setting_get`, `superadmin_setting_upsert`, `superadmin_setting_delete` |
| Console screens | `superadmin_screen_list`, `superadmin_screen_get`, `superadmin_screen_upsert`, `superadmin_screen_delete` |
| Operators | `superadmin_operator_list`, `superadmin_operator_get`, `superadmin_operator_upsert`, `superadmin_operator_delete` |
| Memberships | `superadmin_membership_list`, `superadmin_membership_get`, `superadmin_membership_upsert`, `superadmin_membership_delete` |
| Audit | `superadmin_audit_list`, `superadmin_audit_get` |

There are 88 registered remote tools. `superadmin_system_overview` returns projects, task/job counts and states, failed gates, latest errors, evidence-based capabilities, migration markers, Edge Functions, recent Actions runs and deployment status in one response.

## Mutation rules

- Project deletion archives/tombstones the record and rejects active jobs.
- Tasks may only be edited before planning. Direct transition to `READY` is rejected; only formal review gates can produce it.
- Run/artifact/context deletion is a tombstone so audit and reproducibility history remain available.
- Formal lifecycle artifacts are immutable. Admin-authored CRUD is restricted to `ADMIN_NOTE` and `CONSOLE_SNAPSHOT`.
- Console blocks are typed `TEXT`, `METRIC` or `JSON`; raw HTML, scripts and file/component paths are not accepted.
- Safety settings such as production-write denial cannot be changed or deleted.
- The last active superadmin cannot be deleted.
- Git/GitHub resources cannot be created or rebound through generic resource tools. The existing dedicated identity/repository verification flow is required and only registered resource UUIDs are accepted by execution.
- Delete, membership and resource binding tools require structured identity, confirmation enum and reason fields. No free-form command is interpreted.

## Rebase onto the current base

`superadmin_task_rebase_onto_current_base({operationId, projectId, taskId, resourceId, resolutions?})`
transfers an already-verified READY task onto the registered repository's current default branch,
for the case where the task's dependency has since been merged and its pull request now conflicts.
The task is never recreated and its scope is never touched: it keeps its identity, plan,
requirements and history and is re-verified on the newer base.

Branch, verified commit, original fork point and manifest are all resolved server-side from
durable run/artifact evidence -- the caller supplies none of them. The transfer is a real 3-way
`git cherry-pick` of the task's own commit range in a disposable clean workspace, so the state the
task merely inherited is not carried over and work the base gained since the fork is preserved.
Two invariants fail the job closed: the original base must be an ancestor of the target base (the
dependency really is merged), and every path the base changed since the fork that the task never
touched must be byte-identical afterwards (nothing merged is reverted).

A first call with no `resolutions` stops at any genuine semantic conflict and persists a
`REBASE_REPORT` artifact carrying three-sided diff3 evidence -- current base, original base and
task intent -- leaving the task `BLOCKED`. `ours`/`theirs` is never chosen automatically. A second
call carries `resolutions` for exactly those paths (any other path, or content still holding
conflict markers, is rejected), after which the full build/test/contract/migration/security/
regression pipeline re-runs, a new `FINAL_CHANGE_MANIFEST` and commit SHA are produced, a fresh
pull request is opened against the current base and every still-open pull request from the stale
branch is commented and closed as superseded -- never merged.

## Executable HTTP scenario runner

`superadmin_scenario_run({operationId, projectId, scenarioId})` executes a saved validation
scenario as real HTTP requests against its own registered `HTTP_API` resource, and is the
backend-testing subset of what Postman does. It is distinct from `superadmin_validation_run`,
which is unchanged and still performs semantic control-state validation.

The caller supplies nothing but the persisted scenario ID: the resource, base URL, steps,
headers, body, assertions, extractions and bearer handoff all come from the stored definition,
so the tool can never become an arbitrary-URL fetch. Targets must be HTTPS (or loopback HTTP for
a `LOCAL`/`SANDBOX` resource); private, link-local and cloud metadata addresses, origin escape,
base-path escape and cross-origin redirects are all rejected. Timeout, redirect count, response
size and step count are bounded, and secret material never reaches the tool result, evidence,
audit or logs. Each run persists a redacted `VALIDATION_REPORT` artifact readable through
`superadmin_validation_get`, and appends one `mcp.scenario_run` audit event.

Full contract, safety boundary and worked example: [`docs/http-validation-runner.md`](docs/http-validation-runner.md).

## Deliberately absent

There is no shell/subprocess proxy, SQL console, arbitrary filesystem/path tool, arbitrary HTTP fetch (the scenario runner only replays a persisted scenario against its own registered resource), arbitrary GitHub repository URL, policy bypass, production mutation or source-code editing tool. Long execution is a durable job carrying only semantic inputs and a registered resource UUID.

## Client configuration

Use an HTTP/Streamable HTTP MCP client with the endpoint and `Authorization` header above. The superadmin token must be supplied from a local secret manager or ignored `.env`, never committed or placed in Console/browser configuration.
