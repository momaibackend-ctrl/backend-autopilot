import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as collection from "../../packages/http-runner/src/collection.js";
import * as discovery from "../../packages/http-runner/src/contract-discovery.js";
import * as environment from "../../packages/ephemeral-environment/src/plan.js";
import * as e2e from "../../packages/ephemeral-environment/src/http-e2e-job.js";
import { publishedMcpTools, searchTools } from "../helpers/mcp-registry.js";

const tools = [
  {
    constant: "collectionImportToolName",
    name: collection.collectionImportToolName,
    description: collection.collectionImportToolDescription,
    schema: collection.collectionImportToolInputSchema,
    fields: ["collection", "collectionSource", "operationId", "projectId", "resourceId", "stripPathPrefix", "taskId"],
  },
  {
    constant: "collectionRunToolName",
    name: collection.collectionRunToolName,
    description: collection.collectionRunToolDescription,
    schema: collection.collectionRunToolInputSchema,
    fields: ["contractRepository", "openapi", "operationId", "projectId", "resourceId", "scenarioIds"],
  },
  {
    constant: "apiCoverageToolName",
    name: collection.apiCoverageToolName,
    description: collection.apiCoverageToolDescription,
    schema: collection.apiCoverageToolInputSchema,
    fields: ["contractRepository", "openapi", "projectId", "resourceId"],
  },
  {
    constant: "repositoryApiDiscoveryToolName",
    name: discovery.repositoryApiDiscoveryToolName,
    description: discovery.repositoryApiDiscoveryToolDescription,
    schema: discovery.repositoryApiDiscoveryToolInputSchema,
    fields: ["projectId", "ref", "resourceId"],
  },
  {
    constant: "environmentPlanToolName",
    name: environment.environmentPlanToolName,
    description: environment.environmentPlanToolDescription,
    schema: environment.environmentPlanToolInputSchema,
    fields: ["projectId", "ref", "resourceId", "root"],
  },
  {
    constant: "httpE2eRunToolName",
    name: e2e.httpE2eRunToolName,
    description: e2e.httpE2eRunToolDescription,
    schema: e2e.httpE2eRunToolInputSchema,
    fields: ["counterpart", "operationId", "projectId", "ref", "repositoryResourceId", "root", "scenarioSource", "stripPathPrefix", "taskId"],
  },
  {
    constant: "httpE2eGetToolName",
    name: e2e.httpE2eGetToolName,
    description: e2e.httpE2eGetToolDescription,
    schema: e2e.httpE2eGetToolInputSchema,
    fields: ["jobId", "projectId"],
  },
];

// The registry helper resolves registrations that name a tool by an exported constant only from
// the runner's index module, so the collection tools are resolved here from their own module.
async function registrations() {
  const source = await readFile("supabase/functions/mcp/index.ts", "utf8");
  return tools.map((tool) => {
    const index = source.indexOf(`registerTool(${tool.constant},`);
    return { tool, index, registration: index < 0 ? "" : source.slice(index, source.indexOf("\n", index)) };
  });
}

describe("whole API collection MCP contract", () => {
  it("publishes import, run and coverage as semantic SUPERADMIN tools", async () => {
    for (const { tool, index, registration } of await registrations()) {
      expect(index, `${tool.name} is not registered in the deployed Edge MCP`).toBeGreaterThan(0);
      expect(registration).toContain("admin()");
      expect(Object.keys(tool.schema).sort()).toEqual(tool.fields);
    }
    const published = [
      ...(await publishedMcpTools()),
      ...tools.map(({ name, description }) => ({ name, description })),
    ];
    for (const query of ["postman", "collection"])
      expect(searchTools(published, query).map((tool) => tool.name)).toEqual(
        expect.arrayContaining([collection.collectionImportToolName, collection.collectionRunToolName]),
      );
    expect(searchTools(published, "coverage").map((tool) => tool.name)).toContain(collection.apiCoverageToolName);
    expect(searchTools(published, "contract").map((tool) => tool.name)).toContain(discovery.repositoryApiDiscoveryToolName);
    expect(discovery.repositoryApiDiscoveryToolAnnotations.readOnlyHint).toBe(true);
    expect(tools.some((tool) => /(shell|sql|filesystem)/i.test(tool.name))).toBe(false);
  });

  it("accepts no caller-supplied URL, host or base for any collection tool", async () => {
    for (const { tool, registration } of await registrations()) {
      expect(Object.keys(tool.schema).some((field) => /url|host|base|origin/i.test(field)), tool.name).toBe(false);
      expect(registration).not.toMatch(/baseUrl|url:|host:/);
    }
    const run = collection.collectionRunToolInputSchema;
    expect(run.scenarioIds.safeParse(["not-a-uuid"]).success).toBe(false);
    expect(collection.collectionImportToolInputSchema.stripPathPrefix.safeParse("https://evil.test/x").success).toBe(false);
    expect(collection.collectionImportToolInputSchema.stripPathPrefix.safeParse("/api/v1").success).toBe(true);
  });

  it("marks only the coverage report read-only and announces the changed tool surface", async () => {
    expect(collection.apiCoverageToolAnnotations.readOnlyHint).toBe(true);
    expect(collection.collectionImportToolAnnotations.readOnlyHint).toBe(false);
    expect(collection.collectionRunToolAnnotations).toMatchObject({ readOnlyHint: false, openWorldHint: true, idempotentHint: true });
    const source = await readFile("supabase/functions/mcp/index.ts", "utf8");
    expect(source).not.toMatch(/version:'0\.5\.[1-8]'/);
    expect(e2e.httpE2eGetToolAnnotations.readOnlyHint).toBe(true);
    expect(e2e.httpE2eRunToolAnnotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
  });

  it("maps the new module in every Edge Function import map", async () => {
    for (const name of ["mcp", "control-api", "reconcile"]) {
      const map = JSON.parse(await readFile(`supabase/functions/${name}/deno.json`, "utf8")) as { imports: Record<string, string> };
      expect(map.imports["../../../packages/http-runner/src/collection.js"], name).toBe("../../../packages/http-runner/src/collection.ts");
      expect(map.imports["../../../packages/ephemeral-environment/src/http-e2e-job.js"], name).toBe("../../../packages/ephemeral-environment/src/http-e2e-job.ts");
      expect(map.imports["../../../packages/ephemeral-environment/src/plan.js"], name).toBe("../../../packages/ephemeral-environment/src/plan.ts");
      expect(map.imports["../../../packages/http-runner/src/contract-discovery.js"], name).toBe("../../../packages/http-runner/src/contract-discovery.ts");
    }
  });
});
