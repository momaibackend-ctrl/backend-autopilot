import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../packages/artifact-store/src/index.js";
import type { AutopilotService } from "../../packages/core/src/application.js";
import { systemClock, uuidGenerator } from "../../packages/core/src/ports.js";
import { createService } from "../../packages/core/src/runtime.js";
import {
  HttpCollectionRunner,
  extractApiOperations,
  type CollectionExecutionResult,
  type PostmanImportResult,
} from "../../packages/http-runner/src/collection.js";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";
import { SuperadminService } from "../../packages/superadmin/src/index.js";

const principal = { actor: "superadmin-test", role: "SUPERADMIN" as const };
const ACCESS_TOKEN = "fixture-access-token-value-7f3a";

// A small sandbox API with state, a login that hands out a bearer token, and every route the
// contract documents -- so a collection can either cover it completely or visibly fall short.
interface Fixture {
  server: Server;
  origin: string;
  requests: Array<{ method: string; url: string; authorization?: string }>;
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function startNotesApi(): Promise<Fixture> {
  const requests: Fixture["requests"] = [];
  const notes = new Map<string, Record<string, unknown>>();
  let next = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fixture");
      requests.push({
        method: request.method ?? "",
        url: `${url.pathname}${url.search}`,
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      });
      response.setHeader("content-type", "application/json");
      const send = (status: number, value?: unknown) => {
        response.statusCode = status;
        response.end(value === undefined ? "" : JSON.stringify(value));
      };
      if (request.method === "GET" && url.pathname === "/health") return send(200, { status: "UP" });
      if (request.method === "POST" && url.pathname === "/auth/login") {
        const input = await body(request);
        return input["user"] === "sandbox" ? send(200, { access_token: ACCESS_TOKEN, user_id: "user-42" }) : send(401, {});
      }
      if (!url.pathname.startsWith("/notes")) return send(404, { error: "not found" });
      if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) return send(401, { error: "unauthorized" });
      if (url.pathname === "/notes" && request.method === "GET") return send(200, [...notes.values()]);
      if (url.pathname === "/notes" && request.method === "POST") {
        const input = await body(request);
        const note = { id: `note-${++next}`, title: input["title"], owner: input["owner"] };
        notes.set(String(note.id), note);
        return send(201, note);
      }
      if (url.pathname === "/notes/search" && request.method === "GET") return send(200, { results: [...notes.values()] });
      const match = /^\/notes\/([^/]+)$/.exec(url.pathname);
      const note = match?.[1] ? notes.get(match[1]) : undefined;
      if (match && !note) return send(404, { error: "not found" });
      if (match && note && request.method === "GET") return send(200, note);
      if (match && note && request.method === "PUT") {
        Object.assign(note, await body(request));
        return send(200, note);
      }
      if (match && note && request.method === "DELETE") {
        notes.delete(String(note["id"]));
        return send(204);
      }
      return send(404, { error: "not found" });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

const contract = {
  openapi: "3.1.0",
  info: { title: "Notes", version: "1.0.0" },
  security: [{ bearer: [] }],
  paths: {
    "/health": { get: { security: [], responses: { "200": {} } } },
    "/auth/login": { post: { security: [], responses: { "200": {}, "401": {} } } },
    "/notes": { get: { responses: { "200": {} } }, post: { responses: { "201": {} } } },
    "/notes/search": { get: { responses: { "200": {} } } },
    "/notes/{noteId}": {
      get: { responses: { "200": {}, "404": {} } },
      put: { responses: { "200": {} } },
      delete: { responses: { "204": {} } },
    },
  },
};

function tests(...exec: string[]) {
  return { event: [{ listen: "test", script: { exec } }] };
}
function item(name: string, method: string, raw: string, extra: Record<string, unknown> = {}, ...script: string[]) {
  return { name, request: { method, url: { raw }, ...extra }, ...tests(...script) };
}

// The full collection: the login lives in its own folder, so the Notes scenario can only pass
// if the token extracted in the Auth scenario carries over -- exactly a Postman collection run.
const fullCollection = {
  info: { name: "Notes full", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  variable: [{ key: "baseUrl", value: "http://localhost:8080" }],
  item: [
    item("Health", "GET", "{{baseUrl}}/health", {}, "pm.response.to.have.status(200);"),
    {
      name: "Auth",
      item: [
        item(
          "Login",
          "POST",
          "{{baseUrl}}/auth/login",
          { body: { mode: "raw", raw: '{"user":"sandbox"}' } },
          "var jsonData = pm.response.json();",
          "pm.response.to.have.status(200);",
          'pm.environment.set("accessToken", jsonData.access_token);',
          'pm.environment.set("userId", jsonData.user_id);',
        ),
      ],
    },
    {
      name: "Notes",
      auth: { type: "bearer", bearer: [{ key: "token", value: "{{accessToken}}" }] },
      item: [
        item(
          "Create",
          "POST",
          "{{baseUrl}}/notes",
          { body: { mode: "raw", raw: '{"title":"from collection","owner":"{{userId}}"}' } },
          "pm.response.to.have.status(201);",
          'pm.environment.set("noteId", pm.response.json().id);',
        ),
        item("List", "GET", "{{baseUrl}}/notes", {}, "pm.response.to.have.status(200);"),
        item("Search", "GET", "{{baseUrl}}/notes/search", {}, "pm.response.to.have.status(200);"),
        item(
          "Read",
          "GET",
          "{{baseUrl}}/notes/{{noteId}}",
          {},
          "const note = pm.response.json();",
          "pm.response.to.have.status(200);",
          "pm.expect(note.owner).to.eql('user-42');",
        ),
        item("Update", "PUT", "{{baseUrl}}/notes/{{noteId}}", { body: { mode: "raw", raw: '{"title":"renamed"}' } }, "pm.response.to.have.status(200);"),
        item("Delete", "DELETE", "{{baseUrl}}/notes/{{noteId}}", {}, "pm.response.to.have.status(204);"),
        item("Read deleted", "GET", "{{baseUrl}}/notes/{{noteId}}", {}, "pm.response.to.have.status(404);"),
      ],
    },
  ],
};

// The shape of the reported gap: health, auth refusal and a 404 -- all green, nothing else.
const smokeCollection = {
  info: { name: "Smoke only" },
  item: [
    item("Health", "GET", "/health", {}, "pm.response.to.have.status(200);"),
    item("No token", "GET", "/notes", {}, "pm.response.to.have.status(401);"),
    item("Unknown route", "GET", "/nope", {}, "pm.response.to.have.status(404);"),
  ],
};

let api: Fixture;
let store: MemoryStateStore;
let service: AutopilotService;
let admin: SuperadminService;
let counter = 0;
const operationId = () => `collection-runner-${++counter}-${Date.now()}`;

beforeAll(async () => {
  api = await startNotesApi();
  store = new MemoryStateStore();
  service = createService({ store });
  admin = new SuperadminService({ store, service, systemProjectId: "00000000-0000-4000-8000-000000000000" });
  await service.projectCreate({
    id: "00000000-0000-4000-8000-000000000000",
    name: "System",
    slug: "system",
    sourceType: "LOCAL",
    environment: "SANDBOX",
    autonomyMode: "AUTONOMOUS_STAGING",
    workspacePath: "tests/.tmp/system",
  } as never);
});

afterAll(async () => {
  await new Promise<void>((resolve) => api.server.close(() => resolve()));
});

async function project() {
  return service.projectCreate({
    name: `Collection ${++counter}`,
    slug: `collection-${counter}-${Date.now()}`,
    sourceType: "LOCAL",
    environment: "SANDBOX",
    autonomyMode: "AUTONOMOUS_STAGING",
    workspacePath: `tests/.tmp/collection-${counter}`,
  });
}

async function resource(projectId: string, externalReference = api.origin) {
  return service.resourceRegister({
    projectId,
    type: "HTTP_API",
    provider: `http-collection-${++counter}`,
    externalReference,
    environment: "SANDBOX",
    permissions: ["READ"],
    secretRefs: [],
  });
}

async function importCollection(projectId: string, resourceId: string, collection: unknown) {
  return (await admin.collectionImport(principal, projectId, { resourceId, collection }, operationId())) as {
    value: Omit<PostmanImportResult, "scenarios"> & { scenarios: Array<{ scenarioId: string; name: string; steps: number }> };
    idempotentReplay: boolean;
  };
}

async function runCollection(projectId: string, resourceId: string, extra: { openapi?: unknown; scenarioIds?: string[]; operationId?: string } = {}) {
  return (await admin.collectionRun(principal, projectId, { resourceId, operationId: extra.operationId ?? operationId(), ...extra })) as {
    value: CollectionExecutionResult;
    idempotentReplay: boolean;
  };
}

describe("whole API collection", () => {
  it("imports a full Postman collection and proves it against the whole contract", async () => {
    const target = await project();
    const http = await resource(target.id);
    const imported = await importCollection(target.id, http.resourceId, fullCollection);
    expect(imported.value.scenarios.map((value) => [value.name, value.steps])).toEqual([
      ["Notes full", 1],
      ["Auth", 1],
      ["Notes", 7],
    ]);
    expect(imported.value.skipped).toEqual([]);

    const { value } = await runCollection(target.id, http.resourceId, { openapi: contract });
    expect(value.scenarios.map((scenario) => scenario.status)).toEqual(["PASSED", "PASSED", "PASSED"]);
    expect(value.status).toBe("PASSED");
    expect(value.coverage).toMatchObject({ status: "COMPLETE", totalOperations: 8, coveredOperations: 8, coveragePercent: 100 });
    expect(value.verdict).toBe("PROVEN");
    expect(value.reasons).toEqual([]);
    expect(value.summary).toMatchObject({ scenarios: 3, passedScenarios: 3, requests: 9, passedRequests: 9 });
    expect(value.inventorySource).toBe("INLINE");
    // The token from the Auth scenario authenticated the Notes scenario.
    expect(api.requests.some((entry) => entry.url === "/notes/search" && entry.authorization === `Bearer ${ACCESS_TOKEN}`)).toBe(true);

    const artifacts = await store.listArtifacts(target.id);
    const report = artifacts.find((artifact) => artifact.id === value.executionId);
    expect(report?.kind).toBe("VALIDATION_REPORT");
    expect(report?.content).toMatchObject({ suite: "COLLECTION", result: "PASS", verdict: "PROVEN" });
    const perScenario = artifacts.filter(
      (artifact) => artifact.kind === "VALIDATION_REPORT" && (artifact.content as { suite?: string }).suite === "SCENARIO",
    );
    expect(perScenario).toHaveLength(3);
    const audit = await store.listAudit(target.id);
    expect(audit.map((event) => event.action)).toEqual(expect.arrayContaining(["mcp.collection_import", "mcp.collection_run"]));
    for (const persisted of [JSON.stringify(artifacts), JSON.stringify(audit), JSON.stringify(value)])
      expect(persisted).not.toContain(ACCESS_TOKEN);
  });

  it("reports a green smoke-only collection as NOT_PROVEN with every uncovered operation", async () => {
    const target = await project();
    const http = await resource(target.id);
    await importCollection(target.id, http.resourceId, smokeCollection);
    const { value } = await runCollection(target.id, http.resourceId, { openapi: contract });
    expect(value.status).toBe("PASSED");
    expect(value.verdict).toBe("NOT_PROVEN");
    expect(value.coverage).toMatchObject({ status: "INCOMPLETE", totalOperations: 8, coveredOperations: 2 });
    expect(value.coverage.uncovered.map((op) => `${op.method} ${op.path}`)).toEqual([
      "POST /auth/login",
      "POST /notes",
      "GET /notes/search",
      "GET /notes/{noteId}",
      "PUT /notes/{noteId}",
      "DELETE /notes/{noteId}",
    ]);
    expect(value.coverage.undocumented.map((entry) => entry.path)).toEqual(["/nope"]);
    expect(value.reasons).toEqual(["6 of 8 documented operations were not exercised by a passing request"]);
    const report = (await store.listArtifacts(target.id)).find((artifact) => artifact.id === value.executionId);
    expect(report?.content).toMatchObject({ result: "FAIL", verdict: "NOT_PROVEN" });
    expect(value.humanSummary).toMatch(/НЕ доказана/);
  });

  it("lists the missing operations with drafts before anything runs, read-only", async () => {
    const target = await project();
    const http = await resource(target.id);
    await importCollection(target.id, http.resourceId, smokeCollection);
    const auditBefore = (await store.listAudit(target.id)).length;
    const requestsBefore = api.requests.length;
    const coverage = await admin.apiCoverage(principal, target.id, { resourceId: http.resourceId, openapi: contract });
    expect(coverage.coverage.basis).toBe("DECLARED");
    expect(coverage.coverage.uncoveredOperations).toBe(6);
    expect(coverage.drafts.map((draft) => draft.step.path)).toEqual([
      "/auth/login",
      "/notes",
      "/notes/search",
      "/notes/{{note_id}}",
      "/notes/{{note_id}}",
      "/notes/{{note_id}}",
    ]);
    expect((await store.listAudit(target.id)).length).toBe(auditBefore);
    expect(api.requests.length).toBe(requestsBefore);
  });

  it("uses the project's latest API_CONTRACT artifact when no document is supplied", async () => {
    const target = await project();
    const http = await resource(target.id);
    await importCollection(target.id, http.resourceId, fullCollection);
    await new ArtifactStore(store, uuidGenerator, systemClock).write(target.id, "API_CONTRACT", {
      contracts: [{ path: "openapi.json", document: contract }],
    });
    const { value } = await runCollection(target.id, http.resourceId);
    expect(value.inventorySource).toBe("API_CONTRACT");
    expect(value.verdict).toBe("PROVEN");
  });

  it("never proves a collection without an inventory", async () => {
    const target = await project();
    const http = await resource(target.id);
    await importCollection(target.id, http.resourceId, fullCollection);
    const { value } = await runCollection(target.id, http.resourceId);
    expect(value.status).toBe("PASSED");
    expect(value.inventorySource).toBe("NONE");
    expect(value.coverage.status).toBe("NO_INVENTORY");
    expect(value.verdict).toBe("NOT_PROVEN");
  });

  it("runs only the requested scenarios, in the requested order", async () => {
    const target = await project();
    const http = await resource(target.id);
    const imported = await importCollection(target.id, http.resourceId, fullCollection);
    const [health, auth] = imported.value.scenarios;
    const { value } = await runCollection(target.id, http.resourceId, {
      scenarioIds: [auth?.scenarioId ?? "", health?.scenarioId ?? ""],
      openapi: contract,
    });
    expect(value.scenarios.map((scenario) => scenario.scenarioName)).toEqual(["Auth", "Notes full"]);
    expect(value.coverage.coveredOperations).toBe(2);
    expect(value.verdict).toBe("NOT_PROVEN");
  });

  it("records a scenario that stops on a missing variable without hiding the others", async () => {
    const target = await project();
    const http = await resource(target.id);
    const imported = await importCollection(target.id, http.resourceId, fullCollection);
    const notes = imported.value.scenarios.find((value) => value.name === "Notes");
    // Without the Auth scenario first, the bearer variable does not exist.
    const { value } = await runCollection(target.id, http.resourceId, { scenarioIds: [notes?.scenarioId ?? ""], openapi: contract });
    expect(value.scenarios[0]?.status).toBe("ERROR");
    expect(value.status).toBe("ERROR");
    expect(value.coverage.uncovered.find((op) => op.method === "POST" && op.path === "/notes")?.reason).toBe("NOT_PASSING");
    expect(value.reasons[0]).toBe("1 of 1 scenarios did not pass");
  });

  it("replays an operationId instead of re-sending the collection", async () => {
    const target = await project();
    const http = await resource(target.id);
    await importCollection(target.id, http.resourceId, smokeCollection);
    const replay = operationId();
    const first = await runCollection(target.id, http.resourceId, { openapi: contract, operationId: replay });
    const before = api.requests.length;
    const second = await runCollection(target.id, http.resourceId, { openapi: contract, operationId: replay });
    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(api.requests.length).toBe(before);
    const imported = await importCollection(target.id, http.resourceId, smokeCollection);
    expect(imported.value.scenarios).toHaveLength(1);
  });

  it("records scenarios not started within the collection budget as SKIPPED", async () => {
    const target = await project();
    const http = await resource(target.id);
    await importCollection(target.id, http.resourceId, fullCollection);
    const value = await new HttpCollectionRunner({
      store,
      artifacts: new ArtifactStore(store, uuidGenerator, systemClock),
      clock: systemClock,
      maxCollectionDurationMs: -1,
    }).run({
      projectId: target.id,
      resourceId: http.resourceId,
      operationId: operationId(),
      actor: principal.actor,
      inventory: extractApiOperations(contract),
      inventorySource: "INLINE",
    });
    expect(value.scenarios.every((scenario) => scenario.status === "SKIPPED")).toBe(true);
    expect(value.status).toBe("FAILED");
    expect(value.verdict).toBe("NOT_PROVEN");
    expect(value.reasons).toContain("3 of 3 scenarios were not started within the collection budget; run them with scenarioIds");
  });
});

describe("whole API collection security", () => {
  it("requires the SUPERADMIN role for import, run and coverage", async () => {
    const target = await project();
    const http = await resource(target.id);
    const operator = { actor: "operator", role: "PROJECT_OPERATOR" as const };
    await expect(admin.collectionImport(operator, target.id, { resourceId: http.resourceId, collection: smokeCollection }, operationId())).rejects.toThrow();
    await expect(admin.collectionRun(operator, target.id, { resourceId: http.resourceId, operationId: operationId() })).rejects.toThrow();
    await expect(admin.apiCoverage(operator, target.id, {})).rejects.toThrow();
  });

  it("refuses a resource or scenario that belongs to another project or resource", async () => {
    const owner = await project();
    const ownerApi = await resource(owner.id);
    const imported = await importCollection(owner.id, ownerApi.resourceId, smokeCollection);
    const intruder = await project();
    const intruderApi = await resource(intruder.id);
    const before = api.requests.length;
    await expect(runCollection(intruder.id, ownerApi.resourceId)).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await expect(
      runCollection(intruder.id, intruderApi.resourceId, { scenarioIds: [imported.value.scenarios[0]?.scenarioId ?? ""] }),
    ).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await expect(importCollection(intruder.id, ownerApi.resourceId, smokeCollection)).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(api.requests.length).toBe(before);
  });

  it("refuses production and a resource with no saved scenarios", async () => {
    // Production projects cannot be created any more; a record that predates the rule still
    // has to be refused, so it is written straight to the store.
    const production = await project();
    const productionApi = await resource(production.id);
    await store.updateProject({ ...production, environment: "PRODUCTION" });
    await expect(runCollection(production.id, productionApi.resourceId)).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    const empty = await project();
    const emptyApi = await resource(empty.id);
    await expect(runCollection(empty.id, emptyApi.resourceId)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("refuses an oversized or malformed inline document before any request is sent", async () => {
    const target = await project();
    const http = await resource(target.id);
    await importCollection(target.id, http.resourceId, smokeCollection);
    const before = api.requests.length;
    await expect(runCollection(target.id, http.resourceId, { openapi: "{not json" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(runCollection(target.id, http.resourceId, { openapi: { hello: "world" } })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(runCollection(target.id, http.resourceId, { openapi: "x".repeat(5 * 1024 * 1024) })).rejects.toMatchObject({
      code: "POLICY_VIOLATION",
    });
    expect(api.requests.length).toBe(before);
  });
});
