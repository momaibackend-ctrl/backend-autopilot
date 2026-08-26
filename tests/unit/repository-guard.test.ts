import { describe, expect, it } from "vitest";
import { requireProjectGithubRepository } from "../../packages/core/src/repository-guard.js";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";
import type { Project, Resource } from "../../packages/schemas/src/index.js";

const now = "2026-01-01T00:00:00.000Z";
function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "P",
    slug: "p",
    sourceType: "TEST",
    environment: "SANDBOX",
    autonomyMode: "GUARDED",
    status: "ACTIVE",
    workspacePath: "",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
function resource(overrides: Partial<Resource> = {}): Resource {
  return {
    resourceId: "22222222-2222-2222-2222-222222222222",
    type: "GITHUB_REPOSITORY",
    provider: "github",
    externalReference: "owner/repo",
    projectId: "11111111-1111-1111-1111-111111111111",
    environment: "SANDBOX",
    permissions: ["READ", "WRITE"],
    status: "ACTIVE",
    secretRefs: [],
    createdAt: now,
    ...overrides,
  };
}

async function seeded(resourceOverrides: Partial<Resource> = {}) {
  const store = new MemoryStateStore();
  const p = await store.createProject(project());
  const r = await store.createResource(resource(resourceOverrides));
  return { store, project: p, resource: r };
}

describe("requireProjectGithubRepository", () => {
  it("returns the resource on the happy path", async () => {
    const { store, project, resource } = await seeded();
    const found = await requireProjectGithubRepository(store, project.id, resource.resourceId);
    expect(found.resourceId).toBe(resource.resourceId);
  });

  it("rejects an unknown resourceId", async () => {
    const { store, project } = await seeded();
    await expect(
      requireProjectGithubRepository(store, project.id, "99999999-9999-9999-9999-999999999999"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a resource belonging to a different project", async () => {
    const { store, resource } = await seeded();
    await expect(
      requireProjectGithubRepository(store, "33333333-3333-3333-3333-333333333333", resource.resourceId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a disabled resource -- the exact protection that should have blocked the stale repository", async () => {
    const { store, project, resource } = await seeded({ status: "DISABLED" });
    await expect(
      requireProjectGithubRepository(store, project.id, resource.resourceId),
    ).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  });

  it("rejects a non-GitHub-repository resource", async () => {
    const { store, project, resource } = await seeded({ type: "DATABASE", provider: "supabase" });
    await expect(
      requireProjectGithubRepository(store, project.id, resource.resourceId),
    ).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  });
});
