import { describe, expect, it } from "vitest";
import {
  deliveryForProject,
  deliveryForTask,
  deriveSourceRef,
} from "../../packages/operator-console/src/delivery.js";
import type { Artifact, Run, Task } from "../../packages/schemas/src/index.js";

const projectId = "22222222-2222-2222-2222-222222222222";
const taskId = "11111111-1111-1111-1111-111111111111";

const task = (over: Partial<Task> = {}): Task =>
  ({
    id: taskId,
    projectId,
    externalKey: "CORE-BE-07",
    title: "Momna CORE-BE-07 / MOMNA-843 — Canonical Field Registry",
    description: "Implement Qira MOMNA-843 on the current merged main.",
    requirements: ["r"],
    relationships: [],
    state: "READY",
    repairAttempts: 1,
    createdAt: "2026-08-26T06:45:14.453Z",
    updatedAt: "2026-08-27T10:12:55.000Z",
    ...over,
  }) as unknown as Task;

const run = (over: Partial<Run> = {}): Run =>
  ({
    id: "run-1",
    projectId,
    taskId,
    operationId: "op-1",
    status: "SUCCEEDED",
    branch: "autopilot/CORE-BE-07",
    commitSha: "b3fdc8ba1ae61efeea28956b7ca38201685378f6",
    startedAt: "2026-08-27T10:10:47.361Z",
    finishedAt: "2026-08-27T10:12:55.864Z",
    ...over,
  }) as unknown as Run;

const artifact = (kind: Artifact["kind"], content: unknown, over: Partial<Artifact> = {}): Artifact =>
  ({
    id: `${kind}-${Math.random()}`,
    projectId,
    taskId,
    kind,
    schemaVersion: "5",
    content,
    contentHash: "h",
    status: "AVAILABLE",
    createdAt: "2026-08-27T10:12:00.000Z",
    ...over,
  }) as unknown as Artifact;

describe("delivery projection", () => {
  it("derives the upstream tracker key without echoing the task's own key", () => {
    expect(deriveSourceRef(task())).toBe("MOMNA-843");
    // No upstream reference at all is a legitimate answer, not a crash.
    expect(
      deriveSourceRef(task({ title: "Local cleanup", description: "no tracker key here" })),
    ).toBeUndefined();
    // A key that merely extends the task's own key is the same work item.
    expect(
      deriveSourceRef(
        task({ externalKey: "CORE-BE-07", title: "CORE-BE-07-EVIDENCE follow-up", description: "" }),
      ),
    ).toBeUndefined();
  });

  it("reports every gate and the merge from durable per-task evidence", () => {
    const record = deliveryForTask({
      task: task(),
      runs: [run({ id: "r0", status: "FAILED", commitSha: "09de1e0" }), run()],
      artifacts: [
        artifact("TEST_REPORT", {
          passed: true,
          finishedAt: "2026-08-27T10:12:30.000Z",
          suites: [
            { type: "UNIT", passed: true, exitCode: 0 },
            { type: "REGRESSION", passed: true, exitCode: 0 },
          ],
        }),
        artifact("CI_REPORT", {
          detectedStack: "KOTLIN_GRADLE",
          toolchain: { gradle: "8.10.2" },
          ci: { success: true, conclusion: "success", url: "https://ci", headSha: "b3fdc8b" },
        }),
        artifact("REVIEW_REPORT", {
          result: "PASS",
          failures: [],
          warnings: [],
          reviewedAt: "2026-08-27T10:12:55.789Z",
        }),
        artifact("FINAL_CHANGE_MANIFEST", { verifiedCommitSha: "b3fdc8ba1ae6" }),
        artifact("PULL_REQUEST_REPORT", { pullRequest: { number: 31, url: "https://pr/31" } }),
        artifact("PULL_REQUEST_REPORT", {
          merged: true,
          defaultBranch: "main",
          verifiedCommitSha: "b3fdc8ba1ae6",
          pullRequest: { number: 31, url: "https://pr/31" },
        }),
      ],
    });

    expect(record.sourceRef).toBe("MOMNA-843");
    expect(record.tests.status).toBe("PASS");
    expect(record.tests.suites.map((s) => s.type)).toEqual(["UNIT", "REGRESSION"]);
    expect(record.ci).toMatchObject({ status: "PASS", conclusion: "success", stack: "KOTLIN_GRADLE" });
    expect(record.review.status).toBe("PASS");
    expect(record.merged).toBe(true);
    expect(record.mergedIntoBranch).toBe("main");
    expect(record.pullRequest).toEqual({ number: 31, url: "https://pr/31" });
    expect(record.attempts).toBe(2);
    expect(record.failedAttempts).toBe(1);
  });

  it("distinguishes a failed gate from a gate that never ran", () => {
    const never = deliveryForTask({ task: task({ state: "PLANNED" }), runs: [], artifacts: [] });
    expect(never.tests.status).toBe("PENDING");
    expect(never.ci.status).toBe("PENDING");
    expect(never.review.status).toBe("PENDING");
    expect(never.merged).toBe(false);

    const failed = deliveryForTask({
      task: task({ state: "IMPLEMENTING" }),
      runs: [run({ status: "FAILED" })],
      artifacts: [
        artifact("TEST_REPORT", { passed: false, suites: [{ type: "UNIT", passed: false, exitCode: 1 }] }),
        artifact("REVIEW_REPORT", { result: "FAIL", failures: ["apiCompatibility"], warnings: [] }),
      ],
    });
    expect(failed.tests.status).toBe("FAIL");
    expect(failed.review.status).toBe("FAIL");
    expect(failed.review.failures).toEqual(["apiCompatibility"]);
    expect(failed.merged).toBe(false);
  });

  it("never attributes another task's artifacts or runs to this task", () => {
    const other = "99999999-9999-9999-9999-999999999999";
    const record = deliveryForTask({
      task: task(),
      runs: [run({ id: "other", taskId: other, commitSha: "dead" })],
      artifacts: [
        artifact("TEST_REPORT", { passed: true, suites: [{ type: "UNIT", passed: true }] }, { taskId: other }),
      ],
    });
    expect(record.attempts).toBe(0);
    expect(record.tests.status).toBe("PENDING");
    expect(record.commitSha).toBeUndefined();
  });

  it("ignores a tombstoned pull-request report and keeps un-executed tasks in the project view", () => {
    const view = deliveryForProject({
      tasks: [task({ externalKey: "CORE-BE-02" }), task({ id: "t2", externalKey: "CORE-BE-10", state: "INGESTED" })],
      runs: [run()],
      artifacts: [
        artifact("PULL_REQUEST_REPORT", { merged: true, defaultBranch: "main" }, { status: "DELETED" }),
      ],
    });
    expect(view.records).toHaveLength(2);
    // Numeric-aware ordering keeps CORE-BE-2 before CORE-BE-10.
    expect(view.records.map((r) => r.externalKey)).toEqual(["CORE-BE-02", "CORE-BE-10"]);
    expect(view.records[0]?.merged).toBe(false);
    expect(view.summary.total).toBe(2);
    expect(view.summary.merged).toBe(0);
  });
});
