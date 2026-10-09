import { describe, expect, it } from "vitest";
import { AutopilotService } from "../../packages/core/src/application.js";
import { UnsupportedOperation } from "../../packages/core/src/errors.js";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";
import type { ImplementationPlan, TestReport } from "../../packages/schemas/src/index.js";

// The test executor returns whatever the scenario below queues, so the repair policy is exercised
// end to end through the real taskTest gate and workflow, without a workspace.
function serviceWith(results: TestReport[]) {
  const store = new MemoryStateStore();
  const unavailable = async (): Promise<never> => {
    throw new UnsupportedOperation("not used here");
  };
  const service = new AutopilotService({
    store,
    execution: { execute: unavailable },
    tests: {
      run: async (_workspace: string, _taskId: string, plan: ImplementationPlan) => {
        const next = results.shift();
        if (!next) throw new Error("no queued result");
        return { ...next, suites: next.suites.length ? next.suites : plan.testsRequired.map((type) => ({ type, command: ["pnpm", "test"], passed: true, exitCode: 0 })) };
      },
    },
    git: { snapshot: unavailable, branch: unavailable, stage: unavailable, diff: unavailable, commit: unavailable },
    commands: { drain: () => [] },
  });
  return { store, service };
}
const failing = (type: string): TestReport => ({ passed: false, suites: [{ type, command: ["pnpm", "test"], passed: false, exitCode: 1 }], finishedAt: new Date().toISOString() });

async function implementingTask(results: TestReport[]) {
  const { store, service } = serviceWith(results);
  const project = await service.projectCreate({ name: "Repair", slug: `repair-${crypto.randomUUID()}`, sourceType: "LOCAL", environment: "SANDBOX", autonomyMode: "GUARDED", workspacePath: "tests/.tmp/repair" });
  const task = await service.taskCreate({ projectId: project.id, externalKey: "FIX-1", title: "Repair loop", description: "d", requirements: ["r"], relationships: [] });
  await service.taskAnalyze(project.id, task.id);
  await service.taskPlan(project.id, task.id);
  await store.updateTask({ ...(await store.getTask(project.id, task.id))!, state: "IMPLEMENTING" });
  return { store, service, project, task };
}

describe("cause-driven repair (no attempt limit)", () => {
  it("returns every failed run to IMPLEMENTING, and turns a repeated cause into new guidance instead of BLOCKED", async () => {
    const { service, project, task } = await implementingTask([failing("UNIT"), failing("INTEGRATION"), failing("UNIT"), failing("UNIT"), failing("UNIT")]);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(service.taskTest(project.id, task.id, "runner", `attempt-${attempt}`, "tests/.tmp/repair")).rejects.toMatchObject({ code: "TEST_FAILED" });
      expect((await service.taskGet(project.id, task.id)).state).toBe("IMPLEMENTING");
    }
    const readiness = await service.taskReadiness(project.id, task.id);
    expect(readiness.repair).toMatchObject({ failures: 5, consecutiveSameCause: 3, stagnating: true });
    expect(readiness.nextAction?.tool).toBe("superadmin_task_execute");
    expect(readiness.nextAction?.why).toMatch(/new hypothesis/);
    const transitions = (await service.taskStatus(project.id, task.id)).transitions;
    expect(transitions.some((value) => value.to === "BLOCKED")).toBe(false);
    expect(transitions.at(-1)?.reason).toBe("Tests failed with the same cause 3 times in a row; the next repair needs a new hypothesis");
    expect((await service.taskGet(project.id, task.id)).repairAttempts).toBe(5);
  });

  it("treats a changed cause as progress and passes the gate when the tests pass", async () => {
    const passing: TestReport = { passed: true, suites: [], finishedAt: new Date().toISOString() };
    const { service, project, task } = await implementingTask([failing("UNIT"), failing("INTEGRATION"), passing]);
    await expect(service.taskTest(project.id, task.id, "runner", "a-1", "tests/.tmp/repair")).rejects.toMatchObject({ code: "TEST_FAILED" });
    await expect(service.taskTest(project.id, task.id, "runner", "a-2", "tests/.tmp/repair")).rejects.toMatchObject({ code: "TEST_FAILED", details: { progress: { consecutiveSameCause: 1, stagnating: false } } });
    const passed = await service.taskTest(project.id, task.id, "runner", "a-3", "tests/.tmp/repair");
    expect(passed.task.state).toBe("REVIEWING");
  });

  it("lets a BLOCKED or FAILED task retry regardless of how many attempts it took", async () => {
    const { store, service, project, task } = await implementingTask([]);
    await store.updateTask({ ...(await store.getTask(project.id, task.id))!, state: "BLOCKED", repairAttempts: 12 });
    expect((await service.taskRetry(project.id, task.id)).state).toBe("ANALYZING");
  });
});
