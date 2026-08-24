import { describe, expect, it } from "vitest";
import { adminOperationSchema, executionJobSchema, runSchema } from "../../packages/schemas/src/index.js";

const baseRun = {
  id: "11111111-1111-1111-1111-111111111111",
  projectId: "22222222-2222-2222-2222-222222222222",
  taskId: "33333333-3333-3333-3333-333333333333",
  operationId: "run-op-1",
  platformVersion: "0.5.0",
  workflowVersion: "0.5.0",
  policyVersion: "0.5.0",
  startedAt: "2026-08-24T00:00:00.000Z",
};

const baseJob = {
  id: "44444444-4444-4444-4444-444444444444",
  projectId: "22222222-2222-2222-2222-222222222222",
  taskId: "33333333-3333-3333-3333-333333333333",
  resourceId: "55555555-5555-5555-5555-555555555555",
  operationId: "job-op-1",
  kind: "IMPLEMENTATION",
  attempt: 1,
  queuedAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
};

describe("resumable-execution status vocabulary", () => {
  it("accepts PARTIAL_SUCCESS and UNVERIFIED as run statuses", () => {
    expect(runSchema.parse({ ...baseRun, status: "PARTIAL_SUCCESS" }).status).toBe("PARTIAL_SUCCESS");
    expect(runSchema.parse({ ...baseRun, status: "UNVERIFIED" }).status).toBe("UNVERIFIED");
  });

  it("accepts PARTIAL_SUCCESS and UNVERIFIED as execution job statuses", () => {
    expect(executionJobSchema.parse({ ...baseJob, status: "PARTIAL_SUCCESS" }).status).toBe("PARTIAL_SUCCESS");
    expect(executionJobSchema.parse({ ...baseJob, status: "UNVERIFIED" }).status).toBe("UNVERIFIED");
  });

  it("rejects an unrecognized status so the vocabulary stays closed", () => {
    expect(() => runSchema.parse({ ...baseRun, status: "MOSTLY_FINE" })).toThrow();
    expect(() => executionJobSchema.parse({ ...baseJob, status: "MOSTLY_FINE" })).toThrow();
  });

  it("defaults an admin operation to COMPLETED for backward compatibility with pre-existing records", () => {
    const parsed = adminOperationSchema.parse({
      operationId: "legacy-operation-1",
      actor: "test-actor",
      tool: "project_create",
      result: { ok: true },
      createdAt: "2026-08-24T00:00:00.000Z",
    });
    expect(parsed.status).toBe("COMPLETED");
  });

  it("accepts an explicit PENDING admin operation with no result yet", () => {
    const parsed = adminOperationSchema.parse({
      operationId: "in-flight-operation-1",
      actor: "test-actor",
      tool: "project_create",
      status: "PENDING",
      createdAt: "2026-08-24T00:00:00.000Z",
    });
    expect(parsed.status).toBe("PENDING");
    expect(parsed.result).toBeUndefined();
  });
});
