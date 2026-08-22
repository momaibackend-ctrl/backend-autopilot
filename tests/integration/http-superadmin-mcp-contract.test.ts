import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { scenarioRunToolName } from "../../packages/http-runner/src/index.js";
import { publishedMcpTools, searchTools } from "../helpers/mcp-registry.js";

describe("HTTP SUPERADMIN MCP contract",()=>{
  it("exposes broad semantic control without shell, SQL, filesystem, or arbitrary Git binding tools",async()=>{
    const source=await readFile("supabase/functions/mcp/index.ts","utf8");
    const service=await readFile("packages/superadmin/src/index.ts","utf8");
    const tools=(await publishedMcpTools()).map(tool=>tool.name);
    for(const name of [
      "superadmin_system_overview","superadmin_project_create","superadmin_project_update","superadmin_project_delete",
      "superadmin_resource_create","superadmin_context_update","superadmin_task_analyze","superadmin_task_plan","superadmin_task_execute","superadmin_task_retry","superadmin_task_review","superadmin_task_delete",
      "superadmin_job_create","superadmin_job_cancel","superadmin_run_get","superadmin_artifact_update","superadmin_scenario_create","superadmin_validation_run",
      "superadmin_scenario_run",
      "superadmin_setting_upsert","superadmin_screen_upsert","superadmin_operator_upsert","superadmin_membership_delete","superadmin_audit_list",
      "superadmin_sandbox_pull_request_open","superadmin_sandbox_pull_request_merge","superadmin_sandbox_repository_read",
    ])expect(tools).toContain(name);
    expect(tools.length).toBeGreaterThanOrEqual(66);
    expect(tools.some(name=>/(shell|sql|filesystem|run_any_command)/i.test(name))).toBe(false);
    expect(service).toContain("GitHub/Git bindings require the dedicated verified provider registration flow");
    expect(source).toContain("AUTOPILOT_SUPERADMIN_MCP_TOKEN");
    expect(source).toContain("productionWrites:'NOT_SUPPORTED'");
  });

  // Regression guard for the failure mode this capability was added to avoid: an executable
  // HTTP scenario runner that exists in the codebase but is invisible to the external client.
  it("publishes the executable HTTP scenario runner so an external client can discover it",async()=>{
    const tools=await publishedMcpTools();
    const executor=tools.find(tool=>tool.name===scenarioRunToolName);
    expect(executor,`${scenarioRunToolName} is missing from the published MCP tool registry`).toBeDefined();
    for(const query of ["scenario","run","http","validation"])
      expect(
        searchTools(tools,query).map(tool=>tool.name),
        `tool discovery for "${query}" does not surface ${scenarioRunToolName}`,
      ).toContain(scenarioRunToolName);
    // The executor must stay distinct from the semantic control-state validation tool.
    expect(tools.map(tool=>tool.name)).toContain("superadmin_validation_run");
    expect(tools.find(tool=>tool.name==="superadmin_validation_run")?.description)
      .toContain("semantic control-state validation");
  });

  it("keeps the scenario executor free of caller-supplied targets",async()=>{
    const source=await readFile("supabase/functions/mcp/index.ts","utf8");
    const registration=source.slice(source.indexOf("registerTool(scenarioRunToolName"),source.indexOf("registerTool(scenarioRunToolName")+400);
    expect(registration).toContain("scenarioRunToolInputSchema");
    expect(registration).not.toMatch(/baseUrl|url:|resourceId/);
    const runner=await readFile("packages/http-runner/src/index.ts","utf8");
    expect(Object.keys((await import("../../packages/http-runner/src/index.js")).scenarioRunToolInputSchema).sort())
      .toEqual(["operationId","projectId","scenarioId"]);
    expect(runner).toContain("resolveHttpApiTarget");
  });
});
