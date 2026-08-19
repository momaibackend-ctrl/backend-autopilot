# Runbook

## API/MCP will not start

Check Node `>=22`, run `pnpm bootstrap`, then `pnpm autopilot capabilities`. Without `DATABASE_URL`, the durable bootstrap registry uses the gitignored `.autopilot/state.json`. If an external control-plane URL is configured, run `pnpm db:migrate` before restart.

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
