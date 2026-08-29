import type { ExecutionJob } from "../../schemas/src/index.js";

// When a durable execution job is allowed to stay alive, and what to do when it is not.
//
// The reconciler only ever looked at jobs that carried a `workflowRunId`, and almost none do:
// GitHub's workflow_dispatch endpoint answers 204 with an empty body, so the dispatcher has no run
// id to record. A job that was dispatched but never picked up therefore had no watchdog at all --
// it sat at DISPATCHED, its run sat at RUNNING, and its task sat at IMPLEMENTING indefinitely with
// no branch, no failure and nothing to act on. That is exactly how CORE-QA-02 stalled.
//
// Two things fix it together: the runner now stamps its own GITHUB_RUN_ID onto the job when it
// claims one, and the rules below terminalize a job on elapsed time even when no run id was ever
// recorded. A job with no observable progress is a failed job, and saying so is strictly better
// than a RUNNING state that can never end.

export const activeJobStatuses: ExecutionJob["status"][] = ["QUEUED", "DISPATCHING", "DISPATCHED", "CLAIMED", "RUNNING"];

export interface StaleThresholds {
  /** How long a dispatched job may go unclaimed before the workflow is presumed never to have started. */
  dispatchGraceMinutes: number;
  /** Extra time past a claim lease's expiry before the runner holding it is presumed dead. */
  leaseGraceMinutes: number;
  /** Absolute ceiling for a job that is genuinely running; the execution workflow itself caps at 60. */
  hardTimeoutMinutes: number;
}

// The execution workflow installs dependencies before it claims, so a few minutes of silence is
// normal; a quarter of an hour is not. The lease is 20 minutes, so a runner that has not renewed
// well past it is gone rather than slow.
export const defaultStaleThresholds: StaleThresholds = {
  dispatchGraceMinutes: 15,
  leaseGraceMinutes: 10,
  hardTimeoutMinutes: 90,
};

export type ReconcileDecision =
  | { action: "IGNORE"; reason: string }
  | { action: "WAIT"; reason: string }
  | { action: "TERMINALIZE"; status: ExecutionJob["status"]; code: string; reason: string; remediation: string };

export interface WorkflowRunView {
  status: string;
  conclusion?: string | undefined;
}

function minutesBetween(from: string | undefined, now: string): number {
  if (!from) return Number.POSITIVE_INFINITY;
  const start = Date.parse(from);
  const end = Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return (end - start) / 60_000;
}

function terminalStatusFor(conclusion: string | undefined): ExecutionJob["status"] {
  if (conclusion === "cancelled") return "CANCELLED";
  if (conclusion === "timed_out") return "TIMED_OUT";
  return "FAILED";
}

const restartRemediation =
  "Inspect the recorded workflow run, then re-execute the task with a NEW operationId; reusing the old one is status-only and will not redispatch.";

export function classifyExecutionJob(input: {
  job: ExecutionJob;
  now: string;
  /** The GitHub run, when the job recorded an id and the query succeeded. */
  workflowRun?: WorkflowRunView | undefined;
  thresholds?: StaleThresholds;
}): ReconcileDecision {
  const { job, now } = input;
  const thresholds = input.thresholds ?? defaultStaleThresholds;
  if (!activeJobStatuses.includes(job.status)) return { action: "IGNORE", reason: `Job is already terminal (${job.status})` };

  const ageMinutes = minutesBetween(job.queuedAt, now);
  const sinceUpdate = minutesBetween(job.updatedAt, now);

  if (input.workflowRun) {
    if (input.workflowRun.status === "completed") {
      return {
        action: "TERMINALIZE",
        status: terminalStatusFor(input.workflowRun.conclusion),
        code: `GITHUB_ACTIONS_${(input.workflowRun.conclusion ?? "UNKNOWN").toUpperCase()}`,
        reason: "Execution ended before its durable completion callback",
        remediation: restartRemediation,
      };
    }
    if (ageMinutes > thresholds.hardTimeoutMinutes) {
      return {
        action: "TERMINALIZE",
        status: "TIMED_OUT",
        code: "EXECUTION_EXCEEDED_HARD_TIMEOUT",
        reason: `The workflow run has been active for ${Math.round(ageMinutes)} minutes, beyond the ${thresholds.hardTimeoutMinutes}-minute ceiling, without writing a completion callback`,
        remediation: restartRemediation,
      };
    }
    return { action: "WAIT", reason: `Workflow run is ${input.workflowRun.status}` };
  }

  // No run id was ever recorded. Before this module that meant no watchdog whatsoever, so elapsed
  // time is the only honest signal left -- and it is a sufficient one.
  if (job.status === "CLAIMED" || job.status === "RUNNING") {
    const pastLease = minutesBetween(job.leaseExpiresAt, now);
    if (pastLease > thresholds.leaseGraceMinutes) {
      return {
        action: "TERMINALIZE",
        status: "TIMED_OUT",
        code: "EXECUTION_LEASE_EXPIRED",
        reason: job.leaseExpiresAt
          ? `The runner's claim lease expired ${Math.round(pastLease)} minutes ago and was never renewed or completed`
          : "The job is claimed but carries no lease, so no runner can be shown to still hold it",
        remediation: restartRemediation,
      };
    }
    if (ageMinutes > thresholds.hardTimeoutMinutes) {
      return {
        action: "TERMINALIZE",
        status: "TIMED_OUT",
        code: "EXECUTION_EXCEEDED_HARD_TIMEOUT",
        reason: `The job has been active for ${Math.round(ageMinutes)} minutes, beyond the ${thresholds.hardTimeoutMinutes}-minute ceiling`,
        remediation: restartRemediation,
      };
    }
    return { action: "WAIT", reason: "The claim lease is still valid" };
  }

  if (sinceUpdate > thresholds.dispatchGraceMinutes) {
    return {
      action: "TERMINALIZE",
      status: "FAILED",
      code: job.status === "QUEUED" ? "EXECUTION_NEVER_DISPATCHED" : "EXECUTION_NEVER_STARTED",
      reason: `The job has been ${job.status} for ${Math.round(sinceUpdate)} minutes with no runner claiming it and no workflow run recorded`,
      remediation:
        "Check that the execution workflow exists on the dispatch ref and that the dispatch credential can start it, then re-execute with a NEW operationId.",
    };
  }
  return { action: "WAIT", reason: `Job has been ${job.status} for ${Math.round(sinceUpdate)} minutes, within the dispatch grace period` };
}
