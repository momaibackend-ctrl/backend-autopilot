import { describe, expect, it, vi } from "vitest";
import { AsyncExecutionCoordinator } from "../../packages/core/src/async-execution.js";
import { createService } from "../../packages/core/src/runtime.js";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";
import type { ExecutionJob } from "../../packages/schemas/src/index.js";
import { SuperadminService } from "../../packages/superadmin/src/index.js";
import { FakeRepositoryProvider } from "../helpers/repository-provider.js";

const principal = { actor: "superadmin-test", role: "SUPERADMIN" as const };
const workingHead = "1".repeat(40);
const sandboxHead = "2".repeat(40);
const portHead = "3".repeat(40);
const portNext = "4".repeat(40);
let counter = 0;
const operationId = () => `missions-${++counter}-${Date.now()}`;

// One product, three repositories: the working implementation, its sandbox, and a port to another
// stack that must match the working one before it replaces it.
async function product() {
  const store = new MemoryStateStore();
  const service = createService({ store });
  const system = await service.projectCreate({ name: "System", slug: "system", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const project = await service.projectCreate({ name: "Product", slug: "product", sourceType: "MCP", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const repositories = new FakeRepositoryProvider({
    "acme/backend": { head: workingHead, commits: [workingHead], permissions: { admin: true, push: true } },
    "acme/backend-sandbox": { head: sandboxHead, commits: [sandboxHead], permissions: { admin: true, push: true } },
    "acme/backend-java": { head: portHead, commits: [portHead, portNext], visibility: "public", permissions: { admin: true, push: true } },
  });
  const dispatched: ExecutionJob[] = [];
  const asyncExecution = new AsyncExecutionCoordinator(store, { dispatch: vi.fn(async () => ({})) });
  const admin = new SuperadminService({ store, service, systemProjectId: system.id, repositories, asyncExecution, httpE2eDispatcher: { dispatch: async (job) => (dispatched.push(job), {}) } });
  const register = async (repository: string) => ((await admin.repositoryRegister(principal, project.id, { repository }, operationId())) as { value: { resourceId: string } }).value.resourceId;
  const working = await register("acme/backend");
  const sandbox = await register("acme/backend-sandbox");
  const port = await register("acme/backend-java");
  return { store, service, admin, project, repositories, working, sandbox, port, dispatched };
}

/** Completes the newest HTTP_E2E job the way the record workflow does: job status plus its report. */
async function finishComparison(store: MemoryStateStore, projectId: string, result: { verdict: "PROVEN" | "NOT_PROVEN"; failure?: { class: string; message: string }; diagnosis?: unknown; covered: number; total: number }) {
  const [job] = (await store.listExecutionJobs(projectId)).filter((value) => value.kind === "HTTP_E2E").sort((left, right) => right.queuedAt.localeCompare(left.queuedAt));
  const now = new Date().toISOString();
  await store.updateExecutionJob({ ...job!, status: "SUCCEEDED", finishedAt: now, updatedAt: now, result: { verdict: result.verdict } });
  await store.saveArtifact({
    id: crypto.randomUUID(),
    projectId,
    taskId: job!.taskId,
    kind: "VALIDATION_REPORT",
    schemaVersion: "1",
    content: { suite: "HTTP_E2E", jobId: job!.id, commitSha: job!.baseCommitSha, verdict: result.verdict, ...(result.failure ? { failure: result.failure } : {}), ...(result.diagnosis ? { diagnosis: result.diagnosis } : {}), evidence: { collection: { coverage: { coveredOperations: result.covered, totalOperations: result.total } } } },
    contentHash: "hash",
    status: "AVAILABLE",
    createdAt: now,
  } as never);
  return job!;
}

describe("missions and the project brief", () => {
  it("tells a session that knows nothing which repository is what and what to do first", async () => {
    const { admin, project, port } = await product();
    const brief = await admin.projectBrief(principal, project.id);
    expect(brief.repositories.map((value) => value.repository)).toEqual(["acme/backend", "acme/backend-sandbox", "acme/backend-java"]);
    expect(brief.nextAction).toMatchObject({ tool: "superadmin_repository_role_set", arguments: { projectId: project.id } });
    expect(brief.setup.map((value) => value.tool)).toEqual(["superadmin_repository_role_set", "superadmin_repository_role_set", "superadmin_repository_role_set", "superadmin_mission_create"]);
    expect(brief.rules.join(" ")).toMatch(/Do not rediscover the project from deployments, staging URLs or databases/);
    expect(port).toBeDefined();
  });

  it("drives a port to proven parity: every step derived from evidence, every failure with its cause and the next call", async () => {
    const { store, service, admin, project, repositories, working, sandbox, port } = await product();
    await admin.repositoryRoleSet(principal, { projectId: project.id, resourceId: working, role: "WORKING", purpose: "Deployed Kotlin service; the reference until the port matches it", operationId: operationId() });
    await admin.repositoryRoleSet(principal, { projectId: project.id, resourceId: sandbox, role: "SANDBOX", operationId: operationId() });
    await admin.repositoryRoleSet(principal, { projectId: project.id, resourceId: port, role: "CANDIDATE", operationId: operationId() });
    const task = await service.taskCreate({ projectId: project.id, externalKey: "PORT-PARITY", title: "Java port matches the working service", description: "d", requirements: ["full end-to-end parity"], relationships: [] });
    const mission = ((await admin.missionCreate(principal, { projectId: project.id, key: "JAVA-PARITY", title: "Java replaces Kotlin", goal: { kind: "PARITY", targetResourceId: port, referenceResourceId: working }, taskIds: [task.id], operationId: operationId() })) as { value: { id: string } }).value;

    let brief = await admin.projectBrief(principal, project.id);
    expect(brief.setup).toEqual([]);
    expect(brief.repositories.find((value) => value.resourceId === working)).toMatchObject({ role: "WORKING", missions: [{ missionKey: "JAVA-PARITY", as: "REFERENCE" }] });
    expect(brief.repositories.find((value) => value.resourceId === port)?.missions).toEqual([{ missionKey: "JAVA-PARITY", as: "TARGET" }]);
    let progress = brief.missions[0]!.progress!;
    expect(progress.steps.map((step) => [step.id, step.status])).toEqual([["REPOSITORIES", "DONE"], ["TASKS", "REMAINING"], ["PARITY", "REMAINING"]]);
    const parityRun = progress.steps.find((step) => step.id === "PARITY")!.next!;
    expect(parityRun).toMatchObject({ tool: "superadmin_http_e2e_run", arguments: { taskId: task.id, repositoryResourceId: port, counterpart: { repositoryResourceId: working } } });

    // The next call is runnable as given.
    await admin.httpE2eRun(principal, project.id, { ...(parityRun.arguments as Record<string, unknown>), operationId: operationId() } as never);
    progress = (await admin.projectBrief(principal, project.id)).missions[0]!.progress!;
    expect(progress.steps.find((step) => step.id === "PARITY")?.status).toBe("RUNNING");

    // A failed comparison names its cause, the diagnosis and the call that reads the rest.
    const failed = await finishComparison(store, project.id, { verdict: "NOT_PROVEN", failure: { class: "COVERAGE_INCOMPLETE", message: "6 of 45 operations exercised" }, diagnosis: { area: "SCENARIOS", summary: "39 operations have no scenario", nextSteps: ["Draft scenarios with superadmin_api_coverage."] }, covered: 6, total: 45 });
    brief = await admin.projectBrief(principal, project.id);
    progress = brief.missions[0]!.progress!;
    const parity = progress.steps.find((step) => step.id === "PARITY")!;
    expect(parity.status).toBe("FAILING");
    expect(parity.detail).toContain("COVERAGE_INCOMPLETE: 6 of 45 operations exercised");
    expect(parity.detail).toContain("Coverage 6/45");
    expect(parity.detail).toContain("39 operations have no scenario");
    expect(progress.nextAction).toMatchObject({ tool: "superadmin_http_e2e_get", arguments: { jobId: failed.id } });
    expect(brief.nextAction).toEqual(progress.nextAction);

    // ACHIEVED is refused while the evidence says otherwise, and the refusal says what remains.
    await expect(admin.missionUpdate(principal, { projectId: project.id, missionId: mission.id, status: "ACHIEVED", operationId: operationId() })).rejects.toMatchObject({ code: "INVALID_STATE" });
    // So is archiving the reference while the port still has to match it.
    await expect(admin.repositoryRoleSet(principal, { projectId: project.id, resourceId: working, role: "ARCHIVE", operationId: operationId() })).rejects.toMatchObject({ code: "INVALID_STATE", details: { missions: ["JAVA-PARITY"] } });

    // Proven, and the task is READY: the mission is complete -- until the port moves past the proof.
    await admin.httpE2eRun(principal, project.id, { ...(parityRun.arguments as Record<string, unknown>), operationId: operationId() } as never);
    await finishComparison(store, project.id, { verdict: "PROVEN", covered: 45, total: 45 });
    await store.updateTask({ ...(await store.getTask(project.id, task.id))!, state: "READY" });
    repositories.set("acme/backend-java", { head: portNext, commits: [portHead, portNext] });
    progress = (await admin.projectBrief(principal, project.id)).missions[0]!.progress!;
    expect(progress.steps.find((step) => step.id === "PARITY")).toMatchObject({ status: "REMAINING", next: { tool: "superadmin_http_e2e_run" } });
    expect(progress.complete).toBe(false);

    repositories.set("acme/backend-java", { head: portHead, commits: [portHead, portNext] });
    progress = (await admin.projectBrief(principal, project.id)).missions[0]!.progress!;
    expect(progress.complete).toBe(true);
    expect(progress.nextAction).toMatchObject({ tool: "superadmin_mission_update", arguments: { status: "ACHIEVED" } });
    const achieved = (await admin.missionUpdate(principal, { projectId: project.id, missionId: mission.id, status: "ACHIEVED", reason: "Parity proven at the head", operationId: operationId() })) as { value: { status: string; achievedAt?: string } };
    expect(achieved.value).toMatchObject({ status: "ACHIEVED", achievedAt: expect.any(String) });

    // The reference can now be kept as an archive.
    await admin.repositoryRoleSet(principal, { projectId: project.id, resourceId: working, role: "ARCHIVE", operationId: operationId() });
    brief = await admin.projectBrief(principal, project.id);
    expect(brief.repositories.find((value) => value.resourceId === working)).toMatchObject({ role: "ARCHIVE", purpose: "Deployed Kotlin service; the reference until the port matches it", missions: [] });
    expect(brief.missions[0]?.status).toBe("ACHIEVED");
    expect(brief.missions[0]?.progress).toBeUndefined();
  });

  it("validates what a mission names and audits every refusal", async () => {
    const { store, service, admin, project, working, port } = await product();
    await expect(admin.missionCreate(principal, { projectId: project.id, key: "SELF", title: "t", goal: { kind: "PARITY", targetResourceId: port, referenceResourceId: port }, operationId: operationId() })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await expect(admin.missionCreate(principal, { projectId: project.id, key: "GHOST", title: "t", goal: { kind: "DELIVERY", targetResourceId: crypto.randomUUID() }, operationId: operationId() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(admin.missionCreate(principal, { projectId: project.id, key: "NO-TASK", title: "t", goal: { kind: "DELIVERY", targetResourceId: port }, taskIds: [crypto.randomUUID()], operationId: operationId() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await store.listAudit(project.id)).filter((event) => event.action === "mcp.mission_create.refused")).toHaveLength(3);

    await admin.missionCreate(principal, { projectId: project.id, key: "ONE", title: "t", goal: { kind: "DELIVERY", targetResourceId: port }, operationId: operationId() });
    await expect(admin.missionCreate(principal, { projectId: project.id, key: "ONE", title: "again", goal: { kind: "DELIVERY", targetResourceId: working }, operationId: operationId() })).rejects.toMatchObject({ code: "CONFLICT" });

    // A DELIVERY mission with no task asks for one; a deleted task is reported, not ignored.
    let progress = (await admin.projectBrief(principal, project.id)).missions[0]!.progress!;
    expect(progress.nextAction).toMatchObject({ tool: "superadmin_task_create" });
    const task = await service.taskCreate({ projectId: project.id, externalKey: "D-1", title: "t", description: "d", requirements: ["r"], relationships: [] });
    const mission = (await store.listMissions(project.id))[0]!;
    await admin.missionUpdate(principal, { projectId: project.id, missionId: mission.id, addTaskIds: [task.id], operationId: operationId() });
    await store.updateTask({ ...(await store.getTask(project.id, task.id))!, deletedAt: new Date().toISOString() });
    progress = (await admin.projectBrief(principal, project.id)).missions[0]!.progress!;
    expect(progress.steps.find((step) => step.id === "TASKS")).toMatchObject({ status: "FAILING", next: { tool: "superadmin_mission_update", arguments: { removeTaskIds: [task.id] } } });
  });

  it("replays a mission mutation by operationId instead of creating it twice", async () => {
    const { admin, project, port } = await product();
    const id = operationId();
    const input = { projectId: project.id, key: "ONCE", title: "t", goal: { kind: "DELIVERY" as const, targetResourceId: port }, operationId: id };
    const first = (await admin.missionCreate(principal, input)) as { value: { id: string }; idempotentReplay: boolean };
    const second = (await admin.missionCreate(principal, input)) as { value: { id: string }; idempotentReplay: boolean };
    expect(second).toMatchObject({ idempotentReplay: true, value: { id: first.value.id } });
  });
});
