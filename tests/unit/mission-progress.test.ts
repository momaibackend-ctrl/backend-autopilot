import { describe, expect, it } from "vitest";
import { missionProgress, type MissionEvidence, type MissionTaskView } from "../../packages/core/src/mission.js";
import type { Mission, Resource } from "../../packages/schemas/src/index.js";

const projectId = "00000000-0000-4000-8000-000000000001";
const targetId = "00000000-0000-4000-8000-000000000002";
const referenceId = "00000000-0000-4000-8000-000000000003";
const at = "2026-10-22T00:00:00.000Z";
const sha = "a".repeat(40);

function repository(resourceId: string, name: string, overrides: Partial<Resource> = {}): Resource {
  return { resourceId, type: "GITHUB_REPOSITORY", provider: "github", externalReference: name, projectId, environment: "SANDBOX", permissions: ["READ", "WRITE", "ADMIN"], status: "ACTIVE", secretRefs: [], createdAt: at, ...overrides };
}
function mission(goal: Mission["goal"], taskIds: string[] = []): Mission {
  return { id: "00000000-0000-4000-8000-000000000009", projectId, key: "M", title: "m", goal, taskIds, status: "ACTIVE", createdAt: at, updatedAt: at };
}
function task(id: string, state: MissionTaskView["task"]["state"], nextAction: MissionTaskView["nextAction"] = { tool: "superadmin_task_execute", why: "implement" }): MissionTaskView {
  return { task: { id, externalKey: `T-${id.slice(-1)}`, title: "t", state }, nextAction };
}
const parity = mission({ kind: "PARITY", targetResourceId: targetId, referenceResourceId: referenceId }, ["00000000-0000-4000-8000-00000000000a"]);
const both = { target: repository(targetId, "acme/java"), reference: repository(referenceId, "acme/kotlin") };

describe("mission progress", () => {
  it("a DELIVERY mission is complete only when every attached task is READY", () => {
    const delivery = mission({ kind: "DELIVERY", targetResourceId: targetId }, ["1", "2"]);
    const open = missionProgress(delivery, { target: both.target, tasks: [task("t1", "READY"), task("t2", "PLANNED")], missingTaskIds: [] });
    expect(open.complete).toBe(false);
    expect(open.nextAction).toMatchObject({ tool: "superadmin_task_execute", arguments: { taskId: "t2" } });
    const done = missionProgress(delivery, { target: both.target, tasks: [task("t1", "READY"), task("t2", "READY")], missingTaskIds: [] });
    expect(done.complete).toBe(true);
    expect(done.nextAction).toMatchObject({ tool: "superadmin_mission_update", arguments: { status: "ACHIEVED" } });
  });

  it("a known failure outranks a task that is only waiting for its job", () => {
    const progress = missionProgress(parity, {
      ...both,
      tasks: [task("t1", "IMPLEMENTING", null)],
      missingTaskIds: [],
      parity: { jobId: "j1", status: "SUCCEEDED", commitSha: sha, verdict: "NOT_PROVEN", failureClass: "PARITY_MISMATCH", failureMessage: "3 responses differ" },
    });
    expect(progress.steps.map((step) => step.status)).toEqual(["DONE", "RUNNING", "FAILING"]);
    expect(progress.nextAction).toMatchObject({ tool: "superadmin_http_e2e_get", arguments: { jobId: "j1" } });
  });

  it("a job that ended without evidence is a failure with its own reason, never a pass", () => {
    const progress = missionProgress(parity, { ...both, tasks: [task("t1", "READY")], missingTaskIds: [], parity: { jobId: "j1", status: "FAILED", commitSha: sha, failureClass: "INFRASTRUCTURE_UNAVAILABLE", failureMessage: "no evidence file" } });
    expect(progress.complete).toBe(false);
    expect(progress.steps.at(-1)).toMatchObject({ status: "FAILING", detail: expect.stringContaining("INFRASTRUCTURE_UNAVAILABLE: no evidence file") });
  });

  it("names the repository problem first, with the call that fixes it", () => {
    const disabled = missionProgress(parity, { target: both.target, reference: repository(referenceId, "acme/kotlin", { status: "DISABLED" }), tasks: [], missingTaskIds: [] });
    expect(disabled.nextAction).toMatchObject({ tool: "superadmin_resource_update", arguments: { resourceId: referenceId, status: "ACTIVE" } });
    const readOnly = missionProgress(parity, { target: repository(targetId, "acme/java", { permissions: ["READ"] }), reference: both.reference, tasks: [], missingTaskIds: [] });
    expect(readOnly.nextAction).toMatchObject({ tool: "superadmin_repository_register", arguments: { repository: "acme/java", access: "FULL" } });
  });

  it("a proof at an older commit than the target head does not count", () => {
    const evidence: MissionEvidence = { ...both, tasks: [task("t1", "READY")], missingTaskIds: [], parity: { jobId: "j1", status: "SUCCEEDED", commitSha: sha, verdict: "PROVEN" } };
    expect(missionProgress(parity, evidence).complete).toBe(true);
    expect(missionProgress(parity, { ...evidence, targetHead: "b".repeat(40) })).toMatchObject({ complete: false, nextAction: { tool: "superadmin_http_e2e_run" } });
  });
});

