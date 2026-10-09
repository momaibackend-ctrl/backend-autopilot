import { describe, expect, it } from "vitest";
import { createService } from "../../packages/core/src/runtime.js";
import type { ExecutionJob } from "../../packages/schemas/src/index.js";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";
import { SuperadminService } from "../../packages/superadmin/src/index.js";
import { FakeRepositoryProvider } from "../helpers/repository-provider.js";

const principal = { actor: "superadmin-test", role: "SUPERADMIN" as const };
const head = "4".repeat(40);
let counter = 0;
const operationId = () => `repository-register-${++counter}-${Date.now()}`;

async function setup(options: { withoutProvider?: boolean } = {}) {
  const store = new MemoryStateStore();
  const service = createService({ store });
  const system = await service.projectCreate({ name: "System", slug: "system", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const project = await service.projectCreate({ name: "Momna-like", slug: "product", sourceType: "MCP", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const other = await service.projectCreate({ name: "Other", slug: "other", sourceType: "MCP", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const repositories = new FakeRepositoryProvider({
    "acme/backend-java": {
      defaultBranch: "main",
      head,
      commits: [head],
      visibility: "private",
      permissions: { admin: true },
      files: { "pom.xml": "<project><groupId>org.springframework.boot</groupId></project>", "openapi.yaml": "openapi: 3.0.0\npaths:\n  /health:\n    get:\n      responses:\n        '200': {}\n" },
    },
    "acme/public-repo": { defaultBranch: "main", head, commits: [head], visibility: "public", permissions: { admin: true } },
    "acme/no-admin": { defaultBranch: "main", head, commits: [head], visibility: "private", permissions: { admin: false } },
    "acme/old-name": { defaultBranch: "main", head, commits: [head], visibility: "private", permissions: { admin: true }, reportedIdentity: "acme/new-name" },
  });
  const dispatched: ExecutionJob[] = [];
  const admin = new SuperadminService({
    store,
    service,
    systemProjectId: system.id,
    ...(options.withoutProvider ? {} : { repositories }),
    httpE2eDispatcher: { dispatch: async (job) => (dispatched.push(job), {}) },
  });
  return { store, service, admin, project, other, dispatched };
}

const register = (context: Awaited<ReturnType<typeof setup>>, repository: string, extra: { access?: "READ" | "FULL"; projectId?: string; operationId?: string } = {}) =>
  context.admin.repositoryRegister(principal, extra.projectId ?? context.project.id, { repository, access: extra.access ?? "READ" }, extra.operationId ?? operationId()) as Promise<{ value: { resourceId: string; repository: string; permissions: string[]; alreadyRegistered: boolean; upgraded?: boolean }; idempotentReplay: boolean }>;

describe("verified repository registration through the superadmin MCP", () => {
  it("registers a private repository the identity administers, with its namespace, and replays by operationId", async () => {
    const context = await setup();
    const replay = operationId();
    const first = await register(context, "acme/backend-java", { operationId: replay });
    expect(first.value).toMatchObject({ repository: "acme/backend-java", visibility: "private", permissions: ["READ"], alreadyRegistered: false });
    const resources = await context.store.listResources(context.project.id);
    expect(resources.map((resource) => [resource.type, resource.externalReference, resource.environment])).toEqual([
      ["GITHUB_ACCOUNT", "acme", "SANDBOX"],
      ["GITHUB_REPOSITORY", "acme/backend-java", "SANDBOX"],
    ]);
    expect((await register(context, "acme/backend-java", { operationId: replay })).idempotentReplay).toBe(true);
    expect((await register(context, "acme/backend-java")).value).toMatchObject({ alreadyRegistered: true, resourceId: first.value.resourceId });
    expect((await context.store.listAudit(context.project.id)).map((event) => event.action)).toContain("mcp.repository_register");
  });

  it("upgrades a READ registration to FULL only through the same verification", async () => {
    const context = await setup();
    const first = await register(context, "acme/backend-java");
    const upgraded = await register(context, "acme/backend-java", { access: "FULL" });
    expect(upgraded.value).toMatchObject({ resourceId: first.value.resourceId, permissions: ["READ", "WRITE", "ADMIN"], upgraded: true });
  });

  it("makes the repository immediately usable: plan, then a dispatched HTTP E2E job", async () => {
    const context = await setup();
    const { value } = await register(context, "acme/backend-java");
    const plan = await context.admin.environmentPlan(principal, context.project.id, { resourceId: value.resourceId });
    expect(plan).toMatchObject({ commitSha: head, executable: true, plan: { stack: { buildTool: "MAVEN", framework: "SPRING_BOOT" } } });
    const task = await context.service.taskCreate({ projectId: context.project.id, externalKey: "VERIFY-JAVA", title: "Полная интеграционная проверка Java", description: "d", requirements: ["r"], relationships: [] });
    const job = (await context.admin.httpE2eRun(principal, context.project.id, { taskId: task.id, repositoryResourceId: value.resourceId, scenarioSource: { kind: "REPOSITORY" }, operationId: operationId() })) as { value: ExecutionJob };
    expect(job.value).toMatchObject({ kind: "HTTP_E2E", status: "DISPATCHED", baseCommitSha: head });
    expect(context.dispatched).toHaveLength(1);
  });

  it("accepts a public repository and names its visibility", async () => {
    const context = await setup();
    const { value } = await register(context, "acme/public-repo");
    expect(value).toMatchObject({ repository: "acme/public-repo", visibility: "public", alreadyRegistered: false });
    const audit = (await context.store.listAudit(context.project.id)).find((event) => event.action === "mcp.repository_register");
    expect(JSON.stringify(audit?.result)).toContain('"visibility":"public"');
  });

  it("refuses a repository without ADMIN, an old name, a missing one and a malformed name", async () => {
    const context = await setup();
    await expect(register(context, "acme/no-admin")).rejects.toMatchObject({ code: "POLICY_VIOLATION", details: { remediation: expect.stringContaining("Admin role") } });
    await expect(register(context, "acme/old-name")).rejects.toMatchObject({ code: "POLICY_VIOLATION", message: "The repository is now named acme/new-name; register it under its current name" });
    await expect(register(context, "acme/missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(register(context, "https://github.com/acme/backend-java")).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(await context.store.listResources(context.project.id)).toEqual([]);
  });

  it("refuses a repository already registered to another project, a non-superadmin, and a runtime without verification", async () => {
    const context = await setup();
    await register(context, "acme/backend-java", { projectId: context.other.id });
    await expect(register(context, "acme/backend-java")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(context.admin.repositoryRegister({ actor: "operator", role: "PROJECT_OPERATOR" }, context.project.id, { repository: "acme/backend-java", access: "READ" }, operationId())).rejects.toThrow();
    const bare = await setup({ withoutProvider: true });
    await expect(register(bare, "acme/backend-java")).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });

  it("still refuses an unverified Git binding through the generic resource tool, and names the verified one", async () => {
    const context = await setup();
    // resourceCreate refuses synchronously, before any mutation starts.
    await expect(
      (async () => context.admin.resourceCreate(principal, { projectId: context.project.id, type: "GITHUB_REPOSITORY", provider: "github", externalReference: "acme/backend-java", environment: "SANDBOX", permissions: ["READ"], secretRefs: [] }, operationId()))(),
    ).rejects.toMatchObject({ code: "POLICY_VIOLATION", message: expect.stringContaining("superadmin_repository_register") });
  });
});
