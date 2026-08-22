import { describe, expect, it } from "vitest";
import { resolveMergeableCommit } from "../../packages/superadmin/src/merge-eligibility.js";
import type { Artifact, Resource, Run, Task } from "../../packages/schemas/src/index.js";

const baseTask: Task = {
  id: "11111111-1111-1111-1111-111111111111",
  projectId: "22222222-2222-2222-2222-222222222222",
  externalKey: "CORE-BE-01",
  title: "Task",
  description: "d",
  requirements: ["r"],
  relationships: [],
  state: "READY",
  repairAttempts: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as unknown as Task;

const baseResource: Resource = {
  resourceId: "33333333-3333-3333-3333-333333333333",
  projectId: baseTask.projectId,
  type: "GITHUB_REPOSITORY",
  provider: "github",
  externalReference: "owner/repo",
  environment: "SANDBOX",
  permissions: ["READ", "WRITE", "ADMIN"],
  secretRefs: [],
  status: "ACTIVE",
} as unknown as Resource;

const commitSha = "a".repeat(40);

const manifestArtifact: Artifact = {
  id: "44444444-4444-4444-4444-444444444444",
  projectId: baseTask.projectId,
  taskId: baseTask.id,
  kind: "FINAL_CHANGE_MANIFEST",
  status: "AVAILABLE",
  content: { verifiedCommitSha: commitSha },
  contentHash: "hash",
  createdAt: "2026-01-01T00:00:00.000Z",
} as unknown as Artifact;

const succeededRun: Run = {
  id: "55555555-5555-5555-5555-555555555555",
  projectId: baseTask.projectId,
  taskId: baseTask.id,
  operationId: "op-1",
  status: "SUCCEEDED",
  commitSha,
  branch: "autopilot/CORE-BE-01-task",
  platformVersion: "1",
  workflowVersion: "1",
  policyVersion: "1",
  startedAt: "2026-01-01T00:00:00.000Z",
} as unknown as Run;

describe("merge eligibility", () => {
  it("resolves the verified branch and commit on the happy path", () => {
    const result = resolveMergeableCommit({
      task: baseTask,
      resource: baseResource,
      runs: [succeededRun],
      artifacts: [manifestArtifact],
    });
    expect(result).toEqual({ branch: "autopilot/CORE-BE-01-task", commitSha });
  });

  it("rejects a task that is not READY", () => {
    expect(() =>
      resolveMergeableCommit({
        task: { ...baseTask, state: "REVIEWING" },
        resource: baseResource,
        runs: [succeededRun],
        artifacts: [manifestArtifact],
      }),
    ).toThrow(/READY/);
  });

  it("rejects a resource missing ADMIN permission", () => {
    expect(() =>
      resolveMergeableCommit({
        task: baseTask,
        resource: { ...baseResource, permissions: ["READ", "WRITE"] },
        runs: [succeededRun],
        artifacts: [manifestArtifact],
      }),
    ).toThrow(/permission/i);
  });

  it("rejects a resource missing WRITE permission", () => {
    expect(() =>
      resolveMergeableCommit({
        task: baseTask,
        resource: { ...baseResource, permissions: ["READ", "ADMIN"] },
        runs: [succeededRun],
        artifacts: [manifestArtifact],
      }),
    ).toThrow(/permission/i);
  });

  it("rejects a PRODUCTION resource", () => {
    expect(() =>
      resolveMergeableCommit({
        task: baseTask,
        resource: { ...baseResource, environment: "PRODUCTION" },
        runs: [succeededRun],
        artifacts: [manifestArtifact],
      }),
    ).toThrow(/not supported/i);
  });

  it("rejects when the latest run's commit does not match the verified manifest SHA", () => {
    expect(() =>
      resolveMergeableCommit({
        task: baseTask,
        resource: baseResource,
        runs: [{ ...succeededRun, commitSha: "b".repeat(40) }],
        artifacts: [manifestArtifact],
      }),
    ).toThrow(/verified commit/i);
  });

  it("rejects when there is no FINAL_CHANGE_MANIFEST", () => {
    expect(() =>
      resolveMergeableCommit({
        task: baseTask,
        resource: baseResource,
        runs: [succeededRun],
        artifacts: [],
      }),
    ).toThrow(/manifest/i);
  });
});
