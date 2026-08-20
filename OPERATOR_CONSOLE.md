# Operator Console contract

The browser is served locally at `http://localhost:3000` or remotely at the configured public HTTPS domain. All data and mutations go through same-origin `/api/control/v1/console`, proxied server-side to Fastify. The public deployment requires server-side Basic Auth; provider secrets never enter the browser. Responses are JSON; inputs are validated with Zod.

## Read routes

| Route | Purpose |
|---|---|
| `GET /overview` | Dashboard summary, projects, task/run counts, CI and recent events |
| `GET /projects/:projectId` | Project, resources, context, tasks, runs, database/API views, artifacts, audit and capabilities |
| `GET /projects/:projectId/tasks/:taskId` | Lifecycle, timeline and complete task evidence chain |
| `GET /projects/:projectId/validation?taskId=` | Persisted suite, request and saved-scenario history |

## Mutating routes

| Route | Semantic action |
|---|---|
| `POST /projects/:projectId/validation` | Run a named test suite for a planned task |
| `POST /projects/:projectId/api-request` | Send one request to a registered non-production `HTTP_API` resource |
| `POST /projects/:projectId/scenarios` | Persist a validated non-secret scenario definition |
| `POST /projects/:projectId/scenarios/run` | Execute a saved scenario and persist its report |

Every mutation requires an operation ID for idempotency. Production is `NOT_SUPPORTED`. Network calls additionally require an active resource owned by the URL project, `READ`, and `AUTONOMOUS_STAGING`.

## Scenario data flow

A step may extract values from `response.body.*`:

```json
{
  "name": "Login",
  "method": "POST",
  "path": "/login",
  "extract": {
    "user_id": { "path": "response.body.user_id", "sensitive": false },
    "credential": { "path": "response.body.access_token", "sensitive": true }
  }
}
```

Later steps may interpolate non-secret values as `{{user_id}}`. Sensitive values cannot be interpolated and may only be named by `bearerFrom`. They live only in server memory during the run and are written as `[REDACTED]` in artifacts/audit.

## UI trust boundary

Task source, repository content, descriptions, OpenAPI, diffs, SQL and artifacts are untrusted data. React renders them as escaped text or JSON. The console does not use raw HTML/Markdown and never receives secret values, `.env`, provider SDK credentials, or database connection strings.
