import { describe, expect, it } from "vitest";
import { evaluateHeartbeat, HEARTBEAT_HARD_CEILING_MS, HEARTBEAT_SUSPECTED_MS } from "../../packages/core/src/reconcile.js";
import type { ExecutionJob } from "../../packages/schemas/src/index.js";

const NOW = "2026-08-24T12:00:00.000Z";
function minutesAgo(minutes: number) { return new Date(new Date(NOW).getTime() - minutes * 60_000).toISOString(); }
function job(overrides: Partial<ExecutionJob> & { status?: ExecutionJob["status"] } = {}): ExecutionJob {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    projectId: "22222222-2222-2222-2222-222222222222",
    taskId: "33333333-3333-3333-3333-333333333333",
    resourceId: "44444444-4444-4444-4444-444444444444",
    operationId: "job-op-1",
    kind: "IMPLEMENTATION",
    status: "RUNNING",
    payload: {},
    attempt: 0,
    queuedAt: minutesAgo(30),
    updatedAt: minutesAgo(30),
    ...overrides,
  };
}

describe("evaluateHeartbeat (pure decision)", () => {
  it("takes no action for a job that is not RUNNING, regardless of heartbeat age", () => {
    const decision = evaluateHeartbeat({ job: job({ status: "QUEUED", updatedAt: minutesAgo(60) }), now: NOW, lastKnownGithubStatus: "queued" });
    expect(decision.action).toBe("none");
  });

  it("takes no action while the heartbeat is fresh", () => {
    const decision = evaluateHeartbeat({ job: job({ heartbeatAt: minutesAgo(0.5) }), now: NOW, lastKnownGithubStatus: "in_progress" });
    expect(decision.action).toBe("none");
  });

  it("stays healthy right up to the suspected threshold", () => {
    const decision = evaluateHeartbeat({ job: job({ heartbeatAt: minutesAgo(HEARTBEAT_SUSPECTED_MS / 60_000 - 0.01) }), now: NOW, lastKnownGithubStatus: "in_progress" });
    expect(decision.action).toBe("none");
  });

  it("records a suspected checkpoint once heartbeat crosses the suspected threshold, without a prior episode", () => {
    const decision = evaluateHeartbeat({ job: job({ heartbeatAt: minutesAgo(3) }), now: NOW, lastKnownGithubStatus: "in_progress" });
    expect(decision).toMatchObject({ action: "record", step: "WATCHDOG_STALE_SUSPECTED" });
    expect((decision as { evidence: Record<string, unknown> }).evidence).toMatchObject({ lastKnownGithubStatus: "in_progress" });
  });

  it("does not record a second suspected checkpoint for the same open episode", () => {
    const decision = evaluateHeartbeat({ job: job({ heartbeatAt: minutesAgo(5) }), now: NOW, lastWatchdogStep: "WATCHDOG_STALE_SUSPECTED", lastKnownGithubStatus: "in_progress" });
    expect(decision.action).toBe("none");
  });

  it("records a recovered checkpoint once a fresh heartbeat closes an open suspected episode", () => {
    const decision = evaluateHeartbeat({ job: job({ heartbeatAt: minutesAgo(0.2) }), now: NOW, lastWatchdogStep: "WATCHDOG_STALE_SUSPECTED", lastKnownGithubStatus: "in_progress" });
    expect(decision).toMatchObject({ action: "record", step: "WATCHDOG_HEARTBEAT_RECOVERED" });
  });

  it("declares a job presumed dead only past the hard ceiling", () => {
    const justUnderCeiling = evaluateHeartbeat({ job: job({ heartbeatAt: minutesAgo(HEARTBEAT_HARD_CEILING_MS / 60_000 - 0.01) }), now: NOW, lastWatchdogStep: "WATCHDOG_STALE_SUSPECTED", lastKnownGithubStatus: "in_progress" });
    expect(justUnderCeiling.action).toBe("none");
    const pastCeiling = evaluateHeartbeat({ job: job({ heartbeatAt: minutesAgo(20), workflowRunId: "555", workflowRunUrl: "https://github.com/example/repo/actions/runs/555" }), now: NOW, lastWatchdogStep: "WATCHDOG_STALE_SUSPECTED", lastKnownGithubStatus: "in_progress" });
    expect(pastCeiling.action).toBe("presumed_dead");
    expect((pastCeiling as { evidence: Record<string, unknown> }).evidence).toMatchObject({ workflowRunUrl: "https://github.com/example/repo/actions/runs/555", lastKnownGithubStatus: "in_progress" });
  });

  it("falls back to updatedAt for a legacy job with no heartbeatAt yet, in both directions", () => {
    const recent = evaluateHeartbeat({ job: job({ updatedAt: minutesAgo(0.5) }), now: NOW, lastKnownGithubStatus: "in_progress" });
    expect(recent.action).toBe("none");
    const stale = evaluateHeartbeat({ job: job({ updatedAt: minutesAgo(20) }), now: NOW, lastKnownGithubStatus: "in_progress" });
    expect(stale.action).toBe("presumed_dead");
  });
});
