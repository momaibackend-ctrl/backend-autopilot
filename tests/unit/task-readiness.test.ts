import { describe, expect, it } from "vitest";
import {
  hasExactCiReport,
  requiredGateArtifacts,
  taskReadiness,
} from "../../packages/core/src/task-readiness.js";
import type { Artifact, Run, Task } from "../../packages/schemas/src/index.js";

const projectId = "22222222-2222-2222-2222-222222222222";
const taskId = "11111111-1111-1111-1111-111111111111";

const task = (state: string): Task =>
  ({ id: taskId, projectId, externalKey: "CORE-BE-11", title: "t", description: "d", requirements: ["r"], relationships: [], state, repairAttempts: 0, createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z" }) as unknown as Task;

const artifact = (kind: Artifact["kind"], content: unknown = {}): Artifact =>
  ({ id: `${kind}-${Math.random()}`, projectId, taskId, kind, schemaVersion: "5", content, contentHash: "h", status: "AVAILABLE", createdAt: "2026-08-28T00:00:00.000Z" }) as unknown as Artifact;

const run = (commitSha: string): Run =>
  ({ id: "r1", projectId, taskId, operationId: "op", status: "SUCCEEDED", branch: "autopilot/x", commitSha, startedAt: "2026-08-28T00:00:00.000Z" }) as unknown as Run;

const everyGateArtifact = (commit: string) => [
  artifact("REQUIREMENTS_SNAPSHOT"),
  artifact("IMPLEMENTATION_PLAN"),
  artifact("ARCHITECTURE_REVIEW"),
  artifact("CODE_DIFF"),
  artifact("TEST_REPORT"),
  artifact("SECURITY_REPORT"),
  artifact("REVIEW_REPORT"),
  artifact("CI_REPORT", { expectedSha: commit, ci: { success: true, headSha: commit } }),
];

describe("task readiness", () => {
  it("names the missing artifact AND what produces it", () => {
    // Exactly the CORE-BE-11 situation: everything ran, but the task entered ANALYZING through a
    // manual transition so no requirements snapshot was ever written.
    const commit = "2126121b4fd8f65248ac8e7806fe6153a9ca396d";
    const artifacts = everyGateArtifact(commit).filter((a) => a.kind !== "REQUIREMENTS_SNAPSHOT");
    const readiness = taskReadiness({ task: task("REVIEWING"), artifacts, runs: [run(commit)], requiresExternalCi: true });

    expect(readiness.gateArtifacts.missing).toEqual(["REQUIREMENTS_SNAPSHOT"]);
    expect(readiness.gateArtifactsComplete).toBe(false);
    const blocker = readiness.blockers[0]!;
    expect(blocker.code).toBe("MISSING_REQUIREMENTS_SNAPSHOT");
    // The remediation has to name the call, not just the gap -- that is the whole point.
    expect(blocker.remediation).toContain("superadmin_task_analyze");
    expect(blocker.remediation).toContain("task_transition");
  });

  it("reports a clean task as complete and points at the merge tools", () => {
    const commit = "0091c74048c83a63d0306b0d23f86a4872a320d7";
    const readiness = taskReadiness({ task: task("READY"), artifacts: everyGateArtifact(commit), runs: [run(commit)], requiresExternalCi: true });
    expect(readiness.blockers).toEqual([]);
    expect(readiness.gateArtifactsComplete).toBe(true);
    expect(readiness.nextAction?.tool).toBe("superadmin_sandbox_pull_request_open");
  });

  it("answers for a brand new task instead of erroring on the absent plan", () => {
    const readiness = taskReadiness({ task: task("INGESTED"), artifacts: [], runs: [], requiresExternalCi: true });
    expect(readiness.nextAction?.tool).toBe("superadmin_task_analyze");
    // No plan yet, so plan-conditional artifacts are not demanded.
    expect(readiness.gateArtifacts.required).not.toContain("API_CONTRACT");
    expect(readiness.gateArtifacts.required).not.toContain("MIGRATION_MANIFEST");
  });

  it("demands contract and migration evidence only when the plan calls for them", () => {
    expect(requiredGateArtifacts({ apiChanges: [], databaseChanges: [] }, false)).not.toContain("API_CONTRACT");
    const both = requiredGateArtifacts({ apiChanges: ["REST"], databaseChanges: ["migration"] }, true);
    expect(both).toEqual(expect.arrayContaining(["API_CONTRACT", "MIGRATION_MANIFEST", "CI_REPORT"]));
  });

  it("treats a green CI report for an older commit as not satisfying the gate", () => {
    const stale = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const current = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const artifacts = [
      ...everyGateArtifact(stale).filter((a) => a.kind !== "CI_REPORT"),
      artifact("CI_REPORT", { expectedSha: stale, ci: { success: true, headSha: stale } }),
    ];
    expect(hasExactCiReport(artifacts, current)).toBe(false);
    const readiness = taskReadiness({ task: task("REVIEWING"), artifacts, runs: [run(current)], requiresExternalCi: true });
    expect(readiness.blockers.map((b) => b.code)).toContain("CI_REPORT_EXACT_LATEST_COMMIT");
    expect(readiness.blockers.find((b) => b.code === "CI_REPORT_EXACT_LATEST_COMMIT")!.remediation).toMatch(/earlier attempt/i);
  });

  it("stays silent about a next action while an execution is in flight", () => {
    const readiness = taskReadiness({ task: task("IMPLEMENTING"), artifacts: [], runs: [], requiresExternalCi: true, executionInFlight: true });
    expect(readiness.nextAction).toBeNull();
  });
});
