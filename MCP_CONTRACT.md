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

`system_health`, `runtime_status`, `project_list`, `project_get`, `resource_list`, `context_get`, `task_list`, `task_get`, `task_status`, `task_validate`, `artifact_list`, `artifact_read`, `run_list`, `run_get`, `job_list`, `job_get`, `project_components`, and `project_snapshot`.

### Every list is a page, and says so

Each list tool takes `limit` (default 50, max 200) and `offset`, and answers with `items`, `total`,
`complete`, and `nextOffset` when more remains. Both are optional, so a caller that passes neither
still gets a bounded first page plus the total.

This is not a convenience. These tools previously returned a project's entire history in one
response — measured on this control plane's own project, `artifact_list` was 19.1 MB over 26.6 s and
`project_snapshot` returned HTTP 200 with an **empty body** because the Edge isolate died
mid-serialisation. None of that is a failure a caller can react to: the transport reports success,
the payload is unusable, and an autonomous caller learns nothing and moves on to the next
diagnostic tool. `total` and `complete` are what let it know it has finished looking, which a bare
truncated array never told it.

**Listing never carries the heavy bodies.** `artifact_list` returns metadata (id, kind, task,
timestamps) and `job_list` returns statuses; artifact content and job `payload`/`result`/`error`
come from `artifact_read` and `job_get`, one entity at a time. `artifact_list` and `job_list` also
take `kind` and `status` filters, which is almost always cheaper than paging to find one row.

`project_snapshot` is a bounded summary — identity, resources, counts, task states, artifact kinds,
active jobs, recent audit. It is not an export; `superadmin_repository_export_plan` is.

### Unreadable artifact content is reported as permanent

An artifact whose blob was written to a storage provider this runtime has no reader for fails with
`CREDENTIAL_MISSING` carrying `retryable: false` and `permanent: true`. Retrying cannot succeed, and
the metadata is still readable — only the content is out of reach. On this control plane 108 of 119
externalized artifacts, including 95 `COMMAND_STDOUT` execution logs, were written to the retired
pre-cutover Supabase project, so every read of one fails identically forever.

### Task wording is checked before the work starts

`task_validate` judges a draft without creating anything, and `superadmin_task_create` runs the same
check and **refuses** a task that cannot be planned. Each finding carries `field`, `problem` and a
concrete `fix`. Blocking: an absent or too-thin description, no requirements, a requirement stating
a quality with no failing value (`fast` cannot be refuted; `p95 under 200 ms at 50 rps` can), an
unresolved `TBD`, a description that both requests and denies an HTTP surface, and a missing
CORE/MODULE binding. Advisory: an off-convention `externalKey`, a title naming no deliverable, and
two deliverables joined into one task.

### Every task is bound to the core or to one module

`component` is `{"kind":"CORE"}` or `{"kind":"MODULE","name":"<slug>"}`. A MODULE must be named and
CORE must not be, so a second core cannot appear by accident; the name is a lowercase slug so it
serves unchanged as a directory, a branch segment and a bundle name. `project_components` reads a
project back one component at a time. Tasks authored before the binding existed report as
`UNASSIGNED` rather than being folded into CORE — an unbound task is a real gap in the export story,
not a core task.

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
| Repository evidence | `superadmin_sandbox_repository_read`, `superadmin_sandbox_repository_ci_runs`, `superadmin_sandbox_repository_ci_log` |
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
- The MCP server advertises a tool-surface version in `serverInfo.version`, independent of `PlatformVersions.platform`. Clients cache the tool manifest against server identity and refetch only when it changes, so this is bumped whenever a tool is added, removed or renamed. A deploy that changes the tool set without bumping it leaves connectors serving their previous catalogue, and re-authenticating does not clear that.
- CI evidence is readable, not just repository content. `superadmin_sandbox_repository_ci_runs` and `superadmin_sandbox_repository_ci_log` answer "what did the workflow actually do" for a registered repository, so a red check on a private repository is diagnosed from its own job log instead of guessed at. Both are read-only, resolve the same registered non-PRODUCTION READ-permitted resource, and address GitHub only as that resource, so a run id from another repository 404s rather than reading somewhere else. The returned log tail is redacted for credential shapes on top of the masking Actions already applies.
- Git/GitHub resources cannot be created or rebound through generic resource tools. The existing dedicated identity/repository verification flow is required and only registered resource UUIDs are accepted by execution. That flow adopts an organization-owned repository only when GitHub itself reports the active sandbox identity as ADMIN on that exact repository; owning the namespace is not required and would be impossible, since an organization login can never equal a user login. A namespace on its own confers nothing — ADMIN on the one registered repository is what every write passes through.
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

## Whole API collection

A handful of green scenarios is not evidence that an API works: seven requests against health,
version, auth and a 404 read exactly like a whole Postman run unless something counts what they
leave out. Three tools make the size of the claim explicit for any project:

* `superadmin_collection_import({operationId, projectId, resourceId, collection, stripPathPrefix?, taskId?})`
  imports a project's whole Postman v2.0/v2.1 collection as saved scenarios bound to its
  registered `HTTP_API` resource -- one scenario per top-level folder in collection order, split
  into parts of 20 steps. Every request or test-script line the runner cannot express is returned
  in `skipped`/`warnings`; nothing is dropped silently.
