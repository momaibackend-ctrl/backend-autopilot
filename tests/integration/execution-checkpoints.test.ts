import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileStateStore } from "../../packages/project-registry/src/file-store.js";
import { systemClock, uuidGenerator } from "../../packages/core/src/ports.js";

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

// A hard kill of the worker process is, from the store's point of view, indistinguishable from
// simply never calling it again -- nothing more runs, nothing more gets a chance to write. The
// only thing that can prove evidence "survives" a kill is that a brand-new process (a fresh store
// instance over the same durable file, exactly as file-store.test.ts already proves for projects)
// can read back everything that was persisted before the old process stopped existing.
describe("execution checkpoints and heartbeat survive a hard kill", () => {
  it("keeps every checkpoint written before the crash, in order, readable by a freshly reconstructed store", async () => {
    root = await mkdtemp(join(tmpdir(), "autopilot-checkpoints-"));
    const path = join(root, "state.json");
    const first = new FileStateStore(path);
    const now = systemClock.now();
    const project = await first.createProject({ id: uuidGenerator.next(), name: "Crash proof", slug: "crash-proof", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: root, status: "ACTIVE", createdAt: now, updatedAt: now });
    const task = await first.createTask({ id: uuidGenerator.next(), projectId: project.id, externalKey: "CP-1", title: "Crash target", description: "", requirements: [], state: "IMPLEMENTING", relationships: [], repairAttempts: 0, createdAt: now, updatedAt: now });
    const job = await first.createExecutionJob({ id: uuidGenerator.next(), projectId: project.id, taskId: task.id, resourceId: uuidGenerator.next(), operationId: "op-crash-1", kind: "IMPLEMENTATION", status: "RUNNING", payload: {}, attempt: 0, queuedAt: systemClock.now(), updatedAt: systemClock.now() });

    // Simulate the runner completing its first two pipeline steps before the process is killed --
    // WORKSPACE_READY and IMPLEMENTATION_COMPLETE are durably written; nothing past that point
    // (PUSHED/TESTED/REVIEWED) ever happened, so it must not appear after reconstruction.
    await first.saveCheckpoint({ id: uuidGenerator.next(), jobId: job.id, projectId: project.id, taskId: task.id, seq: 0, step: "WORKSPACE_READY", data: { stack: "NODE" }, createdAt: systemClock.now() });
    await first.touchExecutionJobHeartbeat(project.id, job.id, systemClock.now());
    await first.saveCheckpoint({ id: uuidGenerator.next(), jobId: job.id, projectId: project.id, taskId: task.id, seq: 1, step: "IMPLEMENTATION_COMPLETE", data: { branch: "autopilot/cp-1" }, createdAt: systemClock.now() });

    // No clean shutdown of `first` happens here -- that is the point: a hard kill gives the
    // process no chance to run cleanup code either.
    const second = new FileStateStore(path);
    const checkpoints = await second.listCheckpoints(project.id, job.id);
    expect(checkpoints.map(c => c.step)).toEqual(["WORKSPACE_READY", "IMPLEMENTATION_COMPLETE"]);
    expect(checkpoints[1]?.data).toMatchObject({ branch: "autopilot/cp-1" });

    const restoredJob = await second.getExecutionJob(project.id, job.id);
    expect(restoredJob?.heartbeatAt).toBeTruthy();
    expect(restoredJob?.status).toBe("RUNNING");
  });
});
