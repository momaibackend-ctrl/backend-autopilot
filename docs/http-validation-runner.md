# Executable HTTP validation runner

Backend Autopilot can store structured validation scenarios and now **execute** them as real
HTTP requests against a registered sandbox/staging API — the backend-testing subset of what
Postman does, driven entirely through the existing MCP tool layer.

The executor is published as the MCP tool **`superadmin_scenario_run`**.

## Architecture

```text
external client (ChatGPT / MCP)   Operator Console (browser)
              |                              |
   superadmin_scenario_run            POST /scenarios/run
              |                              |
      SuperadminService.scenarioRun    OperatorConsoleService.runScenario
              |                              |
              +--------------+---------------+
                             |
                    HttpScenarioRunner            packages/http-runner
                             |
        PolicyEngine (NETWORK / READ / non-production)
                             |
        resolveHttpApiTarget(registered HTTP_API resource)
                             |
             bounded fetch  ->  target sandbox API
                             |
        redacted VALIDATION_REPORT artifact + mcp.scenario_run audit event
```

`packages/http-runner` is the single implementation. It uses only Web APIs (no Node builtins),
so the identical module runs in the Supabase Deno Edge MCP, in the Fastify Console API and in
tests. Execution results reuse the existing artifact model — there is no parallel entity.

`superadmin_validation_run` is unchanged and still performs **semantic control-state
validation** (task gates, artifacts, jobs). The two are deliberately separate concepts.

## Safety boundary

The runner is an SSRF primitive, so it is fail-closed. Everything below is enforced *before*
a socket is opened:

| Control | Rule |
|---|---|
| Target origin | Only the `externalReference` of the scenario's own registered `HTTP_API` resource. The tool accepts no URL, host or `resourceId`. |
| Ownership | The resource must belong to the same `projectId` as the scenario. |
| Resource state | Must be `ACTIVE`; `PRODUCTION` resources are rejected. |
| Project state | `PRODUCTION` environment and `AUTONOMOUS_PRODUCTION` autonomy are rejected; `PolicyEngine` additionally requires `AUTONOMOUS_STAGING` for the `NETWORK` action and `READ` on the resource. |
| Scheme | HTTPS everywhere. Plain HTTP only for loopback hosts, and only for a `LOCAL` or `SANDBOX` resource. |
| Address class | `PRIVATE`, `LINK_LOCAL`, `UNIQUE_LOCAL`, CGNAT, multicast/reserved and cloud metadata hosts (`169.254.169.254`, `metadata.google.internal`, `*.internal`, `*.local`) are rejected — including IPv4-mapped IPv6 forms. |
| Path containment | Step paths must start with `/`, may not be protocol-relative, may not contain control characters, and after normalisation must stay on the registered origin and inside the registered base path prefix (so `/../admin` is rejected). |
| Redirects | Bounded (max 3) and same-origin only; a cross-origin or scheme-changing `Location` fails the step and is never followed. The API Explorer's single-request path still follows none at all. |
| Headers | Caller-supplied `authorization`, `cookie`, `proxy-authorization` and `x-api-key` are refused, as is any header name/value that could inject a header line. |
| Inline secrets | Request bodies containing secret-looking field names are refused; `secretRefs` is the only supported credential channel. |
| Limits | 15 s per-request timeout, 3 redirects, 256 KB read from a response body, 8 KB persisted as evidence, 120 s whole-scenario budget, 1..20 steps (unchanged). |

### DNS rebinding

The runner does not pin a resolved IP — the Deno Edge runtime provides no hook for it. The
practical mitigations are: IP-literal private addresses are rejected outright; every non-loopback
target must be HTTPS, so a rebind to an internal address cannot present a valid certificate for
the registered hostname; and redirects are never followed off-origin. A hardened outbound proxy
remains the complete answer for multi-tenant deployment.

## HTTP_API resource requirement

`externalReference` is used as the base URL and is now strictly validated (absolute `http(s)`
URL, no credentials, no query string, no fragment). This is the existing contract — no schema
change was needed.

```jsonc
{
  "type": "HTTP_API",
  "provider": "http",
  "externalReference": "https://sandbox-api.example.test",   // or http://127.0.0.1:4010 for SANDBOX
  "environment": "SANDBOX",
  "permissions": ["READ"],
  "secretRefs": ["SANDBOX_API_TOKEN"]                         // optional; resolved server-side
}
```

