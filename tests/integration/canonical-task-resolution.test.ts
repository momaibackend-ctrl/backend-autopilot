import { describe, expect, it } from "vitest";
import { AsyncExecutionCoordinator } from "../../packages/core/src/async-execution.js";
import { resolveDevelopmentTarget } from "../../packages/canonical-repository/src/target-resolution.js";
import { SuperadminService } from "../../packages/superadmin/src/index.js";
import type { ExecutionJob, Resource } from "../../packages/schemas/src/index.js";
import { testService } from "../helpers/service.js";
import { commitSha, FakeRepositoryProvider } from "../helpers/repository-provider.js";

const superadmin = { actor: "test-superadmin", role: "SUPERADMIN" as const };
const canonicalHead = commitSha("aaaa1111");
const legacyHead = commitSha("bbbb2222");

async function fixture() {
  const { store, service } = testService();
  const system = await service.projectCreate({ name: "System", slug: "system", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const project = await service.projectCreate({ name: "App", slug: "app", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const register = (reference: string, overrides: Partial<Resource> = {}) =>
    store.createResource({ resourceId: crypto.randomUUID(), type: "GITHUB_REPOSITORY", provider: "github", externalReference: reference, projectId: project.id, environment: "SANDBOX", permissions: ["READ", "WRITE", "ADMIN"], status: "ACTIVE", secretRefs: [], createdAt: new Date().toISOString(), ...overrides });
  const legacy = await register("momai/legacy-sandbox");
  const canonical = await register("momai/canonical-app");
  const repositories = new FakeRepositoryProvider({
    "momai/legacy-sandbox": { defaultBranch: "main", head: legacyHead, commits: [legacyHead] },
    "momai/canonical-app": { defaultBranch: "trunk", head: canonicalHead, commits: [canonicalHead] },
  });
  const dispatched: ExecutionJob[] = [];
  const coordinator = new AsyncExecutionCoordinator(store, { dispatch: async (job) => { dispatched.push(job); return {}; } }, undefined, undefined, repositories);
  const admin = new SuperadminService({ store, service, systemProjectId: system.id, repositories, asyncExecution: coordinator });
  const plannedTask = async (externalKey: string) => {
    const task = await service.taskCreate({ projectId: project.id, externalKey, title: externalKey, description: "Work", requirements: ["Do the thing"], relationships: [] });
    await store.updateTask({ ...task, state: "PLANNED" });
    return task;
  };
  const promote = (resourceId: string, operationId: string, expectedHeadSha: string) =>
    admin.canonicalRepositoryPromote(superadmin, { projectId: project.id, resourceId, operationId, expectedHeadSha, expectedCurrentCanonicalVersion: 0, confirmation: "PROMOTE_CANONICAL_DEVELOPMENT_REPOSITORY", reason: "Adopt the canonical development target" });
  const changes = [{ path: "src/Main.kt", content: "fun main() {}", operation: "CREATE" as const }];
  return { store, service, admin, project, legacy, canonical, coordinator, dispatched, plannedTask, promote, changes };
}

describe("development target resolution", () => {
  it("keeps behaving exactly as before for a project with no canonical binding", async () => {
    const { coordinator, project, legacy, plannedTask, dispatched, changes } = await fixture();
    const task = await plannedTask("LEGACY-1");
    await coordinator.enqueueImplementation({ projectId: project.id, taskId: task.id, operationId: "legacy-exec-1", changes }, legacy.resourceId);
    expect(dispatched.at(-1)?.resourceId).toBe(legacy.resourceId);
    // Without a binding nothing pins a base commit either, which is the pre-existing behaviour.
    expect(dispatched.at(-1)?.baseCommitSha).toBeUndefined();
  });

  it("refuses to execute with no repository named and no canonical binding", async () => {
    const { coordinator, project, plannedTask, changes } = await fixture();
    const task = await plannedTask("LEGACY-2");
    await expect(
      coordinator.enqueueImplementation({ projectId: project.id, taskId: task.id, operationId: "legacy-exec-2", changes }, undefined),
    ).rejects.toMatchObject({ code: "POLICY_VIOLATION", details: expect.objectContaining({ blockingReport: expect.objectContaining({ code: "NO_DEVELOPMENT_TARGET" }) }) });
  });

  it("resolves a new task to the canonical repository and pins its exact base SHA", async () => {
    const { coordinator, project, canonical, promote, plannedTask, dispatched, changes } = await fixture();
    await promote(canonical.resourceId, "canonical-target-1", canonicalHead);
    const task = await plannedTask("NEW-1");

    await coordinator.enqueueImplementation({ projectId: project.id, taskId: task.id, operationId: "canonical-exec-1", changes }, undefined);
    const job = dispatched.at(-1);
    expect(job?.resourceId).toBe(canonical.resourceId);
    // Canonical says WHERE the base comes from; the execution still pins an exact commit.
    expect(job?.baseBranch).toBe("trunk");
    expect(job?.baseCommitSha).toBe(canonicalHead);
  });

  it("does not let a caller redirect new work past the canonical binding", async () => {
    const { coordinator, project, legacy, canonical, promote, plannedTask, changes } = await fixture();
    await promote(canonical.resourceId, "canonical-target-2", canonicalHead);
    const task = await plannedTask("NEW-2");
    await expect(
      coordinator.enqueueImplementation({ projectId: project.id, taskId: task.id, operationId: "canonical-exec-2", changes }, legacy.resourceId),
    ).rejects.toMatchObject({ code: "POLICY_VIOLATION", details: expect.objectContaining({ blockingReport: expect.objectContaining({ code: "CANONICAL_TARGET_REQUIRED" }) }) });
  });

  it("accepts a caller-supplied resourceId that merely confirms the canonical target", async () => {
    const { coordinator, project, canonical, promote, plannedTask, dispatched, changes } = await fixture();
    await promote(canonical.resourceId, "canonical-target-3", canonicalHead);
    const task = await plannedTask("NEW-3");
    await coordinator.enqueueImplementation({ projectId: project.id, taskId: task.id, operationId: "canonical-exec-3", changes }, canonical.resourceId);
    expect(dispatched.at(-1)?.resourceId).toBe(canonical.resourceId);
  });

  it("keeps an already-executing task on its pinned repository after a later promotion", async () => {
    const { coordinator, project, legacy, canonical, promote, plannedTask, dispatched, changes } = await fixture();
    const task = await plannedTask("EXISTING-1");
    // The task starts before any canonical binding exists, pinned to the old sandbox repository.
    await coordinator.enqueueImplementation({ projectId: project.id, taskId: task.id, operationId: "existing-exec-1", changes }, legacy.resourceId);
    expect(dispatched.at(-1)?.resourceId).toBe(legacy.resourceId);

    await promote(canonical.resourceId, "canonical-target-4", canonicalHead);

    // A promotion must not strand work already under way: its branch and verified commit live in
    // the repository it started in.
    await coordinator.enqueueImplementation({ projectId: project.id, taskId: task.id, operationId: "existing-exec-2", changes }, undefined);
    expect(dispatched.at(-1)?.resourceId).toBe(legacy.resourceId);
    expect(dispatched.at(-1)?.baseCommitSha).toBeUndefined();
  });

  it("refuses to move a pinned task onto a different repository", () => {
    expect(() => resolveDevelopmentTarget({ pinnedResourceId: "pinned", requestedResourceId: "other" }))
      .toThrowError(expect.objectContaining({ code: "POLICY_VIOLATION" }));
    expect(resolveDevelopmentTarget({ pinnedResourceId: "pinned" })).toEqual({ resourceId: "pinned", source: "PINNED_TASK_RESOURCE" });
    expect(resolveDevelopmentTarget({ requestedResourceId: "explicit" })).toEqual({ resourceId: "explicit", source: "EXPLICIT_RESOURCE" });
    expect(resolveDevelopmentTarget({ activeCanonical: { id: "binding", resourceId: "canonical", repository: "momai/app" } }))
      .toEqual({ resourceId: "canonical", source: "ACTIVE_CANONICAL", canonicalBindingId: "binding" });
  });
});
