# Runbook

## API/MCP will not start

Check Node `>=22`, run `pnpm bootstrap`, then `pnpm autopilot capabilities`. Without `DATABASE_URL`, the durable bootstrap registry uses the gitignored `.autopilot/state.json`. If an external control-plane URL is configured, run `pnpm db:migrate` before restart.

## Operator Console will not load

Run `pnpm dev` and open `http://localhost:3000` (use `localhost`, not a different host alias). Confirm `http://127.0.0.1:4310/health` responds. Next proxies `/api/control/*`; the browser must never be configured with provider tokens. If the shell appears but data does not, inspect the redacted API log and use the Retry button.

For the remote service, check GitHub Pages deployment, Supabase Function logs, and authenticated `control-api/health`. `401` means the Supabase session is absent or invalid; `403` means the operator or project membership is not allowlisted. Diagnose execution through its durable job/run and Actions URL. Invoke reconciliation after a cancelled or timed-out job that could not write its callback.

## Remote boot or redeploy fails

Confirm `DATABASE_URL`, `AUTOPILOT_HOST=0.0.0.0`, `AUTOPILOT_PORT=4310`, `AUTOPILOT_CONTROL_API_ORIGIN`, `AUTOPILOT_WORKSPACE_ROOT=/data/workspaces`, and the `/data` volume mount. First boot applies `0001_initial`, imports the portable seed only into an empty database, verifies `GH_TOKEN` resolves to `momaibackend-ctrl`, and restores the exact registered repository. A provider identity mismatch fails closed.

If PostgreSQL already contains projects, `deployment:bootstrap` skips seed import. If `/data/<workspace>` already contains `.git`, it reuses it without reset or checkout. Inspect structured `deployment.*` events; do not delete a database or volume to repair a configuration error. Restore from a hosting backup when data recovery is required.

## Validation fails

Open Validation History and expand the failed report. The human summary identifies the failed gate; technical details contain command exit status, redacted output, request/response, schema evidence, and artifact references. A missing required test is `PARTIAL`, not a pass. Production and non-allowlisted targets are expected `NOT_SUPPORTED`/`POLICY_VIOLATION` failures.

API Request Runner requires an active `HTTP_API` resource owned by the selected project and `AUTONOMOUS_STAGING`. Register the exact sandbox base URL through the normal Resource Registry; do not work around origin or credential checks. Saved scenarios stop after the first failed step and persist skipped steps.

## Browser E2E diagnosis

Run `pnpm console:e2e:seed` and `pnpm test:browser`. The fixture is written only under ignored `tests/.tmp`, contains sanitized LIVE-1-shaped evidence, starts both services, and performs no external provider calls. Use `pnpm exec playwright show-trace <trace.zip>` for a retained failure trace.

## Migration fails

Check the explicitly configured external `DATABASE_URL` and provider health. Re-running `pnpm db:migrate` is safe: schema objects use `IF NOT EXISTS`, and the trigger is recreated deterministically. Docker Compose is only an optional local provider.

## Bootstrap needs human action

`HUMAN_ACTION_REQUIRED` includes the official login/consent action. Complete only login, OAuth, 2FA, CAPTCHA, billing, or legal confirmation, then repeat the same idempotent operation ID. Do not manually create projects, copy resource IDs, or run migrations.

## Policy error

Inspect the typed code and details. `UNKNOWN_RESOURCE` means no explicit registration exists. `POLICY_VIOLATION` commonly means wrong project ownership, permission, disabled resource, OBSERVE mode, or command category. Never bypass PolicyEngine; correct the registry or mode.

## Execution fails

Confirm the target path equals both `project.workspacePath` and the local Git resource reference. The repository must have a clean `main` or `master` base. Review run/audit records and artifacts; secrets are redacted.

## Task is BLOCKED

Use `task_status`. Resolve dependencies/open failures. Automatic repairs stop after three attempts. An explicit retry is allowed only before the limit; changing that limit requires project policy review.

## E2E diagnosis

Run `pnpm test:e2e`. The test uses an OS temporary directory and leaves no external resources. Run each suite with `node --test <file>` inside the generated demo only while debugging.