describe("a parity mission measures first", () => {
  it("runs the comparison before remaining task work, but not while the task has a job in flight or no task exists", () => {
    const fresh = missionProgress(parity, { ...both, tasks: [task("00000000-0000-4000-8000-00000000000a", "INGESTED", { tool: "superadmin_task_analyze", why: "snapshot" })], missingTaskIds: [] });
    expect(fresh.nextAction).toMatchObject({ tool: "superadmin_http_e2e_run", arguments: { taskId: "00000000-0000-4000-8000-00000000000a" } });
    const busy = missionProgress(parity, { ...both, tasks: [task("00000000-0000-4000-8000-00000000000a", "IMPLEMENTING", null)], missingTaskIds: [] });
    expect(busy.nextAction).toMatchObject({ tool: "superadmin_task_readiness" });
    expect(busy.steps.map((step) => step.status)).toEqual(["DONE", "RUNNING", "REMAINING"]);
    const noTask = missionProgress(parity, { ...both, tasks: [], missingTaskIds: [] });
    expect(noTask.nextAction).toMatchObject({ tool: "superadmin_task_create" });
  });
});

describe("a reference that fails by itself", () => {
  it("is not the target's to fix: the step names the reference fix, the sandbox it goes through, and the pin to move", () => {
    const pinned = mission({ kind: "PARITY", targetResourceId: targetId, referenceResourceId: referenceId, referenceRef: "2e7d3b8" }, ["00000000-0000-4000-8000-00000000000a"]);
    const progress = missionProgress(pinned, {
      ...both,
      referenceFix: { projectId, resourceId: "s", repository: "acme/kotlin-sandbox", via: "SANDBOX" },
      tasks: [task("00000000-0000-4000-8000-00000000000a", "READY")],
      missingTaskIds: [],
      parity: { jobId: "j9", status: "SUCCEEDED", commitSha: sha, verdict: "NOT_PROVEN", failureClass: "REFERENCE_NOT_PROVEN", failureMessage: "SCENARIO_FAILED: 2 of 6 scenario(s) did not pass", diagnosis: { area: "REFERENCE" } },
    });
    const step = progress.steps.find((value) => value.id === "PARITY")!;
    expect(step).toMatchObject({ status: "FAILING", detail: expect.stringContaining("Nothing in the target can change this") });
    expect(progress.nextAction).toMatchObject({ tool: "superadmin_task_create", arguments: { projectId } });
    expect(progress.nextAction?.why).toContain("in acme/kotlin-sandbox (the product's SANDBOX), then release it to acme/kotlin");
    expect(progress.nextAction?.why).toContain("move referenceRef to the fixed commit");
  });
});

describe("a failing reference with its fix already attached", () => {
  it("continues the attached open task instead of asking for a new one", () => {
    const evidence = {
      ...both,
      referenceFix: { projectId, resourceId: "s", repository: "acme/kotlin-sandbox", via: "SANDBOX" as const },
      missingTaskIds: [],
      parity: { jobId: "j9", status: "SUCCEEDED", commitSha: sha, verdict: "NOT_PROVEN" as const, failureClass: "REFERENCE_NOT_PROVEN", failureMessage: "SCENARIO_FAILED", diagnosis: { area: "REFERENCE" } },
    };
    const withFix = missionProgress(parity, { ...evidence, tasks: [task("00000000-0000-4000-8000-00000000000a", "READY"), task("00000000-0000-4000-8000-00000000000b", "INGESTED", { tool: "superadmin_task_analyze", why: "snapshot" })] });
    expect(withFix.nextAction).toMatchObject({ tool: "superadmin_task_analyze", arguments: { taskId: "00000000-0000-4000-8000-00000000000b" }, why: expect.stringContaining("The reference must pass before the comparison can") });
    const allReady = missionProgress(parity, { ...evidence, tasks: [task("00000000-0000-4000-8000-00000000000a", "READY")] });
    expect(allReady.nextAction).toMatchObject({ tool: "superadmin_task_create" });
  });
});
