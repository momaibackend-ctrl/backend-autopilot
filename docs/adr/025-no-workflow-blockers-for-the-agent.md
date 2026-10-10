# ADR 025: The agent develops in any registered repository

Status: accepted for v0.5. Owner decision. Amends ADR 023 and the canonical development repository rule.

## Context

Backend Autopilot replaces a backend developer. A developer is not stopped from working in a repository their project owns because another repository is marked as the default, nor because the task card has not yet been moved to "planned".

The first real port (Momna: Kotlin, with Java as the port) showed three such stops on the remote MCP path:

- **The canonical rule was a fence.** Once a project had an ACTIVE canonical development repository, naming any other registered repository was refused with `CANONICAL_TARGET_REQUIRED`. Tests for the Java port could not be written while Kotlin was canonical.
- **Registration defaulted to `READ`.** A repository registered without an explicit access level could be verified but not developed in.
- **Unplanned tasks were refused.** `superadmin_task_execute` refused a task in `INGESTED`/`ANALYZING`, although analysis and planning are deterministic calls the autopilot makes itself.

The project owner decided that none of these may block development.

## Decision

- **The canonical repository is the default development target, not the only one.** With no `resourceId`, work goes to the canonical repository as before. A named, registered repository of the project is used as named, and every other check applies to it unchanged: registration, `WRITE`, PolicyEngine `EXECUTE`, SANDBOX, the READY gate. A task that already executed still keeps its pinned repository, so its branch and verified commit stay meaningful. That is continuity, not a fence.
- **`superadmin_repository_register` grants `FULL` (`READ`, `WRITE`, `ADMIN`) by default.** `access: READ` remains available for verification-only registrations. The verification against GitHub itself is unchanged: exact name, ADMIN for the control-plane identity, one project.
- **`superadmin_task_execute` (and `superadmin_job_create`) analyze and plan an unplanned task on the way.** This covers `INGESTED`, `FAILED` and `BLOCKED` (analyze, then plan) and `ANALYZING` (plan). The calls are the same ones an agent would make, with the same requirements snapshot, plan, verification profile and audit.
- `superadmin_project_capabilities` no longer reports the canonical binding as a missing requirement.

## What stays

The rules in AGENTS.md that make the work safe, not slower, are untouched:

- production is `NOT_SUPPORTED`;
- every write crosses PolicyEngine;
- no shell, SQL or arbitrary URL tools;
- secrets are never persisted;
- a task reaches READY only through every gate, and only READY tasks merge.

Refusals that remain are audited with their reason (ADR 024).
