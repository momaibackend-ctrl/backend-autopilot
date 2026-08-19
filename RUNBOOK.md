# Runbook

## API/MCP will not start

Check Node `>=22`, copy `.env.example` to `.env`, start PostgreSQL, then run `pnpm db:migrate`. `DATABASE_URL is required` means persistent state is intentionally unavailable; do not silently switch a deployed runtime to memory mode.

## Migration fails

Run `docker compose ps` and confirm the healthcheck is healthy. Verify port `54329` is free. Re-running `pnpm db:migrate` is safe: schema objects use `IF NOT EXISTS`, and the trigger is recreated deterministically.

## Policy error

Inspect the typed code and details. `UNKNOWN_RESOURCE` means no explicit registration exists. `POLICY_VIOLATION` commonly means wrong project ownership, permission, disabled resource, OBSERVE mode, or command category. Never bypass PolicyEngine; correct the registry or mode.

## Execution fails

Confirm the target path equals both `project.workspacePath` and the local Git resource reference. The repository must have a clean `main` or `master` base. Review run/audit records and artifacts; secrets are redacted.

## Task is BLOCKED

Use `task_status`. Resolve dependencies/open failures. Automatic repairs stop after three attempts. An explicit retry is allowed only before the limit; changing that limit requires project policy review.

## E2E diagnosis

Run `pnpm test:e2e`. The test uses an OS temporary directory and leaves no external resources. Run each suite with `node --test <file>` inside the generated demo only while debugging.
