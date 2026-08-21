import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("HTTP SUPERADMIN MCP contract",()=>{
  it("exposes broad semantic control without shell, SQL, filesystem, or arbitrary Git binding tools",async()=>{
    const source=await readFile("supabase/functions/mcp/index.ts","utf8");
    const service=await readFile("packages/superadmin/src/index.ts","utf8");
    const tools=[...source.matchAll(/registerTool\('([^']+)'/g)].map(match=>match[1]!);
    for(const name of [
      "superadmin_system_overview","superadmin_project_create","superadmin_project_update","superadmin_project_delete",
      "superadmin_resource_create","superadmin_context_update","superadmin_task_analyze","superadmin_task_plan","superadmin_task_execute","superadmin_task_retry","superadmin_task_review","superadmin_task_delete",
      "superadmin_job_create","superadmin_job_cancel","superadmin_run_get","superadmin_artifact_update","superadmin_scenario_create","superadmin_validation_run",
      "superadmin_setting_upsert","superadmin_screen_upsert","superadmin_operator_upsert","superadmin_membership_delete","superadmin_audit_list",
    ])expect(tools).toContain(name);
    expect(tools.length).toBeGreaterThanOrEqual(65);
    expect(tools.some(name=>/(shell|sql|filesystem|run_any_command)/i.test(name))).toBe(false);
    expect(service).toContain("GitHub/Git bindings require the dedicated verified provider registration flow");
    expect(source).toContain("AUTOPILOT_SUPERADMIN_MCP_TOKEN");
    expect(source).toContain("productionWrites:'NOT_SUPPORTED'");
  });
});
