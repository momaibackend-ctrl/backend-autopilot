import { describe, expect, it } from "vitest";
import { SuperadminService } from "../../packages/superadmin/src/index.js";
import { testService } from "../helpers/service.js";

const superadmin = { actor: "test-superadmin", role: "SUPERADMIN" as const };

async function fixture() {
  const { store, service } = testService();
  const system = await service.projectCreate({ name: "System", slug: "system", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const admin = new SuperadminService({ store, service, systemProjectId: system.id });
  const project = await service.projectCreate({ name: "App", slug: "app", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "GUARDED", workspacePath: "" });
  // GITHUB_REPOSITORY resources are provisioned through the dedicated verified-provider bootstrap
  // flow, not superadmin_resource_create (which deliberately forbids Git/GitHub resource types) --
  // seeded directly here to mirror that real provisioning path.
  const current = await store.createResource({ resourceId: crypto.randomUUID(), type: "GITHUB_REPOSITORY", provider: "github", externalReference: "acme-org/current-app", projectId: project.id, environment: "SANDBOX", permissions: ["READ", "WRITE", "ADMIN"], status: "ACTIVE", secretRefs: [], createdAt: new Date().toISOString() });
  const stale = await store.createResource({ resourceId: crypto.randomUUID(), type: "GITHUB_REPOSITORY", provider: "github", externalReference: "acme-org/legacy-app", projectId: project.id, environment: "SANDBOX", permissions: ["READ", "WRITE", "ADMIN"], status: "DISABLED", secretRefs: [], createdAt: new Date().toISOString() });
  const otherProject = await service.projectCreate({ name: "Other", slug: "other", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "GUARDED", workspacePath: "" });
  return { store, admin, project, current, stale, otherProject };
}

describe("canonical project repository binding", () => {
  it("points project.repository at the correct current resource, not a stale one", async () => {
    const { admin, project, current } = await fixture();
    const patched = await admin.projectUpdate(superadmin, project.id, { repository: { owner: "acme-org", name: "current-app", resourceId: current.resourceId, defaultBranch: "main" } }, "repo-rebind-1");
    const value = patched.value as { repository?: { resourceId: string; owner: string; name: string } };
    expect(value.repository).toEqual({ owner: "acme-org", name: "current-app", resourceId: current.resourceId, defaultBranch: "main" });
    expect((await admin.projectGet(superadmin, project.id)).repository?.resourceId).toBe(current.resourceId);
  });

  it("rejects binding to a disabled (stale/superseded) resource", async () => {
    const { admin, project, stale } = await fixture();
    await expect(
      admin.projectUpdate(superadmin, project.id, { repository: { owner: "acme-org", name: "legacy-app", resourceId: stale.resourceId, defaultBranch: "main" } }, "repo-rebind-2"),
    ).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  });

  it("rejects binding to a resource registered under a different project", async () => {
    const { admin, otherProject, current } = await fixture();
    await expect(
      admin.projectUpdate(superadmin, otherProject.id, { repository: { owner: "acme-org", name: "current-app", resourceId: current.resourceId, defaultBranch: "main" } }, "repo-rebind-3"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a declared owner/name that does not match the referenced resource", async () => {
    const { admin, project, current } = await fixture();
    await expect(
      admin.projectUpdate(superadmin, project.id, { repository: { owner: "someone-else", name: "wrong-name", resourceId: current.resourceId, defaultBranch: "main" } }, "repo-rebind-4"),
    ).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  });
});
