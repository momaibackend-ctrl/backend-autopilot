// End-to-end proof for the whole-collection tools: an external MCP client discovers them, imports
// a Postman collection, asks what is still uncovered and runs the collection -- all over real
// HTTP JSON-RPC, with the tool names, descriptions, annotations and input schemas taken from the
// same `packages/http-runner/src/collection` exports that the deployed Edge MCP registers.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DomainError } from "../../packages/core/src/errors.js";
import { createService } from "../../packages/core/src/runtime.js";
import {
  apiCoverageToolAnnotations,
  apiCoverageToolDescription,
  apiCoverageToolInputSchema,
  apiCoverageToolName,
  collectionImportToolAnnotations,
  collectionImportToolDescription,
  collectionImportToolInputSchema,
  collectionImportToolName,
  collectionRunToolAnnotations,
  collectionRunToolDescription,
  collectionRunToolInputSchema,
  collectionRunToolName,
} from "../../packages/http-runner/src/collection.js";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";
import { SuperadminService } from "../../packages/superadmin/src/index.js";

const token = "e2e-collection-superadmin-token";
const store = new MemoryStateStore();
const service = createService({ store });
const admin = new SuperadminService({ store, service, systemProjectId: "00000000-0000-4000-8000-000000000000" });
type ServerTransport = Parameters<McpServer["connect"]>[0];
type ClientTransport = Parameters<Client["connect"]>[0];

let target: Server;
let targetOrigin: string;
let mcp: Server;
let client: Client;
const received: string[] = [];

function buildMcpServer() {
  const server = new McpServer({ name: "backend-autopilot", version: "0.5.2" });
  const principal = { actor: "remote-mcp-superadmin", role: "SUPERADMIN" as const };
  const safe =
    <T,>(fn: (value: T) => Promise<unknown>) =>
    async (value: T) => {
      try {
        const result = await fn(value);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: { result } };
      } catch (error) {
        if (error instanceof DomainError)
          return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: { code: error.code, message: error.message } }) }] };
        throw error;
      }
    };
  server.registerTool(
    collectionImportToolName,
    { description: collectionImportToolDescription, inputSchema: collectionImportToolInputSchema, annotations: collectionImportToolAnnotations },
    safe(async ({ operationId, projectId, resourceId, collection, stripPathPrefix }) =>
      admin.collectionImport(principal, projectId, { resourceId, collection, ...(stripPathPrefix ? { stripPathPrefix } : {}) }, operationId),
    ),
  );
  server.registerTool(
    collectionRunToolName,
    { description: collectionRunToolDescription, inputSchema: collectionRunToolInputSchema, annotations: collectionRunToolAnnotations },
    safe(async ({ operationId, projectId, resourceId, scenarioIds, openapi }) =>
      admin.collectionRun(principal, projectId, { resourceId, operationId, ...(scenarioIds ? { scenarioIds } : {}), ...(openapi === undefined ? {} : { openapi }) }),
    ),
  );
  server.registerTool(
    apiCoverageToolName,
    { description: apiCoverageToolDescription, inputSchema: apiCoverageToolInputSchema, annotations: apiCoverageToolAnnotations },
    safe(async ({ projectId, resourceId, openapi }) =>
      admin.apiCoverage(principal, projectId, { ...(resourceId ? { resourceId } : {}), ...(openapi === undefined ? {} : { openapi }) }),
    ),
  );
  return server;
}

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const response = (await client.callTool({ name, arguments: args })) as { structuredContent?: { result?: unknown }; isError?: boolean; content: Array<{ text: string }> };
  if (response.isError) throw new Error(response.content[0]?.text);
  return response.structuredContent?.result as T;
}

beforeAll(async () => {
  target = createServer((request, response) => {
    received.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/health") return void response.end(JSON.stringify({ status: "UP" }));
    if (request.url === "/api/v1/version") return void response.end(JSON.stringify({ version: "1.0.0" }));
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  targetOrigin = `http://127.0.0.1:${(target.address() as AddressInfo).port}/api/v1`;
  mcp = createServer((request, response) => {
    void (async () => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown) : undefined;
      const server = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined as unknown as () => string, enableJsonResponse: true });
      response.on("close", () => void transport.close());
      await server.connect(transport as unknown as ServerTransport);
      await transport.handleRequest(request, response, body);
    })();
  });
  await new Promise<void>((resolve) => mcp.listen(0, "127.0.0.1", resolve));
  client = new Client({ name: "external-connector", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }) as unknown as ClientTransport,
  );
}, 60_000);

