// End-to-end proof for the executable HTTP validation runner.
//
// Nothing here calls the runner or SuperadminService directly. Every step goes over real HTTP
// JSON-RPC through an MCP server + MCP client pair -- the same protocol, transport family,
// bearer-token gate and tool definitions the deployed Supabase Edge endpoint exposes to an
// external client such as ChatGPT. The tool identity, description, annotations and input schema
// come from the shared `packages/http-runner` export that `supabase/functions/mcp/index.ts`
// registers; `tests/integration/http-superadmin-mcp-contract.test.ts` separately proves the
// deployed Edge registry registers that exact constant.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { DomainError } from "../../packages/core/src/errors.js";
import { createService } from "../../packages/core/src/runtime.js";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";
import { SuperadminService } from "../../packages/superadmin/src/index.js";
import {
  scenarioRunToolAnnotations,
  scenarioRunToolDescription,
  scenarioRunToolInputSchema,
  scenarioRunToolName,
} from "../../packages/http-runner/src/index.js";
import {
  environmentSchema,
  autonomyModeSchema,
  validationScenarioStepSchema,
} from "../../packages/schemas/src/index.js";

const superadminToken = "e2e-superadmin-mcp-token";
const systemProjectId = "00000000-0000-4000-8000-000000000000";
const secretValue = "server-side-login-secret";

const store = new MemoryStateStore();
const service = createService({ store });
const admin = new SuperadminService({ store, service, systemProjectId });

// --- target API fixture ----------------------------------------------------
const received: Array<{ method: string; url: string; authorization?: string }> =
  [];
let target: Server;
let targetOrigin: string;

// --- MCP endpoint mirroring the deployed Edge function ---------------------
let mcp: Server;
let mcpUrl: URL;
let client: Client;

const operationId = z.string().min(8).max(200);
const projectId = z.string().uuid();
const entityId = z.string().uuid();
type ServerTransport = Parameters<McpServer["connect"]>[0];
type ClientTransport = Parameters<Client["connect"]>[0];
type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function buildMcpServer(actor: string) {
  const server = new McpServer({ name: "backend-autopilot", version: "0.5.0" });
  const principal = { actor, role: "SUPERADMIN" as const };
  const result = (value: unknown): ToolResult => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: { result: value as Record<string, unknown> },
  });
  const safe =
    <T>(fn: (value: T) => Promise<unknown>) =>
    async (value: T): Promise<ToolResult> => {
      try {
        return result(await fn(value));
      } catch (error) {
        if (error instanceof DomainError)
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: {
                    code: error.code,
                    message: error.message,
                    details: error.details,
                  },
                }),
              },
            ],
          };
        throw error;
      }
    };
  const ro = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const mut = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  server.registerTool(
    "superadmin_project_create",
    {
      description: "Create a non-production project",
      inputSchema: {
        operationId,
        name: z.string().min(1),
        slug: z.string(),
        sourceType: z.string().min(1),
        environment: environmentSchema,
        autonomyMode: autonomyModeSchema,
      },
      annotations: mut,
    },
    safe(async (value) =>
      admin.projectCreate(
        principal,
        { ...value, workspacePath: "" },
        value.operationId,
      ),
    ),
  );
  server.registerTool(
    "superadmin_resource_create",
    {
      description: "Register a non-Git sandbox resource",
      inputSchema: {
        operationId,
        projectId,
        type: z.string(),
        provider: z.string(),
        externalReference: z.string(),
        environment: environmentSchema,
        permissions: z.array(z.string()),
        secretRefs: z.array(z.string()).default([]),
      },
      annotations: mut,
    },
    safe(async ({ operationId: id, ...value }) =>
      admin.resourceCreate(principal, value, id),
    ),
  );
  server.registerTool(
    "superadmin_scenario_create",
    {
      description:
        "Create a structured validation scenario bound to a registered HTTP_API resource",
      inputSchema: {
        operationId,
        projectId,
        resourceId: entityId,
        name: z.string().min(1).max(120),
        description: z.string().max(1000).default(""),
        steps: z.array(validationScenarioStepSchema).min(1).max(20),
      },
      annotations: mut,
    },
    safe(async ({ operationId: id, projectId: project, ...value }) =>
      admin.scenarioCreate(principal, project, { ...value, operationId: id }, id),
    ),
  );
  // The externally published executor, registered from the shared contract constants.
  server.registerTool(
    scenarioRunToolName,
    {
      description: scenarioRunToolDescription,
      inputSchema: scenarioRunToolInputSchema,
      annotations: scenarioRunToolAnnotations,
    },
    safe(async ({ operationId: id, projectId: project, scenarioId }) =>
      admin.scenarioRun(principal, project, { scenarioId, operationId: id }),
    ),
  );
  server.registerTool(
    "superadmin_validation_list",
    {
      description: "List validation results",
      inputSchema: { projectId },
      annotations: ro,
    },
    safe(async ({ projectId: project }) =>
      admin.validationList(principal, project),
    ),
  );
  server.registerTool(
    "superadmin_validation_get",
    {
      description: "Read one validation result",
      inputSchema: { projectId, validationId: entityId },
      annotations: ro,
    },
    safe(async ({ projectId: project, validationId }) =>
      admin.validationGet(principal, project, validationId),
    ),
  );
  server.registerTool(
    "superadmin_audit_list",
    {
      description: "List immutable audit events for any project",
      inputSchema: { projectId },
      annotations: ro,
    },
    safe(async ({ projectId: project }) => admin.auditList(principal, project)),
  );
  return server;
}

