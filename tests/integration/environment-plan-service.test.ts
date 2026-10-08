import { describe, expect, it } from "vitest";
import { createService } from "../../packages/core/src/runtime.js";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";
import type { Resource } from "../../packages/schemas/src/index.js";
import { SuperadminService } from "../../packages/superadmin/src/index.js";
import { FakeRepositoryProvider } from "../helpers/repository-provider.js";

const principal = { actor: "superadmin-test", role: "SUPERADMIN" as const };
const head = "e".repeat(40);
const port = "f".repeat(40);

async function setup() {
  const store = new MemoryStateStore();
  const service = createService({ store });
  const system = await service.projectCreate({ name: "System", slug: "system", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const project = await service.projectCreate({ name: "Product", slug: "product", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const other = await service.projectCreate({ name: "Other", slug: "other", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  // GITHUB_REPOSITORY resources come from the verified provider registration flow; seeded here.
  const register = (projectId: string, reference: string, overrides: Partial<Resource> = {}) =>
    store.createResource({ resourceId: crypto.randomUUID(), type: "GITHUB_REPOSITORY", provider: "github", externalReference: reference, projectId, environment: "SANDBOX", permissions: ["READ"], status: "ACTIVE", secretRefs: [], createdAt: new Date().toISOString(), ...overrides });
  const kotlin = await register(project.id, "acme/backend-kotlin");
  const monorepo = await register(project.id, "acme/backend-monorepo");
  const foreign = await register(other.id, "acme/foreign");
  const production = await register(project.id, "acme/backend-production", { environment: "PRODUCTION" });
  const repositories = new FakeRepositoryProvider({
    "acme/backend-kotlin": {
      defaultBranch: "main",
      head,
      commits: [head],
      files: {
        "build.gradle.kts": 'plugins { id("org.springframework.boot"); kotlin("jvm") }\ndependencies { runtimeOnly("org.postgresql:postgresql") }',
        gradlew: "",
      },
    },
    "acme/backend-monorepo": {
      defaultBranch: "main",
      head,
      commits: [head],
      branches: [{ name: "java-port", sha: port }],
      files: { "kotlin/build.gradle.kts": 'plugins { id("org.springframework.boot") }', "java/pom.xml": "<project><groupId>org.springframework.boot</groupId></project>" },
    },
    "acme/foreign": { defaultBranch: "main", head, commits: [head], files: {} },
    "acme/backend-production": { defaultBranch: "main", head, commits: [head], files: {} },
  });
  const admin = new SuperadminService({ store, service, systemProjectId: system.id, repositories });
  return { admin, project, kotlin, monorepo, foreign, production };
}

describe("environment plan through the superadmin service", () => {
  it("plans the registered repository at its default branch commit", async () => {
    const { admin, project, kotlin } = await setup();
    const value = await admin.environmentPlan(principal, project.id, { resourceId: kotlin.resourceId });
    expect(value.commitSha).toBe(head);
    expect(value.executable).toBe(true);
    expect(value.plan.stack).toMatchObject({ language: "KOTLIN", buildTool: "GRADLE", framework: "SPRING_BOOT" });
    expect(value.plan.dependencies.map((dependency) => dependency.kind)).toEqual(["POSTGRES"]);
    expect(JSON.stringify(value)).not.toMatch(/password"\s*:\s*"(?!\{\{)/i);
  });

  it("asks for the application root in a repository with several, and plans the one requested", async () => {
    const { admin, project, monorepo } = await setup();
    const ambiguous = await admin.environmentPlan(principal, project.id, { resourceId: monorepo.resourceId });
    expect(ambiguous.executable).toBe(false);
    expect(ambiguous.plan.unresolved[0]?.field).toBe("root");
    const java = await admin.environmentPlan(principal, project.id, { resourceId: monorepo.resourceId, root: "java" });
    expect(java.executable).toBe(true);
    expect(java.plan.stack.buildTool).toBe("MAVEN");
  });

  it("refuses another project's, a production or a non-repository resource, and a non-superadmin", async () => {
    const { admin, project, foreign, production } = await setup();
    await expect(admin.environmentPlan(principal, project.id, { resourceId: foreign.resourceId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(admin.environmentPlan(principal, project.id, { resourceId: production.resourceId })).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    await expect(admin.environmentPlan({ actor: "operator", role: "PROJECT_OPERATOR" }, project.id, { resourceId: production.resourceId })).rejects.toThrow();
  });
});
