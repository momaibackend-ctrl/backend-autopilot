import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createService } from "../../packages/core/src/runtime.js";
import type { CollectionExecutionResult } from "../../packages/http-runner/src/collection.js";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";
import type { Resource } from "../../packages/schemas/src/index.js";
import { SuperadminService } from "../../packages/superadmin/src/index.js";
import { FakeRepositoryProvider } from "../helpers/repository-provider.js";

const principal = { actor: "superadmin-test", role: "SUPERADMIN" as const };
const head = "b".repeat(40);
const older = "c".repeat(40);

// A tiny sandbox API that answers every route of both contracts below.
let api: Server;
let origin: string;
const received: string[] = [];

const rootContract = {
  openapi: "3.0.3",
  info: { title: "Product", version: "1.0.0" },
  paths: { "/health": { get: { responses: { "200": {} } } } },
};
const checkinContract = [
  "openapi: 3.1.0",
  "info: { title: Check-in, version: 1.0.0 }",
  "paths:",
  "  /checkins:",
  "    get: { responses: { '200': {} } }",
  "  /checkins/{id}:",
  "    $ref: './paths/checkin-by-id.yaml'",
].join("\n");
const collection = {
  info: { name: "Product smoke", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  item: [
    { name: "Health", request: { method: "GET", url: "{{baseUrl}}/health" }, event: [{ listen: "test", script: { exec: ["pm.response.to.have.status(200);"] } }] },
    { name: "Check-ins", request: { method: "GET", url: "{{baseUrl}}/checkins" }, event: [{ listen: "test", script: { exec: ["pm.response.to.have.status(200);"] } }] },
  ],
};
const files = {
  "openapi.json": JSON.stringify(rootContract),
  "contracts/checkin.yaml": checkinContract,
  "contracts/paths/checkin-by-id.yaml": "get:\n  responses:\n    '200': {}\n",
  "postman/smoke.postman_collection.json": JSON.stringify(collection),
};

beforeAll(async () => {
  api = createServer((request, response) => {
    received.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    const known = request.url === "/health" || request.url === "/checkins" || /^\/checkins\/[^/]+$/.test(request.url ?? "");
    response.statusCode = known ? 200 : 404;
    response.end(JSON.stringify({ ok: known }));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

async function setup(options: { treeTruncated?: boolean; withoutTree?: boolean } = {}) {
  const store = new MemoryStateStore();
  const service = createService({ store });
  const system = await service.projectCreate({ name: "System", slug: "system", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const project = await service.projectCreate({ name: "Product", slug: "product", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const other = await service.projectCreate({ name: "Other", slug: "other", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  // GITHUB_REPOSITORY resources come from the verified provider registration flow, never from
  // superadmin_resource_create; seeded directly here to mirror that path.
  const register = (projectId: string, reference: string, overrides: Partial<Resource> = {}) =>
    store.createResource({ resourceId: crypto.randomUUID(), type: "GITHUB_REPOSITORY", provider: "github", externalReference: reference, projectId, environment: "SANDBOX", permissions: ["READ", "WRITE"], status: "ACTIVE", secretRefs: [], createdAt: new Date().toISOString(), ...overrides });
  const repository = await register(project.id, "acme/product-backend");
  const foreign = await register(other.id, "acme/other-backend");
  const writeOnly = await register(project.id, "acme/write-only", { permissions: ["WRITE"] });
  const fake = new FakeRepositoryProvider({
    "acme/product-backend": { defaultBranch: "main", head, commits: [head, older], branches: [{ name: "java-port", sha: older }], files, ...(options.treeTruncated ? { treeTruncated: true } : {}) },
    "acme/other-backend": { defaultBranch: "main", head, commits: [head], files },
    "acme/write-only": { defaultBranch: "main", head, commits: [head], files },
  });
  if (options.withoutTree) (fake as unknown as { listTree?: unknown }).listTree = undefined;
  const admin = new SuperadminService({ store, service, systemProjectId: system.id, repositories: fake });
  const http = await service.resourceRegister({ projectId: project.id, type: "HTTP_API", provider: "http-discovery", externalReference: origin, environment: "SANDBOX", permissions: ["READ"], secretRefs: [] });
  return { store, admin, project, repository, foreign, writeOnly, http };
}

let counter = 0;
const operationId = () => `repository-discovery-${++counter}-${Date.now()}`;

describe("repository contract discovery through the superadmin service", () => {
  it("lists every contract and collection at the default branch commit", async () => {
    const { admin, project, repository } = await setup();
    const discovery = await admin.repositoryApiDiscovery(principal, project.id, { resourceId: repository.resourceId });
    expect(discovery.commitSha).toBe(head);
    expect(discovery.contracts.map((value) => [value.path, value.operations])).toEqual([
      ["openapi.json", 1],
      ["contracts/checkin.yaml", 2],
    ]);
    expect(discovery.collections).toEqual([{ path: "postman/smoke.postman_collection.json", name: "Product smoke", requestCount: 2 }]);
    expect(discovery.operations).toEqual([
      { method: "GET", path: "/health", contract: "openapi.json", secured: false },
      { method: "GET", path: "/checkins", contract: "contracts/checkin.yaml", secured: false },
      { method: "GET", path: "/checkins/{id}", contract: "contracts/checkin.yaml", secured: false },
    ]);
    expect(discovery.complete).toBe(true);
    const branch = await admin.repositoryApiDiscovery(principal, project.id, { resourceId: repository.resourceId, ref: "java-port" });
    expect(branch.commitSha).toBe(older);
  });

  it("imports the collection from the repository and measures the run against every contract", async () => {
    const { admin, project, repository, http, store } = await setup();
    const imported = (await admin.collectionImport(
      principal,
      project.id,
      { resourceId: http.resourceId, collectionSource: { resourceId: repository.resourceId, path: "postman/smoke.postman_collection.json" } },
      operationId(),
    )) as { value: { origin: { path: string; commitSha: string }; requestCount: number } };
    expect(imported.value.origin).toEqual({ path: "postman/smoke.postman_collection.json", commitSha: head });
    expect(imported.value.requestCount).toBe(2);

    const { value } = (await admin.collectionRun(principal, project.id, {
      resourceId: http.resourceId,
      contractRepository: { resourceId: repository.resourceId },
      operationId: operationId(),
    })) as { value: CollectionExecutionResult };
    expect(value.status).toBe("PASSED");
    expect(value.inventorySource).toBe("REPOSITORY");
    expect(value.inventoryCommitSha).toBe(head);
    expect(value.coverage.byContract).toEqual([
      { contract: "openapi.json", totalOperations: 1, coveredOperations: 1, coveragePercent: 100, status: "COMPLETE" },
      { contract: "contracts/checkin.yaml", totalOperations: 2, coveredOperations: 1, coveragePercent: 50, status: "INCOMPLETE" },
    ]);
    expect(value.verdict).toBe("NOT_PROVEN");
    expect(value.reasons).toEqual([
      "1 of 3 documented operations were not exercised by a passing request",
      "contracts not fully covered: contracts/checkin.yaml (1/2)",
    ]);
    const report = (await store.listArtifacts(project.id)).find((artifact) => artifact.id === value.executionId);
    expect(report?.content).toMatchObject({ inventorySource: "REPOSITORY", inventoryCommitSha: head });

    const coverage = await admin.apiCoverage(principal, project.id, { resourceId: http.resourceId, contractRepository: { resourceId: repository.resourceId } });
    expect(coverage.inventoryCommitSha).toBe(head);
    expect(coverage.drafts.map((draft) => draft.operation)).toEqual(["GET /checkins/{id}"]);
  });

  it("keeps a run NOT_PROVEN when the repository listing was truncated", async () => {
    const { admin, project, repository, http } = await setup({ treeTruncated: true });
    await admin.collectionImport(principal, project.id, { resourceId: http.resourceId, collectionSource: { resourceId: repository.resourceId, path: "postman/smoke.postman_collection.json" } }, operationId());
    const discovery = await admin.repositoryApiDiscovery(principal, project.id, { resourceId: repository.resourceId });
    expect(discovery.complete).toBe(false);
    const { value } = (await admin.collectionRun(principal, project.id, { resourceId: http.resourceId, contractRepository: { resourceId: repository.resourceId }, operationId: operationId() })) as { value: CollectionExecutionResult };
    expect(value.reasons.some((reason) => reason.startsWith("the API inventory is incomplete"))).toBe(true);
  });
});

describe("repository contract discovery security", () => {
  it("refuses another project's repository, a repository without READ and an unknown ref", async () => {
    const { admin, project, foreign, writeOnly, repository } = await setup();
    await expect(admin.repositoryApiDiscovery(principal, project.id, { resourceId: foreign.resourceId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(admin.repositoryApiDiscovery(principal, project.id, { resourceId: writeOnly.resourceId })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await expect(admin.repositoryApiDiscovery(principal, project.id, { resourceId: repository.resourceId, ref: "no-such-branch" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(admin.repositoryApiDiscovery(principal, project.id, { resourceId: repository.resourceId, ref: "d".repeat(40) })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses an HTTP_API resource as a contract repository and a non-superadmin caller", async () => {
    const { admin, project, http, repository } = await setup();
    await expect(admin.repositoryApiDiscovery(principal, project.id, { resourceId: http.resourceId })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await expect(admin.repositoryApiDiscovery({ actor: "operator", role: "PROJECT_OPERATOR" }, project.id, { resourceId: repository.resourceId })).rejects.toThrow();
  });

  it("refuses an import naming both or neither collection source, and a missing file", async () => {
    const { admin, project, http, repository } = await setup();
    await expect(admin.collectionImport(principal, project.id, { resourceId: http.resourceId }, operationId())).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await expect(
      admin.collectionImport(principal, project.id, { resourceId: http.resourceId, collection: collection, collectionSource: { resourceId: repository.resourceId, path: "postman/smoke.postman_collection.json" } }, operationId()),
    ).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await expect(
      admin.collectionImport(principal, project.id, { resourceId: http.resourceId, collectionSource: { resourceId: repository.resourceId, path: "missing.json" } }, operationId()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reports a runtime without tree listing as NOT_SUPPORTED instead of an empty inventory", async () => {
    const { admin, project, repository } = await setup({ withoutTree: true });
    await expect(admin.repositoryApiDiscovery(principal, project.id, { resourceId: repository.resourceId })).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });
});
