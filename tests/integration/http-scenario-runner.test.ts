import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createService } from "../../packages/core/src/runtime.js";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";
import { SuperadminService } from "../../packages/superadmin/src/index.js";
import type { AutopilotService } from "../../packages/core/src/application.js";
import type {
  ScenarioExecutionResult,
  SecretResolver,
} from "../../packages/http-runner/src/index.js";
import type {
  Environment,
  ValidationScenarioStep,
} from "../../packages/schemas/src/index.js";

const principal = { actor: "superadmin-test", role: "SUPERADMIN" as const };

interface Fixture {
  server: Server;
  origin: string;
  requests: Array<{ method: string; url: string; authorization?: string }>;
}

async function startFixture(otherOrigin: () => string): Promise<Fixture> {
  const requests: Fixture["requests"] = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      ...(request.headers.authorization
        ? { authorization: request.headers.authorization }
        : {}),
    });
    response.setHeader("content-type", "application/json");
    const url = request.url ?? "";
    if (url === "/redirect-external") {
      response.writeHead(302, { location: `${otherOrigin()}/stolen` });
      response.end();
      return;
    }
    if (url === "/redirect-internal") {
      response.writeHead(302, { location: "/ok" });
      response.end();
      return;
    }
    if (url === "/ok") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url === "/slow") {
      setTimeout(() => response.end(JSON.stringify({ ok: true })), 300);
      return;
    }
    if (url === "/protected") {
      response.statusCode =
        request.headers.authorization === "Bearer resource-secret-value"
          ? 200
          : 401;
      response.end(JSON.stringify({ seen: Boolean(request.headers.authorization) }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${address.port}`, requests };
}

let fixture: Fixture;
let decoy: Fixture;
let closedPort: number;
let store: MemoryStateStore;
let service: AutopilotService;
let admin: SuperadminService;

const secrets: SecretResolver = {
  async get(reference) {
    if (reference === "SANDBOX_API_TOKEN") return "resource-secret-value";
    throw new Error("unknown secret reference");
  },
};

beforeAll(async () => {
  decoy = await startFixture(() => "http://127.0.0.1:1");
  fixture = await startFixture(() => decoy.origin);
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  store = new MemoryStateStore();
  service = createService({ store });
  admin = new SuperadminService({
    store,
    service,
    systemProjectId: "00000000-0000-4000-8000-000000000000",
    secrets,
  });
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
  await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  await new Promise<void>((resolve) => decoy.server.close(() => resolve()));
});

let counter = 0;
const operationId = () => `scenario-runner-${++counter}-${Date.now()}`;

async function project(
  environment: Environment = "SANDBOX",
  autonomyMode: "AUTONOMOUS_STAGING" | "GUARDED" = "AUTONOMOUS_STAGING",
) {
  return service.projectCreate({
    name: `Runner ${++counter}`,
    slug: `runner-${counter}-${Date.now()}`,
    sourceType: "LOCAL",
    environment,
    autonomyMode,
    workspacePath: `tests/.tmp/runner-${counter}`,
  });
}

async function resource(
  projectId: string,
  externalReference: string,
  secretRefs: string[] = [],
) {
  return service.resourceRegister({
    projectId,
    type: "HTTP_API",
    // Resource identity is globally unique on (provider, externalReference); every fixture
    // resource points at the same loopback origin, so the provider label carries the identity.
    provider: `http-${++counter}`,
    externalReference,
    environment: "SANDBOX",
    permissions: ["READ"],
    secretRefs,
  });
}

async function scenario(
  projectId: string,
  resourceId: string,
  steps: Array<Partial<ValidationScenarioStep> & { name: string; method: ValidationScenarioStep["method"]; path: string }>,
) {
  const created = (await admin.scenarioCreate(
    principal,
    projectId,
    { resourceId, name: "Runner scenario", description: "", steps, operationId: operationId() },
    operationId(),
  )) as { value: { id: string } };
  return created.value.id;
}

async function run(projectId: string, scenarioId: string) {
  const result = (await admin.scenarioRun(principal, projectId, {
    scenarioId,
    operationId: operationId(),
  })) as { value: ScenarioExecutionResult; idempotentReplay: boolean };
  return result;
}

describe("executable HTTP scenario runner", () => {
  it("records a FAILED execution when the expected status does not match", async () => {
    const target = await project();
    const api = await resource(target.id, fixture.origin);
    const id = await scenario(target.id, api.resourceId, [
      { name: "Missing resource", method: "GET", path: "/nope", expectedStatus: 200 },
      { name: "Never reached", method: "GET", path: "/ok", expectedStatus: 200 },
    ]);
    const { value } = await run(target.id, id);
    expect(value.status).toBe("FAILED");
    expect(value.steps[0]?.status).toBe("FAILED");
    expect(value.steps[0]?.httpStatus).toBe(404);
    expect(value.steps[0]?.expectedStatus).toBe(200);
    expect(value.steps[1]?.status).toBe("SKIPPED");
    expect(value.summary).toMatchObject({
      totalSteps: 2,
      passedSteps: 0,
      failedSteps: 1,
      skippedSteps: 1,
    });
  });

  it("records a deterministic ERROR execution when the server is unreachable", async () => {
    const target = await project();
    const api = await resource(target.id, `http://127.0.0.1:${closedPort}`);
    const id = await scenario(target.id, api.resourceId, [
      { name: "Unreachable", method: "GET", path: "/ok", expectedStatus: 200 },
    ]);
    const { value } = await run(target.id, id);
    expect(value.status).toBe("ERROR");
    expect(value.steps[0]?.status).toBe("ERROR");
    expect(value.steps[0]?.error?.code).toBe("EXECUTION_FAILED");
    expect(value.steps[0]?.httpStatus).toBeUndefined();
  });

  it("rejects a forbidden target before any request is attempted", async () => {
    const target = await project();
    const api = await resource(target.id, "https://169.254.169.254");
    const id = await scenario(target.id, api.resourceId, [
      { name: "Metadata", method: "GET", path: "/latest/meta-data", expectedStatus: 200 },
    ]);
    await expect(run(target.id, id)).rejects.toMatchObject({
      code: "POLICY_VIOLATION",
    });
    expect(
      (await store.listArtifacts(target.id)).filter(
        (artifact) => artifact.kind === "VALIDATION_REPORT",
      ),
    ).toHaveLength(0);
  });

  it("blocks a cross-origin redirect and follows a same-origin one", async () => {
    const target = await project();
    const api = await resource(target.id, fixture.origin);
    const blocked = await scenario(target.id, api.resourceId, [
      { name: "External redirect", method: "GET", path: "/redirect-external", expectedStatus: 200 },
    ]);
    const blockedRun = await run(target.id, blocked);
    expect(blockedRun.value.status).toBe("ERROR");
    expect(blockedRun.value.steps[0]?.error?.message).toMatch(
      /leave the registered origin/,
    );
    expect(decoy.requests.some((entry) => entry.url === "/stolen")).toBe(false);

    const followed = await scenario(target.id, api.resourceId, [
      { name: "Internal redirect", method: "GET", path: "/redirect-internal", expectedStatus: 200 },
    ]);
    const followedRun = await run(target.id, followed);
    expect(followedRun.value.status).toBe("PASSED");
  });

  it("uses the registered secretRef as the server-side bearer and never echoes it", async () => {
    const target = await project();
    const api = await resource(target.id, fixture.origin, ["SANDBOX_API_TOKEN"]);
    const id = await scenario(target.id, api.resourceId, [
      { name: "Protected", method: "GET", path: "/protected", expectedStatus: 200 },
    ]);
    const { value } = await run(target.id, id);
    expect(value.status).toBe("PASSED");
    expect(
      fixture.requests.some(
        (entry) =>
          entry.url === "/protected" &&
          entry.authorization === "Bearer resource-secret-value",
      ),
    ).toBe(true);
    const persisted = (await store.listArtifacts(target.id)).find(
      (artifact) => artifact.kind === "VALIDATION_REPORT",
    );
    expect(JSON.stringify(persisted)).not.toContain("resource-secret-value");
    expect(JSON.stringify(await store.listAudit(target.id))).not.toContain(
      "resource-secret-value",
    );
  });

  it("evaluates additive assertions on top of the expected status", async () => {
    const target = await project();
    const api = await resource(target.id, fixture.origin);
    const passing = await scenario(target.id, api.resourceId, [
      {
        name: "Assertions",
        method: "GET",
        path: "/ok",
        expectedStatus: 200,
        assertions: [
          { type: "HEADER_EXISTS", header: "content-type" },
          { type: "BODY_FIELD_EQUALS", path: "response.body.ok", value: true },
          { type: "MAX_DURATION_MS", maxDurationMs: 15_000 },
        ],
      },
    ]);
    expect((await run(target.id, passing)).value.status).toBe("PASSED");

    const failing = await scenario(target.id, api.resourceId, [
      {
        name: "Slow",
        method: "GET",
        path: "/slow",
        expectedStatus: 200,
        assertions: [{ type: "MAX_DURATION_MS", maxDurationMs: 5 }],
      },
    ]);
    const failingRun = await run(target.id, failing);
    expect(failingRun.value.status).toBe("FAILED");
    expect(failingRun.value.steps[0]?.assertions[0]?.passed).toBe(false);
  });

  it("refuses to execute for a project without AUTONOMOUS_STAGING", async () => {
    const target = await project("SANDBOX", "GUARDED");
    const api = await resource(target.id, fixture.origin);
    const id = await scenario(target.id, api.resourceId, [
      { name: "Ok", method: "GET", path: "/ok", expectedStatus: 200 },
    ]);
    await expect(run(target.id, id)).rejects.toMatchObject({
      code: "POLICY_VIOLATION",
    });
  });

  it("replays the same operationId instead of re-sending the requests", async () => {
    const target = await project();
    const api = await resource(target.id, fixture.origin);
    const id = await scenario(target.id, api.resourceId, [
      { name: "Ok", method: "GET", path: "/ok", expectedStatus: 200 },
    ]);
    const replayId = operationId();
    const first = (await admin.scenarioRun(principal, target.id, {
      scenarioId: id,
      operationId: replayId,
    })) as { idempotentReplay: boolean };
    const before = fixture.requests.length;
    const second = (await admin.scenarioRun(principal, target.id, {
      scenarioId: id,
      operationId: replayId,
    })) as { idempotentReplay: boolean };
    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(fixture.requests.length).toBe(before);
  });

  it("requires the SUPERADMIN role", async () => {
    const target = await project();
    const api = await resource(target.id, fixture.origin);
    const id = await scenario(target.id, api.resourceId, [
      { name: "Ok", method: "GET", path: "/ok", expectedStatus: 200 },
    ]);
    await expect(
      admin.scenarioRun(
        { actor: "operator", role: "PROJECT_OPERATOR" },
        target.id,
        { scenarioId: id, operationId: operationId() },
      ),
    ).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  });
});