If `secretRefs[0]` is present it is resolved through the existing secret provider and sent as
`Authorization: Bearer …` on every step that does not have its own `bearerFrom`. The value never
appears in evidence, audit, errors or the tool result.

## Scenario creation

Unchanged: `superadmin_scenario_create` (or the Console's `POST /scenarios`). Each step has
`name`, `method` (`GET|POST|PUT|PATCH|DELETE|HEAD`), `path`, `headers`, `query`, `body`,
`expectedStatus`, `extract`, `bearerFrom`, and the new optional `assertions`.

## Assertions

`expectedStatus` is the primary assertion and is always evaluated first. `assertions[]` is
additive and optional:

| `type` | Fields | Meaning |
|---|---|---|
| `HEADER_EXISTS` | `header` | Response header is present |
| `HEADER_EQUALS` | `header`, `value` | Response header equals the value |
| `BODY_FIELD_EXISTS` | `path` | `response.body.a.b` resolves |
| `BODY_FIELD_EQUALS` | `path`, `value` | `response.body.a.b` deep-equals the value |
| `MAX_DURATION_MS` | `maxDurationMs` | Response time upper bound |

A step passes only when the status matches **and** every assertion passes.

## Extraction and chaining

`extract` maps a variable name to `{ path: "response.body.…", sensitive: boolean }`.

Interpolation uses the project's existing `{{variable}}` convention and works in `path`,
`query`, `headers` and `body`:

* a **non-sensitive** variable can be interpolated anywhere;
* a **sensitive** variable can only be used through `bearerFrom` — interpolating it anywhere
  else fails the step with `POLICY_VIOLATION`;
* a variable is treated as sensitive when `sensitive: true`, or when its name or source path
  looks secret-like (`token`, `secret`, `password`, `authorization`, `api_key`).

`bearerFrom: "<variable>"` sends `Authorization: Bearer <value>` for that step.

## Redaction

* Sensitive extracted values are stored as `"[REDACTED]"`.
* The `Authorization` header is stripped from request evidence; `set-cookie` and
  `www-authenticate` are stripped from response evidence.
* All persisted content passes through the shared `redact()` (secret-looking keys, bearer
  tokens, provider token patterns, credential-bearing connection strings).
* Response bodies are capped at 256 KB read / 8 KB persisted; anything larger is stored as
  `{ truncated: true, bytes, preview }`.
* Transport errors are sanitised to `{ code, message }` — no stack traces, no URLs with
  credentials.
* Scenario definitions persist `extract` as a list of `{variable, path, sensitive}` objects so
  that a variable named e.g. `access_token` is not destroyed by key-based artifact redaction.

## Execution evidence and persistence

Each run writes one `VALIDATION_REPORT` artifact (`suite: "SCENARIO"`), readable through the
existing `superadmin_validation_list` / `superadmin_validation_get` tools and the Console's
Validation Center. Per step it records index, name, method, redacted path/target, expected and
actual status, pass/fail/error/skipped, duration, assertion outcomes, redacted request/response
evidence, redacted extractions and a sanitised error.

Execution is fail-fast: the first non-passing step halts the scenario and every later step is
recorded as `SKIPPED`. The overall status is `PASSED`, `FAILED` (an assertion or expected status
did not match) or `ERROR` (transport failure or policy rejection during execution).

Every run also appends an immutable `mcp.scenario_run` audit event with actor, project,
redacted input and redacted result, and is replay-protected by `operationId` through
`admin_operations` — repeating an `operationId` returns the stored result without re-sending any
request.

## v1 limitations

* JSON and text bodies only — no multipart, file upload, form encoding or streaming.
* No cookie jar, no OAuth flow helper, no environment/collection variables beyond `{{…}}`
  chaining within a single run.
* Extraction paths are `response.body.<segment>…` only (numeric segments index arrays); no
  JSONPath filters, wildcards or header extraction.
* One target per scenario — a scenario cannot span two registered resources.
* No parallel steps, retries or loops; 20 steps maximum.
* No scheduling; a run is always explicitly invoked.
* Validation suites (`SMOKE`, `CRUD`, …) do not yet orchestrate HTTP scenarios.

## Complete flow

```jsonc
// 1. register the sandbox target (existing tool)
superadmin_resource_create({
  "operationId": "flow-resource-0001",
  "projectId": "ac6d68be-272c-4bca-aab1-cd1a442cf960",
  "type": "HTTP_API",
  "provider": "http",
  "externalReference": "https://sandbox-api.example.test",
  "environment": "SANDBOX",
  "permissions": ["READ"],
  "secretRefs": []
})

// 2. save the scenario (existing tool)
superadmin_scenario_create({
  "operationId": "flow-scenario-0001",
  "projectId": "ac6d68be-272c-4bca-aab1-cd1a442cf960",
  "resourceId": "b37e4857-8d4f-47c4-8e21-ea50473dca54",
  "name": "Login, read self, create and read a note",
  "description": "Postman-style chained sandbox flow",
  "steps": [
    {
      "name": "Login",
      "method": "POST",
      "path": "/auth/login",
      "body": { "user": "sandbox" },
      "expectedStatus": 200,
      "extract": {
        "user_id": { "path": "response.body.user_id", "sensitive": false },
        "access_token": { "path": "response.body.access_token", "sensitive": true }
      }
    },
    {
      "name": "Read own profile",
      "method": "GET",
      "path": "/me",
      "expectedStatus": 200,
      "bearerFrom": "access_token",
      "assertions": [
        { "type": "HEADER_EXISTS", "header": "content-type" },
        { "type": "BODY_FIELD_EXISTS", "path": "response.body.id" }
      ]
    },
    {
      "name": "Create note",
      "method": "POST",
      "path": "/notes",
      "body": { "title": "from autopilot", "owner": "{{user_id}}" },
      "expectedStatus": 201,
      "bearerFrom": "access_token",
      "extract": { "note_id": { "path": "response.body.id", "sensitive": false } }
    },
    {
      "name": "Read created note",
      "method": "GET",
      "path": "/notes/{{note_id}}",
      "expectedStatus": 200,
      "bearerFrom": "access_token",
      "assertions": [{ "type": "MAX_DURATION_MS", "maxDurationMs": 2000 }]
    }
  ]
})

// 3. execute it (new tool)
superadmin_scenario_run({
  "operationId": "flow-run-0001",
  "projectId": "ac6d68be-272c-4bca-aab1-cd1a442cf960",
  "scenarioId": "9d1c4a10-6c4a-4a7f-9a54-6a2f1f0d1c77"
})
```

Result (superadmin envelope, `{ value, idempotentReplay }`):

```jsonc
{
  "value": {
    "executionId": "6f0a1b23-9c44-4d5e-8f31-b2c7a0e4d519",
    "scenarioId": "9d1c4a10-6c4a-4a7f-9a54-6a2f1f0d1c77",
    "scenarioName": "Login, read self, create and read a note",
    "projectId": "ac6d68be-272c-4bca-aab1-cd1a442cf960",
    "resourceId": "b37e4857-8d4f-47c4-8e21-ea50473dca54",
    "environment": "SANDBOX",
    "status": "PASSED",
    "startedAt": "2026-08-23T09:14:02.113Z",
    "completedAt": "2026-08-23T09:14:02.702Z",
    "durationMs": 589,
    "summary": { "totalSteps": 4, "passedSteps": 4, "failedSteps": 0, "skippedSteps": 0 },
    "steps": [
      {
        "index": 0,
        "name": "Login",
        "method": "POST",
        "path": "/auth/login",
        "status": "PASSED",
        "httpStatus": 200,
        "expectedStatus": 200,
        "durationMs": 173,
        "assertions": [],
        "extracted": { "user_id": "user-42", "access_token": "[REDACTED]" }
      }
    ],
    "resultArtifactId": "6f0a1b23-9c44-4d5e-8f31-b2c7a0e4d519"
  },
  "idempotentReplay": false
}
```

Then read the persisted evidence with the existing tools:

```jsonc
superadmin_validation_get({
  "projectId": "ac6d68be-272c-4bca-aab1-cd1a442cf960",
  "validationId": "6f0a1b23-9c44-4d5e-8f31-b2c7a0e4d519"
})
```

## Local verification

```bash
pnpm test:unit          # target/host/redirect/limit/interpolation/redaction unit tests
pnpm test:integration   # runner against a local mock HTTP server + published-registry contract
pnpm test:e2e           # full flow over real MCP JSON-RPC against a real HTTP fixture
pnpm mcp:health-check   # asserts the DEPLOYED endpoint publishes superadmin_scenario_run
```
