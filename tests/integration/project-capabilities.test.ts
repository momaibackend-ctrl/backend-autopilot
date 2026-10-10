import { describe, expect, it, vi } from "vitest";
import { AsyncExecutionCoordinator } from "../../packages/core/src/async-execution.js";
import { createService } from "../../packages/core/src/runtime.js";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";
import type { ExecutionJob, Resource } from "../../packages/schemas/src/index.js";
import { SuperadminService } from "../../packages/superadmin/src/index.js";
import { FakeRepositoryProvider } from "../helpers/repository-provider.js";

const principal = { actor: "superadmin-test", role: "SUPERADMIN" as const };
const kotlinHead = "5".repeat(40);
const javaHead = "6".repeat(40);
let counter = 0;
const operationId = () => `capabilities-${++counter}-${Date.now()}`;

// The situation of a real port: the original service is the project's canonical development
// repository, the port is registered read-only, and the task so far only verified the port.
async function portProject() {
  const store = new MemoryStateStore();
  const service = createService({ store });
  const system = await service.projectCreate({ name: "System", slug: "system", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const project = await service.projectCreate({ name: "Product", slug: "product", sourceType: "MCP", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const repositories = new FakeRepositoryProvider({
    "acme/kotlin": { defaultBranch: "main", head: kotlinHead, commits: [kotlinHead], visibility: "private", permissions: { admin: true, push: true } },
    "acme/java": { defaultBranch: "main", head: javaHead, commits: [javaHead], visibility: "public", permissions: { admin: true, push: true } },
  });
  const dispatched: ExecutionJob[] = [];
  const asyncExecution = new AsyncExecutionCoordinator(store, { dispatch: vi.fn(async () => ({})) });
  const admin = new SuperadminService({ store, service, systemProjectId: system.id, repositories, asyncExecution, httpE2eDispatcher: { dispatch: async (job) => (dispatched.push(job), {}) } });
  // GITHUB_REPOSITORY resources come from the verified registration flow; the canonical one is seeded.
  const kotlin = await store.createResource({ resourceId: crypto.randomUUID(), type: "GITHUB_REPOSITORY", provider: "github", externalReference: "acme/kotlin", projectId: project.id, environment: "SANDBOX", permissions: ["READ", "WRITE", "ADMIN"], status: "ACTIVE", secretRefs: [], createdAt: new Date().toISOString() } as Resource);
  await admin.canonicalRepositoryPromote(principal, { projectId: project.id, resourceId: kotlin.resourceId, operationId: operationId(), expectedHeadSha: kotlinHead, expectedCurrentCanonicalVersion: 0, confirmation: "PROMOTE_CANONICAL_DEVELOPMENT_REPOSITORY", reason: "Original service is the development target" });
  const java = ((await admin.repositoryRegister(principal, project.id, { repository: "acme/java", access: "READ" }, operationId())) as { value: { resourceId: string } }).value;
  return { store, service, admin, project, kotlin, java, dispatched };
}

describe("project capabilities through the superadmin service", () => {
  it("shows a READ registration can be verified but not developed, and why", async () => {
    const { admin, project } = await portProject();
    const capabilities = await admin.projectCapabilities(principal, project.id);
    expect(capabilities.canonicalRepository).toBe("acme/kotlin");
    const byName = Object.fromEntries(capabilities.repositories.map((value) => [value.repository, value]));
    expect(byName["acme/kotlin"]?.role).toBe("CANONICAL");
    expect(byName["acme/kotlin"]?.capabilities.EXECUTE_CHANGES.allowed).toBe(true);
    const java = byName["acme/java"];
    expect(java?.capabilities.HTTP_E2E.allowed).toBe(true);
    expect(java?.capabilities.EXECUTE_CHANGES.missing.map((value) => value.requirement)).toEqual(["WRITE on the registration (it has READ)"]);
  });

  it("FULL access makes the port fully developable although another repository is canonical", async () => {
    const { admin, project } = await portProject();
    await admin.repositoryRegister(principal, project.id, { repository: "acme/java", access: "FULL" }, operationId());
    const java = (await admin.projectCapabilities(principal, project.id)).repositories.find((value) => value.repository === "acme/java");
    expect(Object.values(java?.capabilities ?? {}).every((value) => value.allowed)).toBe(true);
  });

  it("registers with FULL access when no access is named", async () => {
    const { admin, project } = await portProject();
    const { value } = (await admin.repositoryRegister(principal, project.id, { repository: "acme/java" }, operationId())) as { value: { permissions: string[] } };
    expect(value.permissions).toEqual(["READ", "WRITE", "ADMIN"]);
  });

  it("task_execute plans an INGESTED task on the way and develops in the named non-canonical repository", async () => {
    const { store, admin, service, project, java } = await portProject();
    await admin.repositoryRegister(principal, project.id, { repository: "acme/java", access: "FULL" }, operationId());
    const task = await service.taskCreate({ projectId: project.id, externalKey: "PORT-TESTS-1", title: "Add check-in transition tests to the Java port", description: "d", requirements: ["cover DRAFT to PARTIAL to DRAFT"], relationships: [] });
    const result = (await admin.taskExecute(principal, { projectId: project.id, taskId: task.id, resourceId: java.resourceId, operationId: operationId(), changes: [{ path: "src/test/java/CheckinTransitionsTest.java", content: "class CheckinTransitionsTest {}\n" }] as never })) as { value: { job: { resourceId: string } } };
    expect(result.value.job.resourceId).toBe(java.resourceId);
    expect((await store.getTask(project.id, task.id))?.state).toBe("IMPLEMENTING");
    const transitions = (await service.taskStatus(project.id, task.id)).transitions.map((value) => value.to);
    expect(transitions).toEqual(["ANALYZING", "PLANNED", "IMPLEMENTING"]);
  });

  it("an HTTP_E2E job never pins a task to the verified repository past the canonical rule", async () => {
    const { store, admin, service, project, java } = await portProject();
    await admin.repositoryRegister(principal, project.id, { repository: "acme/java", access: "FULL" }, operationId());
    const task = await service.taskCreate({ projectId: project.id, externalKey: "PORT-1", title: "Port tests", description: "d", requirements: ["r"], relationships: [] });
    await admin.httpE2eRun(principal, project.id, { taskId: task.id, repositoryResourceId: java.resourceId, scenarioSource: { kind: "REPOSITORY" }, operationId: operationId() });
    const [job] = await store.listExecutionJobs(project.id, task.id);
    await store.updateExecutionJob({ ...job!, status: "SUCCEEDED" });
    await service.taskAnalyze(project.id, task.id);
    await service.taskPlan(project.id, task.id);
    const coordinator = new AsyncExecutionCoordinator(store, { dispatch: vi.fn(async () => ({})) });
    await expect(
      coordinator.enqueueImplementation({ projectId: project.id, taskId: task.id, operationId: operationId(), changes: [{ path: "src/test/X.java", content: "class X {}\n" }] }, undefined),
    ).resolves.toMatchObject({ job: { resourceId: (await store.getActiveCanonicalRepository(project.id))?.resourceId } });
  });

  it("audits every refused mutation with its reason, and lets the same operationId succeed after the fix", async () => {
    const { store, admin, project } = await portProject();
    const retry = operationId();
    await expect(admin.repositoryRegister(principal, project.id, { repository: "acme/missing", access: "READ" }, retry)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const refused = (await store.listAudit(project.id)).find((event) => event.action === "mcp.repository_register.refused");
    expect(refused?.result).toMatchObject({ code: "NOT_FOUND", message: "The repository does not exist or the control-plane identity cannot see it" });
    const fixed = (await admin.repositoryRegister(principal, project.id, { repository: "acme/java", access: "READ" }, retry)) as { idempotentReplay: boolean };
    expect(fixed.idempotentReplay).toBe(false);
  });

  it("names the remedy when a READ registration is asked to accept a change set", async () => {
    const { store, service, project, java } = await portProject();
    // A project without a canonical binding, so only the permission is at stake.
    await store.updateProject({ ...(await store.getProject(project.id))!, autonomyMode: "AUTONOMOUS_STAGING" });
    const other = await service.projectCreate({ name: "Plain", slug: "plain", sourceType: "MCP", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
    const readOnly = await store.createResource({ resourceId: crypto.randomUUID(), type: "GITHUB_REPOSITORY", provider: "github", externalReference: "acme/read-only", projectId: other.id, environment: "SANDBOX", permissions: ["READ"], status: "ACTIVE", secretRefs: [], createdAt: new Date().toISOString() } as Resource);
    const task = await service.taskCreate({ projectId: other.id, externalKey: "RO-1", title: "t", description: "d", requirements: ["r"], relationships: [] });
    await service.taskAnalyze(other.id, task.id);
    await service.taskPlan(other.id, task.id);
    const coordinator = new AsyncExecutionCoordinator(store, { dispatch: vi.fn(async () => ({})) });
    await expect(
      coordinator.enqueueImplementation({ projectId: other.id, taskId: task.id, operationId: operationId(), changes: [{ path: "a.txt", content: "a\n" }] }, readOnly.resourceId),
    ).rejects.toMatchObject({ code: "POLICY_VIOLATION", details: { required: "WRITE", remediation: expect.stringContaining("superadmin_repository_register (access FULL)") } });
    expect(java.resourceId).toBeDefined();
  });
});
