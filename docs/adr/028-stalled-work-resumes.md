# ADR 028: Stalled work resumes; it is not parked

Status: accepted for v0.5. Owner decision ("the tool must not hang; it fixes each error and always brings the work to completion"). Stage 2 of ADR 026. Amends ADR 012's reconciliation.

## Context

The scheduled reconciler runs every 15 minutes and ends jobs that stalled. A job stalls in one of three ways:

- it was dispatched but never started;
- its runner's lease lapsed;
- its GitHub run ended without the completion callback.

After ending such a job, the reconciler moved its task to `BLOCKED`. From then on nothing happened until somebody noticed. An agent whose session had ended never noticed, so the work simply stood still.

A stall is almost always the environment, not the work. Typical causes are a runner that never came, a lapsed lease, or a transient GitHub failure. The job already holds everything needed to do the same work again: the change set, branch, base commit, and the commit pin of a verification.

## Decision

**Resume, do not park.** `recoverStalledWork` lives in `packages/core/src/stall-recovery.ts`; the Edge reconciler is now a thin wrapper around it. For a stalled job of kind `IMPLEMENTATION`, `REPAIR`, `REBASE` or `HTTP_E2E`, it:

- **ends the stalled job** with its coded cause;
- **creates the next attempt.** This is a new job with the same work. Its `operationId` is `<original>#resume-<n>`, and it records the stalled job, the root job, the attempt number, the cause, and how many times in a row that cause has repeated;
- **keeps the task's state** (no `BLOCKED`) and keeps the run open;
- **audits** `execution.job.resumed`.

The workflow lifecycle fields stay behind on the stalled job. A commit the stalled job already published is kept, because origin really carries it.

**Back-off by cause.** The first attempt after a stall starts immediately. When the same cause repeats, the next attempt waits 15 minutes, then 30, 60, 120 and 240, and from then on the 6-hour ceiling. When the cause changes, attempts start immediately again.

The reconciler dispatches a waiting attempt once its time comes. If GitHub refuses the dispatch, the attempt stays queued with the refusal recorded and is tried again 15 minutes later. A broken environment is therefore retried for as long as it takes: never abandoned, and never spending a runner every quarter of an hour.

**One stop remains.** A run a person cancelled in GitHub is a decision, not a stall. Such a run ends as before and is not resumed. Job kinds whose work is not fully described by the job (`TEST`, `VALIDATION`, `RECONCILIATION`) also keep the previous behaviour.

**Visible.** `superadmin_project_brief` lists, for each job in flight, its attempt number, the cause of the last stall, its start time and any refused dispatch. The brief's rules tell an agent not to resend work that is already in flight.

**Cost.** The timer path still reads only active job statuses, plus the full documents of those few jobs. The read-cost test now covers both the Edge entry point and the core module.

**Role `TOOLING`.** This change also adds the repository role `TOOLING` (ADR 026) for the tooling that develops a product, such as Backend Autopilot itself, registered in a product's project but not part of the product.

## Consequences

- A stalled job no longer needs an agent or a person to notice it. The work continues, and anyone can see why it had to restart.
- A cause that repeats for hours points at the environment. The audit and the brief carry the cause, so it can be fixed at its source.
- Failures of the work itself are unchanged. A failed test, a review finding or a NOT_PROVEN verdict is not a stall; those still go through cause-driven repair (ADR 022).
