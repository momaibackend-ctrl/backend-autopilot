import { describe, expect, it } from "vitest";
import { classifyExecutionJob, defaultStaleThresholds } from "../../packages/core/src/execution-reconciliation.js";
import type { ExecutionJob } from "../../packages/schemas/src/index.js";

const base = {
  id: "44444444-4444-4444-4444-444444444444",
  projectId: "22222222-2222-2222-2222-222222222222",
  taskId: "11111111-1111-1111-1111-111111111111",
  resourceId: "33333333-3333-3333-3333-333333333333",
  runId: "55555555-5555-5555-5555-555555555555",
  operationId: "op-core-qa-02",
  kind: "IMPLEMENTATION",
  payload: {},
  attempt: 0,
} as const;

const job = (over: Partial<ExecutionJob>): ExecutionJob =>
  ({ ...base, status: "DISPATCHED", queuedAt: "2026-08-29T10:00:00.000Z", updatedAt: "2026-08-29T10:00:00.000Z", ...over }) as ExecutionJob;

const minutesAfter = (minutes: number) => new Date(Date.parse("2026-08-29T10:00:00.000Z") + minutes * 60_000).toISOString();

describe("execution job reconciliation", () => {
  it("terminalizes a job that was dispatched and never started, even with no workflow run id", () => {
    // The CORE-QA-02 stall. workflow_dispatch answers 204 with an empty body, so the job never
    // carried a run id -- and the old reconciler only ever looked at jobs that had one, which made
    // this exact case invisible to it forever.
    const decision = classifyExecutionJob({ job: job({ status: "DISPATCHED" }), now: minutesAfter(45) });
    expect(decision.action).toBe("TERMINALIZE");
    if (decision.action !== "TERMINALIZE") return;
    expect(decision.status).toBe("FAILED");
    expect(decision.code).toBe("EXECUTION_NEVER_STARTED");
    expect(decision.remediation).toContain("NEW operationId");
  });

  it("leaves a freshly dispatched job alone inside the grace period", () => {
    const decision = classifyExecutionJob({ job: job({ status: "DISPATCHED" }), now: minutesAfter(defaultStaleThresholds.dispatchGraceMinutes - 1) });
    expect(decision.action).toBe("WAIT");
  });

  it("terminalizes a RUNNING job whose claim lease was never renewed", () => {
    const decision = classifyExecutionJob({
      job: job({ status: "RUNNING", leaseExpiresAt: minutesAfter(20) }),
      now: minutesAfter(20 + defaultStaleThresholds.leaseGraceMinutes + 1),
    });
    expect(decision.action).toBe("TERMINALIZE");
    if (decision.action !== "TERMINALIZE") return;
    expect(decision.status).toBe("TIMED_OUT");
    expect(decision.code).toBe("EXECUTION_LEASE_EXPIRED");
  });

  it("lets a running job with a live lease keep working", () => {
    const decision = classifyExecutionJob({ job: job({ status: "RUNNING", leaseExpiresAt: minutesAfter(20) }), now: minutesAfter(5) });
    expect(decision.action).toBe("WAIT");
  });

  it("treats a claimed job with no lease at all as unheld", () => {
    const decision = classifyExecutionJob({ job: job({ status: "CLAIMED" }), now: minutesAfter(1) });
    expect(decision.action).toBe("TERMINALIZE");
    if (decision.action !== "TERMINALIZE") return;
    expect(decision.code).toBe("EXECUTION_LEASE_EXPIRED");
  });

  it("keeps mapping a completed workflow run to its conclusion", () => {
    const decision = classifyExecutionJob({
      job: job({ status: "RUNNING", workflowRunId: "999", leaseExpiresAt: minutesAfter(20) }),
      now: minutesAfter(5),
      workflowRun: { status: "completed", conclusion: "cancelled" },
    });
    expect(decision.action).toBe("TERMINALIZE");
    if (decision.action !== "TERMINALIZE") return;
    expect(decision.status).toBe("CANCELLED");
    expect(decision.code).toBe("GITHUB_ACTIONS_CANCELLED");
  });

  it("caps a workflow run that reports in_progress forever", () => {
    // The execution workflow itself times out at 60 minutes; a run still claiming to be alive well
    // past that is not going to write a callback.
    const decision = classifyExecutionJob({
      job: job({ status: "RUNNING", workflowRunId: "999", leaseExpiresAt: minutesAfter(200) }),
      now: minutesAfter(defaultStaleThresholds.hardTimeoutMinutes + 5),
      workflowRun: { status: "in_progress" },
    });
    expect(decision.action).toBe("TERMINALIZE");
    if (decision.action !== "TERMINALIZE") return;
    expect(decision.status).toBe("TIMED_OUT");
    expect(decision.code).toBe("EXECUTION_EXCEEDED_HARD_TIMEOUT");
  });

  it("never touches a job that already reached a terminal status", () => {
    for (const status of ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "BLOCKED"] as const) {
      expect(classifyExecutionJob({ job: job({ status }), now: minutesAfter(10_000) }).action).toBe("IGNORE");
    }
  });
});
