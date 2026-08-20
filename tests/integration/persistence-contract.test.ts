import { describe, it, expect } from "vitest";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";
describe("StateStore contract", () => {
  it("is idempotent by project operation ID", async () => {
    const s = new MemoryStateStore();
    const projectId = crypto.randomUUID(),
      taskId = crypto.randomUUID();
    const run = {
      id: crypto.randomUUID(),
      projectId,
      taskId,
      operationId: "same-operation",
      status: "RUNNING" as const,
      platformVersion: "0.3.0",
      workflowVersion: "2",
      policyVersion: "3",
      startedAt: new Date().toISOString(),
    };
    await s.saveRun(run);
    const duplicate = await s.saveRun({ ...run, id: crypto.randomUUID() });
    expect(duplicate.id).toBe(run.id);
  });
});
