import { describe, expect, it } from "vitest";
import {
  rebaseBranchName,
  resolveRebasePlan,
} from "../../packages/superadmin/src/rebase-eligibility.js";
import type {
  Artifact,
  Resource,
  Run,
  Task,
} from "../../packages/schemas/src/index.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const branch = "autopilot/CORE-BE-04-platform";
const originalBase = "a".repeat(40);
const verified = "b".repeat(40);

const task = (overrides: Partial<Task> = {}): Task => ({
  id: taskId,
  projectId,
  externalKey: "CORE-BE-04",
  title: "Platform",
  description: "",
  requirements: [],
  state: "READY",
  relationships: [],
  repairAttempts: 0,
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
  ...overrides,
});
const resource = (overrides: Partial<Resource> = {}): Resource => ({
  resourceId: "33333333-3333-4333-8333-333333333333",
  type: "GITHUB_REPOSITORY",
  provider: "github",
  externalReference: "owner/sandbox",
  projectId,
  environment: "SANDBOX",
  permissions: ["READ", "WRITE", "ADMIN"],
  status: "ACTIVE",
  secretRefs: [],
  createdAt: "2026-08-23T00:00:00.000Z",
  ...overrides,
});
const run = (overrides: Partial<Run> = {}): Run => ({
  id: "44444444-4444-4444-8444-444444444444",
  projectId,
  taskId,
  operationId: "op-00000001",
  status: "SUCCEEDED",
  platformVersion: "0.5.0",
  workflowVersion: "4",
  policyVersion: "4",
  startedAt: "2026-08-23T01:00:00.000Z",
  ...overrides,
});
const manifest = (overrides: Partial<Artifact> = {}): Artifact => ({
  id: "55555555-5555-4555-8555-555555555555",
  projectId,
  taskId,
  kind: "FINAL_CHANGE_MANIFEST",
  schemaVersion: "5",
  content: { verifiedCommitSha: verified },
  contentHash: "hash",
  status: "AVAILABLE",
  createdAt: "2026-08-23T02:00:00.000Z",
  ...overrides,
});

/** A completed task: first run forked from the dependency, last run is the verified head. */
const history = () => ({
  task: task(),
  resource: resource(),
  runs: [
    run({
      id: "44444444-4444-4444-8444-44444444444a",
      status: "FAILED",
      baseCommit: originalBase,
      commitSha: "c".repeat(40),
      branch,
      startedAt: "2026-08-23T01:00:00.000Z",
    }),
    run({
      status: "SUCCEEDED",
      baseCommit: "c".repeat(40),
      commitSha: verified,
      branch,
      startedAt: "2026-08-23T01:30:00.000Z",
    }),
  ],
  artifacts: [manifest()],
});

describe("rebase plan resolution", () => {
  it("derives branch, verified commit and the original fork point from durable evidence", () => {
    const plan = resolveRebasePlan(history());
    expect(plan).toEqual({
      sourceBranch: branch,
      sourceCommitSha: verified,
      // The FIRST run's base is the transfer boundary, not the latest run's base.
      originalBaseCommit: originalBase,
      manifestArtifactId: "55555555-5555-4555-8555-555555555555",
      rebaseBranchPrefix: branch,
    });
  });

  it("orders runs by start time rather than trusting array order", () => {
    const input = history();
    const plan = resolveRebasePlan({ ...input, runs: [...input.runs].reverse() });
    expect(plan.originalBaseCommit).toBe(originalBase);
    expect(plan.sourceCommitSha).toBe(verified);
  });

  it("requires a task that already reached READY", () => {
    expect(() =>
      resolveRebasePlan({ ...history(), task: task({ state: "IMPLEMENTING" }) }),
    ).toThrowError(/already passed every READY gate/);
  });

  it("requires an active non-production sandbox repository with WRITE and ADMIN", () => {
    for (const override of [
      { environment: "PRODUCTION" as const },
      { status: "DISABLED" as const },
      { permissions: ["READ", "WRITE"] as Resource["permissions"] },
      { type: "HTTP_API" as const },
    ])
      expect(
        () =>
          resolveRebasePlan({
            ...history(),
            resource: resource(override),
          }),
        JSON.stringify(override),
      ).toThrowError();
  });

  it("refuses to transfer without a verified manifest or a matching successful run", () => {
    expect(() =>
      resolveRebasePlan({ ...history(), artifacts: [] }),
    ).toThrowError(/verified FINAL_CHANGE_MANIFEST/);
    expect(() =>
      resolveRebasePlan({
        ...history(),
        runs: [run({ baseCommit: originalBase, commitSha: "d".repeat(40), branch })],
      }),
    ).toThrowError(/does not match the task's verified commit/);
    expect(() =>
      resolveRebasePlan({
        ...history(),
        artifacts: [manifest({ status: "DELETED" })],
      }),
    ).toThrowError(/verified FINAL_CHANGE_MANIFEST/);
  });

  it("refuses when there is no recorded fork point or nothing to transfer", () => {
    expect(() =>
      resolveRebasePlan({
        ...history(),
        runs: [run({ commitSha: verified, branch })],
      }),
    ).toThrowError(/original base commit/);
    expect(() =>
      resolveRebasePlan({
        ...history(),
        runs: [run({ baseCommit: verified, commitSha: verified, branch })],
      }),
    ).toThrowError(/nothing to transfer/);
  });

  it("builds a deterministic, length-bounded rebase branch name", () => {
    expect(rebaseBranchName(branch, verified)).toBe(
      `${branch}-rebase-${verified.slice(0, 12)}`,
    );
    const long = `autopilot/${"x".repeat(300)}`;
    expect(rebaseBranchName(long, verified).length).toBeLessThanOrEqual(240);
    expect(rebaseBranchName(long, verified).startsWith("autopilot/")).toBe(true);
  });
});
