import { describe, expect, it } from "vitest";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";
import { applyHeartbeatWatchdog } from "../../packages/core/src/reconcile.js";
import { systemClock, uuidGenerator } from "../../packages/core/src/ports.js";
import type { ExecutionJob } from "../../packages/schemas/src/index.js";

function minutesAgo(minutes: number) { return new Date(Date.now() - minutes * 60_000).toISOString(); }

async function seed(store: MemoryStateStore) {
  const now = systemClock.now();
  const project = await store.createProject({ id: uuidGenerator.next(), name: "Watchdog", slug: `watchdog-${uuidGenerator.next()}`, sourceType: "TEST", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "", status: "ACTIVE", createdAt: now, updatedAt: now });
  const task = await store.createTask({ id: uuidGenerator.next(), projectId: project.id, externalKey: "WD-1", title: "Watchdog target", description: "", requirements: [], state: "IMPLEMENTING", relationships: [], repairAttempts: 0, createdAt: now, updatedAt: now });
  return { project, task };
}
function baseJob(projectId: string, taskId: string, overrides: Partial<ExecutionJob> = {}): ExecutionJob {
  return {
    id: uuidGenerator.next(), projectId, taskId, resourceId: uuidGenerator.next(),
    operationId: `op-${uuidGenerator.next()}`, kind: "IMPLEMENTATION", status: "RUNNING", payload: {}, attempt: 0,
    queuedAt: minutesAgo(30), updatedAt: minutesAgo(30), workflowRunId: "999",
    ...overrides,
  };
}

describe("applyHeartbeatWatchdog against a real StateStore", () => {
  it("takes no action and writes no evidence while the heartbeat is fresh", async () => {
    const store = new MemoryStateStore();
    const { project, task } = await seed(store);
    const value = await store.createExecutionJob(baseJob(project.id, task.id, { heartbeatAt: systemClock.now() }));
    const result = await applyHeartbeatWatchdog(store, systemClock, uuidGenerator, value, "in_progress");
    expect(result.action).toBe("none");
    expect(await store.listCheckpoints(project.id, value.id)).toEqual([]);
    expect((await store.getExecutionJob(project.id, value.id))?.status).toBe("RUNNING");
  });

  it("opens a suspected episode once, self-heals on recovery, and never changes job status either way", async () => {
    const store = new MemoryStateStore();
    const { project, task } = await seed(store);
    const value = await store.createExecutionJob(baseJob(project.id, task.id, { heartbeatAt: minutesAgo(3) }));

    const first = await applyHeartbeatWatchdog(store, systemClock, uuidGenerator, value, "in_progress");
    expect(first.action).toBe("record");
    expect((await store.listCheckpoints(project.id, value.id)).map(c => c.step)).toEqual(["WATCHDOG_STALE_SUSPECTED"]);

    // A second tick while still stale must not duplicate the suspected marker.
    const second = await applyHeartbeatWatchdog(store, systemClock, uuidGenerator, value, "in_progress");
    expect(second.action).toBe("none");
    expect((await store.listCheckpoints(project.id, value.id)).map(c => c.step)).toEqual(["WATCHDOG_STALE_SUSPECTED"]);

    const recovered = { ...value, heartbeatAt: systemClock.now() };
    const third = await applyHeartbeatWatchdog(store, systemClock, uuidGenerator, recovered, "in_progress");
    expect(third.action).toBe("record");
    expect((await store.listCheckpoints(project.id, value.id)).map(c => c.step)).toEqual(["WATCHDOG_STALE_SUSPECTED", "WATCHDOG_HEARTBEAT_RECOVERED"]);
    expect((await store.getExecutionJob(project.id, value.id))?.status).toBe("RUNNING");
  });

  it("moves job and run to UNVERIFIED with evidence at the hard ceiling, leaves task state untouched, and is safe to repeat", async () => {
    const store = new MemoryStateStore();
    const { project, task } = await seed(store);
    const value = await store.createExecutionJob(baseJob(project.id, task.id, { heartbeatAt: minutesAgo(20), runId: uuidGenerator.next() }));
    const run = await store.saveRun({ id: value.runId!, projectId: project.id, taskId: task.id, operationId: value.operationId, status: "RUNNING", platformVersion: "0.5.0", workflowVersion: "0.5.0", policyVersion: "0.5.0", startedAt: systemClock.now() });

    const result = await applyHeartbeatWatchdog(store, systemClock, uuidGenerator, value, "in_progress");
    expect(result.action).toBe("presumed_dead");

    const updatedJob = await store.getExecutionJob(project.id, value.id);
    expect(updatedJob?.status).toBe("UNVERIFIED");
    expect(updatedJob?.error).toMatchObject({ code: "HEARTBEAT_PRESUMED_DEAD" });

    const updatedRun = await store.getRun(project.id, run.id);
    expect(updatedRun?.status).toBe("UNVERIFIED");

    const updatedTask = await store.getTask(project.id, task.id);
    expect(updatedTask?.state).toBe("IMPLEMENTING");

    const checkpoints = await store.listCheckpoints(project.id, value.id);
    expect(checkpoints.map(c => c.step)).toEqual(["WATCHDOG_PRESUMED_DEAD"]);
    expect(checkpoints[0]?.data).toMatchObject({ lastKnownGithubStatus: "in_progress" });

    // A repeated/duplicate tick against the same (now stale, already-acted-on) job snapshot must
    // be a safe no-op rather than a second transition or a second worker being spun up.
    const repeat = await applyHeartbeatWatchdog(store, systemClock, uuidGenerator, value, "in_progress");
    expect(repeat.action).toBe("none");
    expect((await store.listCheckpoints(project.id, value.id)).length).toBe(1);
  });

  it("falls back to updatedAt for a legacy job with no heartbeatAt, without throwing", async () => {
    const store = new MemoryStateStore();
    const { project, task } = await seed(store);
    const legacy = await store.createExecutionJob(baseJob(project.id, task.id, { updatedAt: minutesAgo(20) }));
    const result = await applyHeartbeatWatchdog(store, systemClock, uuidGenerator, legacy, "in_progress");
    expect(result.action).toBe("presumed_dead");
    expect((await store.getExecutionJob(project.id, legacy.id))?.status).toBe("UNVERIFIED");
  });
});