async function callTool<T>(name: string, args: Record<string, unknown>) {
  const response = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: { result: T };
    content?: Array<{ text?: string }>;
  };
  const text = response.content?.[0]?.text ?? "";
  if (response.isError) throw new Error(text);
  return {
    value: (response.structuredContent?.result ?? JSON.parse(text)) as T,
    text,
  };
}

beforeAll(async () => {
  target = createServer((request, response) => {
    received.push({
      method: request.method ?? "",
      url: request.url ?? "",
      ...(request.headers.authorization
        ? { authorization: request.headers.authorization }
        : {}),
    });
    response.setHeader("content-type", "application/json");
    const authorized = request.headers.authorization === `Bearer ${secretValue}`;
    if (request.method === "POST" && request.url === "/auth/login") {
      response.statusCode = 200;
      response.end(
        JSON.stringify({ user_id: "user-42", access_token: secretValue }),
      );
      return;
    }
    if (request.method === "GET" && request.url === "/me") {
      response.statusCode = authorized ? 200 : 401;
      response.end(JSON.stringify({ id: "user-42", email: "me@example.test" }));
      return;
    }
    if (request.method === "POST" && request.url === "/resource") {
      response.statusCode = authorized ? 201 : 401;
      response.end(JSON.stringify({ id: "res-7", title: "created" }));
      return;
    }
    if (request.method === "GET" && request.url === "/resource/res-7") {
      response.statusCode = authorized ? 200 : 401;
      response.end(JSON.stringify({ id: "res-7", title: "created" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  targetOrigin = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;

  mcp = createServer((request, response) => {
    void (async () => {
      if (request.headers.authorization !== `Bearer ${superadminToken}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = chunks.length
        ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown)
        : undefined;
      // Stateless per-request server, exactly like the Edge function's Deno.serve handler.
      const server = buildMcpServer("remote-mcp-superadmin");
      const transport = new StreamableHTTPServerTransport({
        // Stateless mode, exactly as the deployed Edge transport is constructed.
        sessionIdGenerator: undefined as unknown as () => string,
        enableJsonResponse: true,
      });
      response.on("close", () => void transport.close());
      await server.connect(transport as unknown as ServerTransport);
      await transport.handleRequest(request, response, body);
    })();
  });
  await new Promise<void>((resolve) => mcp.listen(0, "127.0.0.1", resolve));
  mcpUrl = new URL(
    `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`,
  );

  client = new Client({ name: "external-connector", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: { authorization: `Bearer ${superadminToken}` } },
    }) as unknown as ClientTransport,
  );
}, 60_000);

afterAll(async () => {
  await client?.close();
  await new Promise<void>((resolve) => mcp.close(() => resolve()));
  await new Promise<void>((resolve) => target.close(() => resolve()));
});

describe("HTTP validation runner end-to-end through the published MCP tool layer", () => {
  it("rejects an unauthenticated caller at the same credential gate", async () => {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(response.status).toBe(401);
  });

  it("discovers the executor, reads its schema, runs a chained scenario, and persists auditable evidence", async () => {
    // 1. discovery -----------------------------------------------------------
    const tools = await client.listTools();
    const executor = tools.tools.find(
      (tool) => tool.name === scenarioRunToolName,
    );
    expect(executor, "executor missing from tools/list").toBeDefined();
    expect(executor?.description).toContain("HTTP");

    // 2. JSON schema ---------------------------------------------------------
    const schema = executor?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      "operationId",
      "projectId",
      "scenarioId",
    ]);
    expect(schema.required?.sort()).toEqual([
      "operationId",
      "projectId",
      "scenarioId",
    ]);

    // 3. register the sandbox project and HTTP_API resource through the tools --
    const suffix = Date.now().toString(36);
    const project = await callTool<{ value: { id: string } }>(
      "superadmin_project_create",
      {
        operationId: `e2e-project-${suffix}`,
        name: "HTTP runner E2E",
        slug: `http-runner-e2e-${suffix}`,
        sourceType: "MCP",
        environment: "SANDBOX",
        autonomyMode: "AUTONOMOUS_STAGING",
      },
    );
    const projectId = project.value.value.id;
    const resource = await callTool<{ value: { resourceId: string } }>(
      "superadmin_resource_create",
      {
        operationId: `e2e-resource-${suffix}`,
        projectId,
        type: "HTTP_API",
        provider: "http",
        externalReference: targetOrigin,
        environment: "SANDBOX",
        permissions: ["READ"],
        secretRefs: [],
      },
    );
    const resourceId = resource.value.value.resourceId;

    // 4. create the scenario through the existing public CRUD tool ------------
    const scenario = await callTool<{ value: { id: string } }>(
      "superadmin_scenario_create",
      {
        operationId: `e2e-scenario-${suffix}`,
        projectId,
        resourceId,
        name: "Login, read self, create and read a resource",
        description: "Postman-style chained sandbox flow",
        steps: [
          {
            name: "Login",
            method: "POST",
            path: "/auth/login",
            body: { user: "sandbox" },
            expectedStatus: 200,
            extract: {
              user_id: { path: "response.body.user_id", sensitive: false },
              access_token: {
                path: "response.body.access_token",
                sensitive: true,
              },
            },
          },
          {
            name: "Read own profile",
            method: "GET",
            path: "/me",
            expectedStatus: 200,
            bearerFrom: "access_token",
            assertions: [
              { type: "HEADER_EXISTS", header: "content-type" },
              {
                type: "BODY_FIELD_EQUALS",
                path: "response.body.id",
                value: "user-42",
              },
            ],
          },
          {
            name: "Create resource",
            method: "POST",
            path: "/resource",
            body: { title: "created", owner: "{{user_id}}" },
            expectedStatus: 201,
            bearerFrom: "access_token",
            extract: {
              created_id: { path: "response.body.id", sensitive: false },
            },
          },
          {
            name: "Read created resource",
            method: "GET",
            path: "/resource/{{created_id}}",
            expectedStatus: 200,
            bearerFrom: "access_token",
            assertions: [
              {
                type: "BODY_FIELD_EQUALS",
                path: "response.body.id",
                value: "res-7",
              },
            ],
          },
        ],
      },
    );
    const scenarioId = scenario.value.value.id;

    // 5. invoke the new public executor --------------------------------------
    const before = received.length;
    const execution = await callTool<{
      value: {
        executionId: string;
        status: string;
        summary: { totalSteps: number; passedSteps: number };
        steps: Array<{
          name: string;
          status: string;
          httpStatus: number;
          extracted: Record<string, unknown>;
        }>;
        resultArtifactId: string;
      };
    }>(scenarioRunToolName, {
      operationId: `e2e-run-${suffix}`,
      projectId,
      scenarioId,
    });
    const value = execution.value.value;

    // 6. the real server received the real requests, in order -----------------
    const sent = received.slice(before);
    expect(sent.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      "POST /auth/login",
      "GET /me",
      "POST /resource",
      "GET /resource/res-7",
    ]);
    // 7. chaining: extracted id in the path, extracted token as bearer --------
    expect(sent.slice(1).every((entry) => entry.authorization === `Bearer ${secretValue}`))
      .toBe(true);

    // 8. assertions and structured result -------------------------------------
    expect(value.status).toBe("PASSED");
    expect(value.summary).toMatchObject({ totalSteps: 4, passedSteps: 4 });
    expect(value.steps.map((step) => step.httpStatus)).toEqual([
      200, 200, 201, 200,
    ]);
    expect(value.steps[0]?.extracted).toMatchObject({
      user_id: "user-42",
      access_token: "[REDACTED]",
    });

    // 9. the execution result is readable through existing validation tools ----
    const listed = await callTool<{ id: string; kind: string }[]>(
      "superadmin_validation_list",
      { projectId },
    );
    expect(listed.value.map((entry) => entry.id)).toContain(
      value.resultArtifactId,
    );
    const persisted = await callTool<{ kind: string; content: unknown }>(
      "superadmin_validation_get",
      { projectId, validationId: value.resultArtifactId },
    );
    expect(persisted.value.kind).toBe("VALIDATION_REPORT");
    expect(persisted.value.content).toMatchObject({
      suite: "SCENARIO",
      result: "PASS",
      status: "PASSED",
      scenarioId,
      resourceId,
    });

    // 10. audit trail ---------------------------------------------------------
    const audit = await callTool<
      Array<{ action: string; correlationId: string }>
    >("superadmin_audit_list", { projectId });
    expect(
      audit.value.some(
        (event) =>
          event.action === "mcp.scenario_run" &&
          event.correlationId === `e2e-run-${suffix}`,
      ),
    ).toBe(true);

    // 11. no secret in any externally visible surface --------------------------
    for (const surface of [
      execution.text,
      listed.text,
      persisted.text,
      audit.text,
    ])
      expect(surface).not.toContain(secretValue);
  }, 60_000);
});
