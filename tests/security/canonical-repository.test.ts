import { describe, expect, it } from "vitest";
import { SuperadminService } from "../../packages/superadmin/src/index.js";
import type { Resource } from "../../packages/schemas/src/index.js";
import { testService } from "../helpers/service.js";
import { commitSha, FakeRepositoryProvider } from "../helpers/repository-provider.js";

const superadmin = { actor: "test-superadmin", role: "SUPERADMIN" as const };
const operator = { actor: "test-operator", role: "PROJECT_OPERATOR" as const };
const head = commitSha("aaaa1111");
const targetHead = commitSha("dddd4444");

async function fixture() {
  const { store, service } = testService();
  const system = await service.projectCreate({ name: "System", slug: "system", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const project = await service.projectCreate({ name: "App", slug: "app", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "GUARDED", workspacePath: "" });
  const other = await service.projectCreate({ name: "Other", slug: "other", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "GUARDED", workspacePath: "" });
  const register = (projectId: string, reference: string, overrides: Partial<Resource> = {}) =>
    store.createResource({ resourceId: crypto.randomUUID(), type: "GITHUB_REPOSITORY", provider: "github", externalReference: reference, projectId, environment: "SANDBOX", permissions: ["READ", "WRITE", "ADMIN"], status: "ACTIVE", secretRefs: [], createdAt: new Date().toISOString(), ...overrides });
  const sandbox = await register(project.id, "momai/kotlin-sandbox");
  const disabled = await register(project.id, "momai/disabled", { status: "DISABLED" });
  const readOnly = await register(project.id, "momai/read-only", { permissions: ["READ"] });
  const renamed = await register(project.id, "momai/renamed-away");
  const database = await register(project.id, "momai/not-a-repo", { type: "DATABASE", provider: "supabase" });
  const foreign = await register(other.id, "momai/foreign");
  const emptyTarget = await register(project.id, "momai/empty-target");
  const occupiedTarget = await register(project.id, "momai/occupied-target");
  const repositories = new FakeRepositoryProvider({
    "momai/kotlin-sandbox": { defaultBranch: "main", head, commits: [head], branches: [{ name: "main", sha: head }] },
    "momai/disabled": { defaultBranch: "main", head, commits: [head] },
    "momai/read-only": { defaultBranch: "main", head, commits: [head] },
    // The registration says momai/renamed-away; the provider says the repository is now elsewhere.
    "momai/renamed-away": { defaultBranch: "main", head, commits: [head], reportedIdentity: "someone-else/renamed-away" },
    "momai/not-a-repo": { defaultBranch: "main", head, commits: [head] },
    "momai/foreign": { defaultBranch: "main", head, commits: [head] },
    "momai/empty-target": { defaultBranch: "main" },
    "momai/occupied-target": { defaultBranch: "main", head: targetHead, commits: [targetHead] },
  });
  const admin = new SuperadminService({ store, service, systemProjectId: system.id, repositories });
  return { store, service, admin, project, other, sandbox, disabled, readOnly, renamed, database, foreign, emptyTarget, occupiedTarget };
}

const blockerCodes = (value: { blockers: Array<{ code: string }> }) => value.blockers.map((blocker) => blocker.code);
const promote = (projectId: string, resourceId: string, operationId: string, expectedHeadSha = head, version = 0) => ({
  projectId, resourceId, operationId, expectedHeadSha,
  expectedCurrentCanonicalVersion: version,
  confirmation: "PROMOTE_CANONICAL_DEVELOPMENT_REPOSITORY" as const,
  reason: "Adopt this repository as the development target",
});

describe("canonical repository security boundaries", () => {
  it("requires SUPERADMIN on every canonical and export operation", async () => {
    const { admin, project, sandbox } = await fixture();
    await expect(admin.canonicalRepositoryGet(operator, project.id)).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await expect(admin.canonicalRepositoryPlan(operator, project.id, sandbox.resourceId)).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await expect(admin.canonicalRepositoryPromote(operator, promote(project.id, sandbox.resourceId, "canonical-role-1"))).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await expect(admin.repositoryExportPlan(operator, project.id, sandbox.resourceId, sandbox.resourceId)).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await expect(admin.developerHandoverReport(operator, project.id)).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  });

  it("refuses a resource that belongs to a different project", async () => {
    const { admin, project, foreign } = await fixture();
    await expect(admin.canonicalRepositoryPlan(superadmin, project.id, foreign.resourceId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(admin.canonicalRepositoryPromote(superadmin, promote(project.id, foreign.resourceId, "canonical-cross-1"))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("blocks an inactive resource, a non-GitHub resource, and insufficient permissions", async () => {
    const { admin, project, disabled, database, readOnly } = await fixture();
    expect(blockerCodes(await admin.canonicalRepositoryPlan(superadmin, project.id, disabled.resourceId))).toContain("RESOURCE_INACTIVE");
    expect(blockerCodes(await admin.canonicalRepositoryPlan(superadmin, project.id, database.resourceId))).toContain("RESOURCE_TYPE_INVALID");
    expect(blockerCodes(await admin.canonicalRepositoryPlan(superadmin, project.id, readOnly.resourceId))).toContain("PERMISSIONS_INSUFFICIENT");

    // A blocked plan is not merely advisory: the mutation refuses it too.
    for (const [index, resource] of [disabled, database, readOnly].entries())
      await expect(admin.canonicalRepositoryPromote(superadmin, promote(project.id, resource.resourceId, `canonical-blocked-${index}`))).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  });

  it("blocks a repository whose provider identity no longer matches its registration", async () => {
    const { admin, project, renamed } = await fixture();
    const plan = await admin.canonicalRepositoryPlan(superadmin, project.id, renamed.resourceId);
    expect(blockerCodes(plan)).toContain("REPOSITORY_IDENTITY_MISMATCH");
    await expect(admin.canonicalRepositoryPromote(superadmin, promote(project.id, renamed.resourceId, "canonical-renamed-1"))).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  });

  it("accepts only a registered resourceId, never a caller-supplied repository or Git URL", async () => {
    const { admin, project } = await fixture();
    // The input schema admits a UUID resourceId only, so neither owner/name nor a URL parses.
    // Validation happens before any promise is created, so this rejects synchronously.
    for (const value of ["momai/kotlin-sandbox", "https://github.com/momai/kotlin-sandbox.git", "git@github.com:momai/kotlin-sandbox.git"])
      expect(() => admin.canonicalRepositoryPromote(superadmin, { ...promote(project.id, "unused", "canonical-url-1"), resourceId: value })).toThrowError(/Invalid uuid/);
    // An unregistered but well-formed UUID resolves to nothing rather than to a repository.
    await expect(admin.canonicalRepositoryPromote(superadmin, promote(project.id, crypto.randomUUID(), "canonical-url-2"))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a production project or resource", async () => {
    const { store, service, admin } = await fixture();
    const production = await service.projectCreate({ name: "Prod", slug: "prod", sourceType: "TEST", environment: "STAGING", autonomyMode: "GUARDED", workspacePath: "" });
    await store.updateProject({ ...(await store.getProject(production.id))!, environment: "PRODUCTION" });
    const resource = await store.createResource({ resourceId: crypto.randomUUID(), type: "GITHUB_REPOSITORY", provider: "github", externalReference: "momai/production", projectId: production.id, environment: "PRODUCTION", permissions: ["READ", "WRITE"], status: "ACTIVE", secretRefs: [], createdAt: new Date().toISOString() });
    expect(blockerCodes(await admin.canonicalRepositoryPlan(superadmin, production.id, resource.resourceId))).toContain("PRODUCTION_MUTATION_NOT_SUPPORTED");
    // The shared mutation wrapper refuses production before the domain is even reached.
    await expect(admin.canonicalRepositoryPromote(superadmin, promote(production.id, resource.resourceId, "canonical-prod-1"))).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });

  it("refuses to promote a repository it cannot read", async () => {
    const { store, service, admin, project } = await fixture();
    const unknown = await store.createResource({ resourceId: crypto.randomUUID(), type: "GITHUB_REPOSITORY", provider: "github", externalReference: "momai/never-registered-upstream", projectId: project.id, environment: "SANDBOX", permissions: ["READ", "WRITE"], status: "ACTIVE", secretRefs: [], createdAt: new Date().toISOString() });
    void service;
    const plan = await admin.canonicalRepositoryPlan(superadmin, project.id, unknown.resourceId);
    expect(blockerCodes(plan)).toEqual(expect.arrayContaining(["REPOSITORY_UNREACHABLE", "HEAD_SHA_UNRESOLVED"]));
    expect(plan.result).toBe("BLOCKED");

    // The mutation must refuse for the SAME stated reason. An unreadable repository has no head to
    // compare, so an ordering that checked staleness first would report a stale plan here and send
    // the operator looking for a moved branch that does not exist.
    const refused = await admin.canonicalRepositoryPromote(superadmin, promote(project.id, unknown.resourceId, "canonical-unreachable-1")).catch((error: { code: string; details: { blockers?: Array<{ code: string }> } }) => error);
    expect(refused).toMatchObject({ code: "POLICY_VIOLATION" });
    expect((refused as { details: { blockers: Array<{ code: string }> } }).details.blockers.map((blocker) => blocker.code)).toContain("REPOSITORY_UNREACHABLE");
  });

  it("will not let an export make its target canonical, and will not export while unverified", async () => {
    const { admin, project, sandbox, emptyTarget } = await fixture();
    const plan = await admin.repositoryExportPlan(superadmin, project.id, sandbox.resourceId, emptyTarget.resourceId);
    expect(plan.result).toBe("READY_TO_EXPORT");
    // Planning an export changes nothing about which repository is canonical.
    expect((await admin.canonicalRepositoryGet(superadmin, project.id)).hasCanonicalRepository).toBe(false);

    await admin.canonicalRepositoryPromote(superadmin, promote(project.id, sandbox.resourceId, "canonical-export-1"));
    const exported = await admin.repositoryExport(superadmin, { projectId: project.id, sourceResourceId: sandbox.resourceId, targetResourceId: emptyTarget.resourceId, operationId: "export-dispatch-1", expectedSourceHeadSha: head, confirmation: "EXPORT_REPOSITORY_HISTORY", reason: "Move the history to the successor repository" }).catch((error: { code: string }) => error);
    // With no dispatcher configured the export refuses rather than half-running.
    expect(exported).toMatchObject({ code: "NOT_SUPPORTED" });
    expect((await admin.canonicalRepositoryGet(superadmin, project.id)).active?.resourceId).toBe(sandbox.resourceId);
  });

  it("refuses an export target that already holds history rather than force-pushing over it", async () => {
    const { admin, project, sandbox, occupiedTarget } = await fixture();
    const plan = await admin.repositoryExportPlan(superadmin, project.id, sandbox.resourceId, occupiedTarget.resourceId);
    expect(blockerCodes(plan)).toContain("EXPORT_TARGET_CONFLICT");
    expect(plan.result).toBe("BLOCKED");
    await expect(
      admin.repositoryExport(superadmin, { projectId: project.id, sourceResourceId: sandbox.resourceId, targetResourceId: occupiedTarget.resourceId, operationId: "export-conflict-1", expectedSourceHeadSha: head, confirmation: "EXPORT_REPOSITORY_HISTORY", reason: "Attempt to overwrite an occupied target" }),
    ).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  });

  it("refuses an export whose source or target is the same repository or a foreign project's", async () => {
    const { admin, project, sandbox, foreign } = await fixture();
    expect(blockerCodes(await admin.repositoryExportPlan(superadmin, project.id, sandbox.resourceId, sandbox.resourceId))).toContain("EXPORT_TARGET_IS_SOURCE");
    await expect(admin.repositoryExportPlan(superadmin, project.id, sandbox.resourceId, foreign.resourceId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("carries secret reference names only into the handover checklist", async () => {
    const { store, admin, project, sandbox, emptyTarget } = await fixture();
    await store.createResource({ resourceId: crypto.randomUUID(), type: "DATABASE", provider: "supabase", externalReference: "momai/app-db", projectId: project.id, environment: "SANDBOX", permissions: ["READ", "WRITE"], status: "ACTIVE", secretRefs: ["APP_DATABASE_URL"], createdAt: new Date().toISOString() });
    const plan = await admin.repositoryExportPlan(superadmin, project.id, sandbox.resourceId, emptyTarget.resourceId);
    expect(plan.secretHandover.valuesTransferred).toBe(false);
    expect(plan.secretHandover.entries.map((entry) => entry.name)).toContain("APP_DATABASE_URL");
    // The checklist is names, purposes and statuses. There is no field a value could live in.
    const serialized = JSON.stringify(plan.secretHandover);
    expect(serialized).not.toMatch(/postgres(?:ql)?:\/\//);
    for (const entry of plan.secretHandover.entries) expect(Object.keys(entry)).not.toContain("value");
    expect(plan.nonTransferableConfiguration.every((item) => item.status !== "VERIFIED")).toBe(true);
  });

  it("blocks export verification it cannot prove, instead of reporting partial success", async () => {
    const { admin, project, sandbox, emptyTarget } = await fixture();
    const verification = await admin.repositoryExportVerify(superadmin, { projectId: project.id, sourceResourceId: sandbox.resourceId, targetResourceId: emptyTarget.resourceId, operationId: "export-verify-empty-1" });
    const value = verification.value as { result: string; blockers: Array<{ code: string }> };
    expect(value.result).toBe("BLOCKED");
    expect(value.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining(["TARGET_SHA_MISSING", "HISTORY_MISMATCH"]));
  });
});
