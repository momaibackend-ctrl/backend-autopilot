# ADR 021: Automatic verification and a diagnosis for every NOT_PROVEN verdict

Status: accepted for v0.5. First part of stage 4b; the repair-attempt policy follows separately.

## Context

After ADR 020, an API task rests in `VERIFYING` until `PROVEN` HTTP E2E evidence for its exact commit is recorded. Two steps still depended on someone remembering to take them:

1. **Starting the verification.** The task waited for a caller to run `superadmin_http_e2e_run`.
2. **Interpreting a NOT_PROVEN verdict.** A failure class names the phase that broke, not what to change.
   - `BUILD_FAILED` can be a compile error, or a dependency download the network refused.
   - `ENVIRONMENT_BOOT_FAILED` can be a variable the application expects, a database it is not pointed at, or a migration that does not apply.

   Repairing without telling these apart is the blind retry this project has decided to stop.

## Decision

**Verification starts itself.** When an implementation job leaves its task in `VERIFYING`, the job dispatches the HTTP E2E workflow for its own commit:

- It does this after marking itself `SUCCEEDED`, because a task can have only one active job.
- It uses the dispatch credential it already holds, so the scheduled reconciler and its egress budget are not involved.
- The operationId is `auto-http-e2e:<task>:<commit>`, so a retried runner replays the job instead of starting a second one.
- A failure to dispatch never fails the finished execution. The task keeps `superadmin_http_e2e_run` as its next action.

**Every NOT_PROVEN verdict gets a diagnosis.** `diagnoseHttpE2e` reads the evidence the environment already collected: step log tails, the application's own log, failing scenario steps, coverage and parity differences. It returns:

- **`area`** — what to change: `IMPLEMENTATION`, `SCENARIOS`, `ENVIRONMENT_MANIFEST`, `CONTRACT`, `INFRASTRUCTURE` or `REFERENCE`.
- **`findings`** — the evidence that points there. Examples:
  - the compiler's own error lines;
  - the configuration placeholder the application could not resolve;
  - "connecting to localhost instead of the provided database";
  - the port the application really listens on;
  - each failing step, with the expected and actual status and what that status implies;
  - uncovered operations, inventory gaps and parity differences with their JSON paths.
- **`nextSteps`** — concrete actions, for example "declare `APP_JWT_ISSUER` in `.autopilot/environment.yml` env".
- **`fingerprint`** — a hash of the cause with run-specific values removed. The same error in another workspace or on another line matches; a different error does not.

The record job stores the diagnosis with the evidence. `superadmin_http_e2e_get` returns it. The task's `HTTP_E2E_EVIDENCE` blocker carries its summary, area and first step, so the agent reading readiness gets the cause, not just the class.

## Consequences

- An API task goes from review to verification without any call, and from a NOT_PROVEN verdict to a named cause with a place to fix it.
- The fingerprint makes progress measurable: a repair that changes the cause is progress, while one that reproduces the same fingerprint is not. Stage 4b's second part uses that to replace "N attempts, then BLOCKED" with cause-driven repair.
- Diagnosis is heuristic. When no specific pattern matches, it falls back to the class-level next step and still attaches the log lines, so it never returns nothing.