* `superadmin_api_coverage({projectId, resourceId?, openapi?})` is read-only: it compares the saved
  scenarios with the project's whole OpenAPI inventory and returns every uncovered operation with
  a runnable draft step.
* `superadmin_collection_run({operationId, projectId, resourceId, scenarioIds?, openapi?})` runs every
  saved scenario of the resource in order with variables shared across scenarios, and persists one
  `VALIDATION_REPORT` with `suite: "COLLECTION"`. Its `verdict` is `PROVEN` only when every scenario
  passed **and** every documented operation was exercised by a passing request; otherwise
  `NOT_PROVEN` with `reasons` and the uncovered operations. Without an inventory (no inline
  `openapi` and no `API_CONTRACT` artifact) it is never `PROVEN`.

* `superadmin_repository_api_discovery({projectId, resourceId, ref?})` is read-only: it finds every
  OpenAPI contract and Postman collection in a registered GitHub repository at one exact commit,
  follows path items split through `$ref`, and returns the merged inventory with the contract
  documenting each operation and every gap. `superadmin_collection_run` and
  `superadmin_api_coverage` take `contractRepository: {resourceId, ref?}` to use that inventory
  (coverage is then also reported per contract), and `superadmin_collection_import` takes
  `collectionSource: {resourceId, ref?, path}` to import a collection straight from the repository.
  Any inventory gap keeps the verdict `NOT_PROVEN`.

None of them accepts a URL or host; each scenario still runs through `superadmin_scenario_run`'s
single runner, with the same authorization, containment, redaction and limits. Details:
[`docs/http-validation-runner.md`](docs/http-validation-runner.md#whole-api-collection).

## Verified repository registration

`superadmin_repository_register({operationId, projectId, repository, access})` registers an existing
GitHub repository for a project, so every repository-based tool can use it. It is verified against
GitHub itself:
- the exact `owner/name` as GitHub reports it (a renamed repository is refused, and its current
  name is given);
- public or private (the result names the visibility);
- ADMIN for the control-plane identity;
- not registered to another project.

`access: READ` (the default) covers discovery, environment plans, HTTP E2E and parity. `FULL` also
covers task execution, pull requests and merges. `superadmin_resource_create` still refuses Git
bindings (ADR 023).

## Ephemeral verification environments

`superadmin_environment_plan({projectId, resourceId, ref?, root?})` is read-only. It decides how
the autopilot would build, start and reach a registered GitHub repository's backend in a
throwaway environment at one exact commit. That covers the stack, base image, argv
install/build/prepare/run commands, port, health probes and dependency containers (PostgreSQL,
MySQL, Redis, MongoDB, with credentials only as per-run templates). It honours
`.autopilot/environment.yml`. Anything it cannot decide is listed in `unresolved` with a
remediation, and such a plan is never executed.

`superadmin_http_e2e_run({operationId, projectId, taskId, repositoryResourceId, ref?, root?,
stripPathPrefix?, scenarioSource})` runs full HTTP verification of that repository at one exact
commit, which is pinned when the job is enqueued. It starts the three-job
`autopilot-http-e2e.yml` workflow:
- **prepare** (secrets, no project code) claims the job and checks out the commit;
- **environment** (no secrets) builds, starts and verifies the project in containers;
- **record** (secrets, no project code) validates the evidence and binds it to the commit.

`scenarioSource` is either the repository's own Postman collections (`REPOSITORY`) or scenarios
saved for an `HTTP_API` resource (`SAVED`). `superadmin_http_e2e_get({projectId, jobId})` returns
the job status and, once recorded, the verdict, classified failure, steps and coverage.
A task planned under verification profile v2 that changes a public HTTP surface, or asks for
end-to-end verification, cannot reach `READY` without `PROVEN` evidence for its exact latest
commit. It rests in `VERIFYING`, and the record step moves it to `READY` through the full gate.
`superadmin_task_complete_verification({operationId, projectId, taskId})` is the recovery path if
that step did not finish (ADR 020).
With `counterpart: {repositoryResourceId, ref?, root?, label?}`, a reference implementation runs
the same scenarios in its own fresh environment, and every response is compared step by step.
`PROVEN` then also requires the reference `PROVEN` and zero differences (`PARITY_MISMATCH`
otherwise, with each difference and its JSON path).
Missing, malformed, forged or oversized evidence is recorded as `NOT_PROVEN`, never as a pass. Details:
[`docs/ephemeral-environments.md`](docs/ephemeral-environments.md).

## Deliberately absent

There is no shell/subprocess proxy, SQL console, arbitrary filesystem/path tool, arbitrary HTTP fetch (the scenario runner only replays a persisted scenario against its own registered resource), arbitrary GitHub repository URL, policy bypass, production mutation or source-code editing tool. Long execution is a durable job carrying only semantic inputs and a registered resource UUID.

## Client configuration

Use an HTTP/Streamable HTTP MCP client with the endpoint and `Authorization` header above. The superadmin token must be supplied from a local secret manager or ignored `.env`, never committed or placed in Console/browser configuration.
