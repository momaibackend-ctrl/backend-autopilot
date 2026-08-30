import { describe, expect, it } from "vitest";
import { SuperadminService } from "../../packages/superadmin/src/index.js";
import { assertRenamePreservedIdentity, RenameIdentityMismatch } from "../../packages/canonical-repository/src/rename.js";
import type { Resource } from "../../packages/schemas/src/index.js";
import { testService } from "../helpers/service.js";
import { commitSha, FakeRepositoryProvider } from "../helpers/repository-provider.js";

const superadmin = { actor: "test-superadmin", role: "SUPERADMIN" as const };
const operator = { actor: "test-operator", role: "PROJECT_OPERATOR" as const };
const head = commitSha("aaaa1111");
const moved = commitSha("bbbb2222");

async function fixture() {
  const { store, service } = testService();
  const system = await service.projectCreate({ name: "System", slug: "system", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const project = await service.projectCreate({ name: "App", slug: "app", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "GUARDED", workspacePath: "" });
  const other = await service.projectCreate({ name: "Other", slug: "other", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "GUARDED", workspacePath: "" });
  const register = (projectId: string, reference: string, overrides: Partial<Resource> = {}) =>
    store.createResource({ resourceId: crypto.randomUUID(), type: "GITHUB_REPOSITORY", provider: "github", externalReference: reference, projectId, environment: "SANDBOX", permissions: ["READ", "WRITE", "ADMIN"], status: "ACTIVE", secretRefs: [], createdAt: new Date().toISOString(), ...overrides });
  const sandbox = await register(project.id, "momai/kotlin-sandbox");
  const noAdmin = await register(project.id, "momai/no-admin", { permissions: ["READ", "WRITE"] });
  const database = await register(project.id, "momai/not-a-repo", { type: "DATABASE", provider: "supabase" });
  const foreign = await register(other.id, "momai/foreign");
  const occupied = await register(project.id, "momai/occupied");
  const repositories = new FakeRepositoryProvider({
    "momai/kotlin-sandbox": { defaultBranch: "main", head, commits: [head], repositoryId: "R_stable" },
    "momai/no-admin": { defaultBranch: "main", head, commits: [head] },
    "momai/not-a-repo": { defaultBranch: "main", head, commits: [head] },
    "momai/foreign": { defaultBranch: "main", head, commits: [head] },
    "momai/occupied": { defaultBranch: "main", head, commits: [head] },
    "momai/taken": { defaultBranch: "main", head, commits: [head] },
  });
  const admin = new SuperadminService({ store, service, systemProjectId: system.id, repositories });
  return { store, service, admin, project, sandbox, noAdmin, database, foreign, occupied, repositories };
}

const rename = (projectId: string, resourceId: string, operationId: string, overrides: Record<string, unknown> = {}) => ({
  projectId, resourceId, operationId,
  newName: "momna-backend",
  expectedCurrentReference: "momai/kotlin-sandbox",
  expectedHeadSha: head,
  confirmation: "RENAME_REGISTERED_REPOSITORY" as const,
  reason: "Give the repository the product's name",
  ...overrides,
});
const codes = (value: { blockers: Array<{ code: string }> }) => value.blockers.map((blocker) => blocker.code);

describe("registered repository rename", () => {
  it("renames in place, keeps the head, and re-points the registration without duplicating it", async () => {
    const { store, admin, project, sandbox } = await fixture();
    const plan = await admin.repositoryRenamePlan(superadmin, project.id, sandbox.resourceId, "momna-backend");
    expect(plan.result).toBe("READY_TO_RENAME");
    expect(plan.targetRepository).toBe("momai/momna-backend");
    expect(plan.headSha).toBe(head);
    expect(plan.repositoryId).toBe("R_stable");
    // A dry run renames nothing.
    expect((await store.getResource(sandbox.resourceId))?.externalReference).toBe("momai/kotlin-sandbox");

    const before = (await store.listResources(project.id)).length;
    const outcome = await admin.repositoryRename(superadmin, rename(project.id, sandbox.resourceId, "rename-op-1"));
    const value = outcome.value as { newRepository: string; headSha: string; repositoryId: string };
    expect(value.newRepository).toBe("momai/momna-backend");
    expect(value.headSha).toBe(head);
    expect(value.repositoryId).toBe("R_stable");

    // The SAME resource now points at the new name; no second resource was created.
    expect((await store.getResource(sandbox.resourceId))?.externalReference).toBe("momai/momna-backend");
    expect((await store.listResources(project.id)).length).toBe(before);
    const artifacts = await store.listArtifacts(project.id);
    expect(artifacts.map((artifact) => artifact.kind)).toContain("REPOSITORY_RENAME_REPORT");
    expect((await store.listAudit(project.id)).some((event) => event.action === "repository.rename")).toBe(true);
  });

  it("replays the same rename without renaming twice", async () => {
    const { admin, project, sandbox } = await fixture();
    await admin.repositoryRename(superadmin, rename(project.id, sandbox.resourceId, "rename-replay"));
    const replay = await admin.repositoryRename(superadmin, rename(project.id, sandbox.resourceId, "rename-replay"));
    expect(replay.idempotentReplay).toBe(true);
  });

  it("also updates the project's own repository identity, so the old name survives nowhere", async () => {
    const { store, admin, service, project, sandbox } = await fixture();
    await service.projectGet(project.id);
    await store.updateProject({ ...(await store.getProject(project.id))!, repository: { owner: "momai", name: "kotlin-sandbox", defaultBranch: "main", resourceId: sandbox.resourceId } });
    const outcome = await admin.repositoryRename(superadmin, rename(project.id, sandbox.resourceId, "rename-project-1"));
    expect((outcome.value as { projectRepositoryUpdated: boolean }).projectRepositoryUpdated).toBe(true);
    expect((await store.getProject(project.id))?.repository).toMatchObject({ owner: "momai", name: "momna-backend" });
  });

  it("refuses when the repository after the rename is not provably the same repository", async () => {
    const { store, admin, project, sandbox, repositories } = await fixture();
    // The provider hands back a different object id: this is the re-pointing the guard exists for.
    repositories.set("momai/kotlin-sandbox", { defaultBranch: "main", head, commits: [head], repositoryId: "R_stable", renameMutates: { repositoryId: "R_different" } });
    await expect(admin.repositoryRename(superadmin, rename(project.id, sandbox.resourceId, "rename-identity-1")))
      .rejects.toMatchObject({ code: "INVALID_STATE", details: expect.objectContaining({ blockingReport: expect.objectContaining({ code: "RENAME_IDENTITY_MISMATCH" }) }) });
    // The registration is deliberately NOT updated when identity cannot be proved.
    expect((await store.getResource(sandbox.resourceId))?.externalReference).toBe("momai/kotlin-sandbox");
  });

  it("refuses when the head commit moved across the rename", async () => {
    const { store, admin, project, sandbox, repositories } = await fixture();
    repositories.set("momai/kotlin-sandbox", { defaultBranch: "main", head, commits: [head, moved], repositoryId: "R_stable", renameMutates: { head: moved } });
    await expect(admin.repositoryRename(superadmin, rename(project.id, sandbox.resourceId, "rename-head-1")))
      .rejects.toMatchObject({ details: expect.objectContaining({ blockingReport: expect.objectContaining({ code: "RENAME_IDENTITY_MISMATCH" }) }) });
    expect((await store.getResource(sandbox.resourceId))?.externalReference).toBe("momai/kotlin-sandbox");
  });

  it("blocks a stale plan rather than renaming across a commit nobody looked at", async () => {
    const { admin, project, sandbox, repositories } = await fixture();
    repositories.set("momai/kotlin-sandbox", { defaultBranch: "main", head: moved, commits: [head, moved], repositoryId: "R_stable" });
    await expect(admin.repositoryRename(superadmin, rename(project.id, sandbox.resourceId, "rename-stale-1")))
      .rejects.toMatchObject({ code: "CONFLICT", details: expect.objectContaining({ blockingReport: expect.objectContaining({ code: "STALE_RENAME_PLAN" }) }) });
  });

  it("refuses a target name that is already taken", async () => {
    const { admin, project, sandbox } = await fixture();
    const plan = await admin.repositoryRenamePlan(superadmin, project.id, sandbox.resourceId, "taken");
    expect(codes(plan)).toContain("TARGET_NAME_TAKEN");
    await expect(admin.repositoryRename(superadmin, rename(project.id, sandbox.resourceId, "rename-taken-1", { newName: "taken" })))
      .rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  });

  it("refuses while the repository is the ACTIVE canonical development repository", async () => {
    const { admin, project, sandbox } = await fixture();
    await admin.canonicalRepositoryPromote(superadmin, { projectId: project.id, resourceId: sandbox.resourceId, operationId: "promote-before-rename", expectedHeadSha: head, expectedCurrentCanonicalVersion: 0, confirmation: "PROMOTE_CANONICAL_DEVELOPMENT_REPOSITORY", reason: "Adopt the development target" });
    const plan = await admin.repositoryRenamePlan(superadmin, project.id, sandbox.resourceId, "momna-backend");
    // A canonical binding is append-only evidence; renaming under it would make it describe a
    // repository that no longer answers to that name.
    expect(codes(plan)).toContain("CANONICAL_BINDING_WOULD_GO_STALE");
    await expect(admin.repositoryRename(superadmin, rename(project.id, sandbox.resourceId, "rename-canonical-1")))
      .rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  });

  it("refuses a cross-project, non-GitHub, permissionless or misconfirmed rename", async () => {
    const { admin, project, sandbox, noAdmin, database, foreign } = await fixture();
    await expect(admin.repositoryRenamePlan(superadmin, project.id, foreign.resourceId, "x")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(codes(await admin.repositoryRenamePlan(superadmin, project.id, database.resourceId, "x"))).toContain("RESOURCE_TYPE_INVALID");
    expect(codes(await admin.repositoryRenamePlan(superadmin, project.id, noAdmin.resourceId, "x"))).toContain("PERMISSIONS_INSUFFICIENT");
    // Confirming the wrong current name refuses before anything is read.
    await expect(admin.repositoryRename(superadmin, rename(project.id, sandbox.resourceId, "rename-confirm-1", { expectedCurrentReference: "momai/something-else" })))
      .rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await expect(admin.repositoryRename(operator, rename(project.id, sandbox.resourceId, "rename-role-1"))).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  });

  it("cannot be steered to another owner, because no owner is accepted", async () => {
    const { admin, project, sandbox } = await fixture();
    for (const value of ["other-org/momna-backend", "../escape", "momna backend"])
      expect(() => admin.repositoryRename(superadmin, rename(project.id, sandbox.resourceId, "rename-owner-1", { newName: value }))).toThrowError();
    // The plan derives the owner from the REGISTRATION, never from input.
    const plan = await admin.repositoryRenamePlan(superadmin, project.id, sandbox.resourceId, "momna-backend");
    expect(plan.targetRepository.split("/")[0]).toBe("momai");
  });

  it("states exactly what identity equality means", () => {
    const before = { repositoryId: "R_1", defaultBranch: "main", headSha: head };
    expect(() => assertRenamePreservedIdentity({ before, after: { ...before, externalReference: "momai/new" }, expectedReference: "momai/new" })).not.toThrow();
    for (const [after, expected] of [
      [{ ...before, repositoryId: "R_2", externalReference: "momai/new" }, /repository id changed/],
      [{ ...before, headSha: moved, externalReference: "momai/new" }, /head commit changed/],
      [{ ...before, defaultBranch: "trunk", externalReference: "momai/new" }, /default branch changed/],
      [{ ...before, externalReference: "momai/unexpected" }, /expected momai\/new/],
    ] as const)
      expect(() => assertRenamePreservedIdentity({ before, after, expectedReference: "momai/new" })).toThrowError(expected);
    expect(new RenameIdentityMismatch(["x"]).code).toBe("RENAME_IDENTITY_MISMATCH");
  });
});
