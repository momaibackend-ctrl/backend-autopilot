# ADR 024: Capabilities up front, and every refusal on the record

Status: accepted for v0.5.

## Context

Remote backend development kept stopping one refusal at a time. In the first real port verification (a Kotlin service and its Java port), the agent prepared new tests for the Java repository, and writing them was refused twice. A re-run was also refused. The only report the agent could give was "the tool blocked it". Afterwards, reading the control plane state showed three independent reasons, all unknowable from the agent's side:

1. The Java repository was registered with `READ`, the default. A change set needs `WRITE`, and the refusal did not say how to obtain it.
2. The task was still `INGESTED`. Execution accepts only planned tasks.
3. The project's canonical development repository is the Kotlin one. New work in the project executes only there, by design, so the Java repository could not receive a change set even with `WRITE`.

Nothing recorded the refusals themselves. The audit trail held only what succeeded, so even the operator could not see what had been refused or why.

A fourth problem surfaced at the same time. An `HTTP_E2E` job pinned its task to the repository it verified, just as an implementation job does. That would have let a task execute in a non-canonical repository simply because it had verified that repository first: a hole in the canonical rule, opened by a read-only verification.

## Decision

- **`superadmin_project_capabilities({projectId})`** (read-only) answers the whole question before work starts. For each registered GitHub repository it reports `READ_AND_PLAN`, `HTTP_E2E`, `EXECUTE_CHANGES`, `OPEN_PULL_REQUEST`, `MERGE_PULL_REQUEST` and `RENAME`. Each one is allowed, or comes with every missing requirement and the exact call that closes it:
  - registration access (`superadmin_repository_register … access FULL`);
  - autonomy mode (`superadmin_project_update … AUTONOMOUS_STAGING`);
  - the canonical development repository (plan and promote, or keep developing in the canonical one);
  - GitHub-side push or admin, from a live view of the repository;
  - deployment wiring, which is reported as such rather than as something the agent can fix.

  The decisions come from the same conditions the real tools enforce.
- **Every refused superadmin mutation is audited** as `mcp.<tool>.refused`, with its code, message and redacted details. It is not stored as an admin operation, so the same `operationId` can be retried once the cause is fixed.
- **A permission refusal names the remedy.** For a GitHub repository, that is re-registration with access `FULL`, which is verified against GitHub again.
- **Only development jobs pin a task to a repository.** `HTTP_E2E` jobs are excluded, so verifying a repository never makes it the task's development target past the canonical rule.

## Consequences

- An agent can see, before preparing any work, that a repository can be verified but not developed, and why. The operator can see every refusal and its reason after the fact.
- The canonical rule itself is unchanged and stays a product decision. Developing a port in the same project means promoting it to canonical: all new work then goes there, and the original can still be verified. The other option is to keep developing the original. Capabilities state this choice instead of discovering it through a refusal.