afterAll(async () => {
  await client?.close();
  await new Promise<void>((resolve) => mcp.close(() => resolve()));
  await new Promise<void>((resolve) => target.close(() => resolve()));
});

describe("whole API collection end-to-end through the MCP tool layer", () => {
  it("imports a thin Postman collection, shows what it misses, and refuses to call it proven", async () => {
    const listed = (await client.listTools()).tools.map((tool) => tool.name);
    expect(listed).toEqual(expect.arrayContaining([collectionImportToolName, collectionRunToolName, apiCoverageToolName]));

    const project = await service.projectCreate({
      name: "Collection E2E",
      slug: `collection-e2e-${Date.now()}`,
      sourceType: "MCP",
      environment: "SANDBOX",
      autonomyMode: "AUTONOMOUS_STAGING",
      workspacePath: "",
    });
    const resource = await service.resourceRegister({
      projectId: project.id,
      type: "HTTP_API",
      provider: "http-collection-e2e",
      externalReference: targetOrigin,
      environment: "SANDBOX",
      permissions: ["READ"],
      secretRefs: [],
    });
    const openapi = JSON.stringify({
      openapi: "3.0.3",
      paths: {
        "/health": { get: { responses: { "200": {} } } },
        "/version": { get: { responses: { "200": {} } } },
        "/orders": { get: { responses: { "200": {} } }, post: { responses: { "201": {} } } },
        "/orders/{orderId}": { get: { responses: { "200": {} } } },
      },
    });

    const imported = await call<{ value: { scenarios: Array<{ scenarioId: string }>; requestCount: number } }>(collectionImportToolName, {
      operationId: `e2e-import-${Date.now()}`,
      projectId: project.id,
      resourceId: resource.resourceId,
      stripPathPrefix: "/api/v1",
      collection: {
        info: { name: "Smoke", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
        item: [
          { name: "Health", request: { method: "GET", url: "{{baseUrl}}/api/v1/health" }, event: [{ listen: "test", script: { exec: ["pm.response.to.have.status(200);"] } }] },
          { name: "Version", request: { method: "GET", url: "{{baseUrl}}/api/v1/version" }, event: [{ listen: "test", script: { exec: ["pm.response.to.have.status(200);"] } }] },
        ],
      },
    });
    expect(imported.value.requestCount).toBe(2);
    expect(imported.value.scenarios).toHaveLength(1);

    const coverage = await call<{ coverage: { uncoveredOperations: number }; drafts: Array<{ operation: string }> }>(apiCoverageToolName, {
      projectId: project.id,
      resourceId: resource.resourceId,
      openapi,
    });
    expect(coverage.coverage.uncoveredOperations).toBe(3);
    expect(coverage.drafts.map((draft) => draft.operation)).toEqual(["GET /orders", "POST /orders", "GET /orders/{orderId}"]);

    const run = await call<{ value: { status: string; verdict: string; reasons: string[]; coverage: { coveredOperations: number; totalOperations: number } } }>(
      collectionRunToolName,
      { operationId: `e2e-run-${Date.now()}`, projectId: project.id, resourceId: resource.resourceId, openapi },
    );
    expect(run.value.status).toBe("PASSED");
    expect(run.value.verdict).toBe("NOT_PROVEN");
    expect(run.value.coverage).toMatchObject({ coveredOperations: 2, totalOperations: 5 });
    expect(run.value.reasons).toEqual(["3 of 5 documented operations were not exercised by a passing request"]);
    expect(received).toEqual(["GET /api/v1/health", "GET /api/v1/version"]);
  });

  it("returns a typed policy error instead of a target override", async () => {
    await expect(
      call(collectionRunToolName, {
        operationId: `e2e-run-bad-${Date.now()}`,
        projectId: "11111111-1111-4111-8111-111111111111",
        resourceId: "22222222-2222-4222-8222-222222222222",
        baseUrl: "http://169.254.169.254",
      }),
    ).rejects.toThrow(/NOT_FOUND|POLICY_VIOLATION/);
  });
});
