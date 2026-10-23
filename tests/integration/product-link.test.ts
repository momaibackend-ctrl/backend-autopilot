import { describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../../packages/artifact-store/src/index.js";
import { AsyncExecutionCoordinator } from "../../packages/core/src/async-execution.js";
import { systemClock, uuidGenerator } from "../../packages/core/src/ports.js";
import { createService } from "../../packages/core/src/runtime.js";
import { prepareHttpE2eJob } from "../../packages/ephemeral-environment/src/http-e2e-job.js";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";
import { SuperadminService } from "../../packages/superadmin/src/index.js";
import { FakeRepositoryProvider } from "../helpers/repository-provider.js";

const principal = { actor: "superadmin-test", role: "SUPERADMIN" as const };
const kotlinHead = "1".repeat(40);
const kotlinFinal = "5".repeat(40);
const javaHead = "3".repeat(40);
let counter = 0;
const operationId = () => `product-${++counter}-${Date.now()}`;
const id = <T>(result: unknown) => (result as { value: T }).value;

// Two projects of one product, each with its own history: the working implementation lives in one,
// the candidate that will replace it in the other. Neither project's records may move.
async function twoProjects() {
  const store = new MemoryStateStore();
  const service = createService({ store });
  const system = await service.projectCreate({ name: "System", slug: "system", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const working = await service.projectCreate({ name: "Product (working org)", slug: "product-working", sourceType: "MCP", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const development = await service.projectCreate({ name: "Product development", slug: "product-development", sourceType: "MCP", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const repositories = new FakeRepositoryProvider({
    "org/backend": { head: kotlinHead, commits: [kotlinHead, kotlinFinal], tags: [{ name: "kotlin-final", sha: kotlinFinal }], permissions: { admin: true, push: true } },
    "dev/backend-java": { head: javaHead, commits: [javaHead], visibility: "public", permissions: { admin: true, push: true } },
  });
  const asyncExecution = new AsyncExecutionCoordinator(store, { dispatch: vi.fn(async () => ({})) });
  const admin = new SuperadminService({ store, service, systemProjectId: system.id, repositories, asyncExecution, httpE2eDispatcher: { dispatch: async () => ({}) } });
  const kotlin = id<{ resourceId: string }>(await admin.repositoryRegister(principal, working.id, { repository: "org/backend" }, operationId())).resourceId;
  const java = id<{ resourceId: string }>(await admin.repositoryRegister(principal, development.id, { repository: "dev/backend-java" }, operationId())).resourceId;
  const task = await service.taskCreate({ projectId: development.id, externalKey: "JAVA-PARITY", title: "Java matches Kotlin", description: "d", requirements: ["full end-to-end parity"], relationships: [] });
  const parity = (referenceRef?: string) => ({ kind: "PARITY" as const, targetResourceId: java, referenceResourceId: kotlin, ...(referenceRef ? { referenceRef } : {}) });
  return { store, service, admin, working, development, kotlin, java, task, parity, asyncExecution };
}

describe("projects linked into one product", () => {
  it("refuses a reference from an unlinked project, and says how to link it", async () => {
    const { admin, development, task, parity, kotlin, java } = await twoProjects();
    await expect(admin.missionCreate(principal, { projectId: development.id, key: "JAVA", title: "t", goal: parity(), taskIds: [task.id], operationId: operationId() })).rejects.toMatchObject({ code: "NOT_FOUND", details: { remediation: expect.stringContaining("superadmin_project_product_set") } });
    await expect(admin.httpE2eRun(principal, development.id, { taskId: task.id, repositoryResourceId: java, scenarioSource: { kind: "REPOSITORY" }, counterpart: { repositoryResourceId: kotlin }, operationId: operationId() })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("compares against the linked project's repository without moving a single record", async () => {
    const { store, admin, working, development, task, parity, kotlin, java } = await twoProjects();
    const before = await store.getResource(kotlin);
    await admin.projectProductSet(principal, { projectId: working.id, product: "acme", operationId: operationId() });
    const linked = id<{ projects: Array<{ projectId: string }> }>(await admin.projectProductSet(principal, { projectId: development.id, product: "acme", operationId: operationId() }));
    expect(linked.projects).toEqual([{ projectId: working.id, name: "Product (working org)" }]);
    await admin.repositoryRoleSet(principal, { projectId: working.id, resourceId: kotlin, role: "WORKING", operationId: operationId() });
    await admin.repositoryRoleSet(principal, { projectId: development.id, resourceId: java, role: "CANDIDATE", operationId: operationId() });
    await admin.missionCreate(principal, { projectId: development.id, key: "JAVA", title: "Java replaces Kotlin", goal: parity(), taskIds: [task.id], operationId: operationId() });
    expect(await store.getResource(kotlin)).toEqual({ ...before, role: "WORKING" });

    const brief = await admin.projectBrief(principal, development.id);
    expect(brief.project.product).toBe("acme");
    expect(brief.productRepositories).toEqual([{ projectId: working.id, projectName: "Product (working org)", resourceId: kotlin, repository: "org/backend", role: "WORKING", status: "ACTIVE", missions: [{ missionKey: "JAVA", as: "REFERENCE" }] }]);
    expect(brief.missions[0]).toMatchObject({ goal: { target: "dev/backend-java", reference: "org/backend" } });
    const progress = brief.missions[0]!.progress!;
    expect(progress.steps[0]).toMatchObject({ id: "REPOSITORIES", status: "DONE" });

    // The brief's call runs as given, and the workflow is handed the linked repository.
    const run = progress.steps.find((step) => step.id === "PARITY")!.next!;
    const job = id<{ id: string; payload: { counterpart: { commitSha: string } } }>(await admin.httpE2eRun(principal, development.id, { ...(run.arguments as Record<string, unknown>), operationId: operationId() } as never));
    expect(job.payload.counterpart.commitSha).toBe(kotlinHead);
    const prepared = await prepareHttpE2eJob({ store, clock: systemClock, ids: uuidGenerator, artifacts: new ArtifactStore(store, uuidGenerator, systemClock) }, { jobId: job.id, owner: "github-actions:1:1" });
    expect(prepared.counterpart).toMatchObject({ repository: "org/backend", commitSha: kotlinHead });

    // The working repository cannot be archived from its own project while the candidate still
    // has to match it.
    await expect(admin.repositoryRoleSet(principal, { projectId: working.id, resourceId: kotlin, role: "ARCHIVE", operationId: operationId() })).rejects.toMatchObject({ code: "INVALID_STATE", details: { missions: ["JAVA"] } });
  });

  it("never lets a link carry a write: the linked repository is not a target and accepts no change set", async () => {
    const { admin, store, working, development, kotlin, java, asyncExecution, service } = await twoProjects();
    await admin.projectProductSet(principal, { projectId: working.id, product: "acme", operationId: operationId() });
    await admin.projectProductSet(principal, { projectId: development.id, product: "acme", operationId: operationId() });
    await expect(admin.missionCreate(principal, { projectId: development.id, key: "BAD", title: "t", goal: { kind: "PARITY", targetResourceId: kotlin, referenceResourceId: java }, operationId: operationId() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(admin.missionCreate(principal, { projectId: development.id, key: "BAD2", title: "t", goal: { kind: "DELIVERY", targetResourceId: kotlin }, operationId: operationId() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const task = await service.taskCreate({ projectId: development.id, externalKey: "WRITE-1", title: "t", description: "d", requirements: ["r"], relationships: [] });
    await service.taskAnalyze(development.id, task.id);
    await service.taskPlan(development.id, task.id);
    await expect(asyncExecution.enqueueImplementation({ projectId: development.id, taskId: task.id, operationId: operationId(), changes: [{ path: "a.txt", content: "a\n" }] }, kotlin)).rejects.toMatchObject({ code: "POLICY_VIOLATION", message: expect.stringContaining("Cross-project resource") });
    expect(await store.listExecutionJobs(development.id, task.id)).toEqual([]);
  });

  it("pins the reference, counts only runs against the pin, and unlinking turns the reference off", async () => {
    const { admin, working, development, task, parity } = await twoProjects();
    await admin.projectProductSet(principal, { projectId: working.id, product: "acme", operationId: operationId() });
    await admin.projectProductSet(principal, { projectId: development.id, product: "acme", operationId: operationId() });
    const mission = id<{ id: string }>(await admin.missionCreate(principal, { projectId: development.id, key: "JAVA", title: "t", goal: parity(), taskIds: [task.id], operationId: operationId() }));
    let parityStep = (await admin.projectBrief(principal, development.id)).missions[0]!.progress!.steps.find((step) => step.id === "PARITY")!;
    await admin.httpE2eRun(principal, development.id, { ...(parityStep.next!.arguments as Record<string, unknown>), operationId: operationId() } as never);
    expect((await admin.projectBrief(principal, development.id)).missions[0]!.progress!.steps.find((step) => step.id === "PARITY")?.status).toBe("RUNNING");

    // Pinned to the last Kotlin release: the earlier unpinned run no longer counts.
    await admin.missionUpdate(principal, { projectId: development.id, missionId: mission.id, referenceRef: "kotlin-final", operationId: operationId() });
    parityStep = (await admin.projectBrief(principal, development.id)).missions[0]!.progress!.steps.find((step) => step.id === "PARITY")!;
    expect(parityStep).toMatchObject({ status: "REMAINING", detail: expect.stringContaining("kotlin-final"), next: { arguments: { counterpart: { ref: "kotlin-final" } } } });

    await admin.projectProductSet(principal, { projectId: working.id, product: null, operationId: operationId() });
    const brief = await admin.projectBrief(principal, development.id);
    expect(brief.productRepositories).toEqual([]);
    expect(brief.missions[0]!.progress!.steps[0]).toMatchObject({ id: "REPOSITORIES", status: "FAILING" });
  });
});
