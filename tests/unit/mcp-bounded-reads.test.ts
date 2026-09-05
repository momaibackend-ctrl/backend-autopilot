import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// The MCP read surface is what an autonomous caller uses to decide whether it is done. When a list
// tool answers with a project's entire history, the caller does not get a big answer -- it gets no
// usable answer at all, because the response is past what any client can ingest, and it responds by
// trying the next diagnostic tool. Measured on this control plane's own project before the fix:
//
//   artifact_list               26 643 ms   19 150 130 B
//   superadmin_system_overview  19 319 ms   12 009 448 B
//   job_list                    14 134 ms   10 521 265 B
//   project_snapshot             8 340 ms            0 B   (HTTP 200, empty body, 6/6 failures)
//
// These tests pin the shape that replaced it. They read the real sources, so a rename cannot make
// them pass vacuously.
const root = resolve(__dirname, "../..");
const mcp = readFileSync(join(root, "supabase/functions/mcp/index.ts"), "utf8");
const superadmin = readFileSync(join(root, "packages/superadmin/src/index.ts"), "utf8");
const router = readFileSync(join(root, "packages/adapters/artifact-storage/src/router.ts"), "utf8");

/** The body of one registerTool call, so an assertion cannot accidentally match a neighbour. */
function tool(name: string): string {
  const start = mcp.indexOf(`server.registerTool('${name}'`);
  expect(start, `tool ${name} is not registered`).toBeGreaterThan(-1);
  const next = mcp.indexOf("server.registerTool('", start + 1);
  return mcp.slice(start, next === -1 ? mcp.length : next);
}

describe("every list tool over unbounded data is paged", () => {
  const pagedTools = ["task_list", "resource_list", "artifact_list", "run_list", "job_list", "superadmin_task_list", "superadmin_job_list", "superadmin_run_list", "superadmin_artifact_list", "superadmin_audit_list"];

  it("registers all of them, so a rename cannot make this vacuous", () => {
    for (const name of pagedTools) expect(tool(name).length).toBeGreaterThan(0);
  });

  it("accepts limit and offset on each", () => {
    for (const name of pagedTools) {
      expect(tool(name), `${name} takes no limit`).toContain("limit:limitInput");
      expect(tool(name), `${name} takes no offset`).toContain("offset:offsetInput");
    }
  });

  it("caps the page size, so a caller cannot ask for the unbounded dump back", () => {
    expect(mcp).toContain("const defaultPageSize=50, maxPageSize=200");
    expect(mcp).toContain("Math.min(limit??defaultPageSize,maxPageSize)");
  });

  it("reports total and nextOffset, so a caller can tell a page from the whole set", () => {
    // A bare truncated array is indistinguishable from a complete one, which is precisely what
    // leaves a caller unable to decide whether it has finished looking.
    expect(mcp).toContain("total:items.length");
    expect(mcp).toContain("nextOffset:next");
    expect(mcp).toContain("complete:next>=items.length");
  });
});

describe("listing never carries the heavy bodies", () => {
  it("artifact_list returns digests, not artifacts with inline content", () => {
    expect(tool("artifact_list")).toContain("listArtifactDigests");
    expect(tool("artifact_list")).not.toContain("service.artifactList");
    expect(tool("superadmin_artifact_list")).toContain("listArtifactDigests");
  });

  it("artifact_list says so in its description, which previously promised metadata and sent content", () => {
    expect(tool("artifact_list")).toContain("Content is NOT included");
    expect(tool("superadmin_artifact_list")).toContain("Content is NOT included");
  });

  it("job_list returns statuses, not payload/result/error bodies", () => {
    expect(tool("job_list")).toContain("listExecutionJobSummaries");
    expect(tool("job_list")).toContain("no payload/result bodies");
    expect(tool("superadmin_job_list")).toContain("listExecutionJobSummaries");
  });

  it("task_status stays bounded: artifact metadata and job statuses only", () => {
    const body = tool("task_status");
    expect(body).toContain("listExecutionJobSummaries");
    expect(body).toContain("listArtifactDigests");
    expect(body).toContain("readiness");
  });
});

describe("project_snapshot is always serialisable", () => {
  // It used to return the full history and the Edge isolate died building it -- 6/6 attempts gave
  // either HTTP 500 or HTTP 200 with an empty body. A 200 with nothing in it is the worst possible
  // answer for an autonomous caller: the transport says success, so there is no error to react to
  // and no data to act on, and the only move left is to try another tool.
  const body = tool("project_snapshot");

  it("no longer returns the unbounded snapshot", () => {
    expect(body).not.toContain("service.projectSnapshot");
  });

  it("returns counts and tallies rather than full history", () => {
    expect(body).toContain("counts:{tasks:");
    expect(body).toContain("taskStates:tally");
    expect(body).toContain("artifactKinds:tally");
  });

  it("uses only bounded reads", () => {
    expect(body).toContain("listArtifactDigests");
    expect(body).toContain("listExecutionJobSummaries");
    expect(body).toContain("listRecentAudit");
  });

  it("tells the caller where the detail it did not return can be found", () => {
    expect(body).toContain("artifact_list");
  });
});

describe("superadmin_system_overview scales with project count, not history", () => {
  const body = superadmin.slice(superadmin.indexOf("async systemOverview("), superadmin.indexOf("projectList(principal: SuperadminPrincipal)"));

  it("reads the function, so a rename cannot make this vacuous", () => {
    expect(body).toContain("async systemOverview(");
  });

  it("uses bounded reads for the three unbounded tables", () => {
    expect(body).toContain("listExecutionJobSummaries");
    expect(body).toContain("listArtifactDigests");
    expect(body).toContain("listRecentAudit");
  });

  it("no longer loads full artifacts, full jobs or the whole audit trail", () => {
    expect(body).not.toContain("listArtifacts(");
    expect(body).not.toContain("listExecutionJobs(");
    expect(body).not.toContain("listAudit(");
  });
});

describe("an unreadable artifact says it is permanent, not transient", () => {
  it("tells the caller retrying will not succeed", () => {
    // 108 of 119 externalized artifacts on this control plane point at the suspended pre-cutover
    // project. A caller that reads "credential missing" as bad luck retries; one that reads
    // "permanently unavailable, retrying will not succeed" stops and reports.
    expect(router).toContain("permanently unavailable");
    expect(router).toContain("retrying will not succeed");
  });

  it("carries machine-readable permanence alongside the prose", () => {
    expect(router).toContain("retryable: false");
    expect(router).toContain("permanent: true");
  });

  it("says the metadata survives, so the caller does not treat the artifact as lost entirely", () => {
    expect(router).toContain("metadata is still readable");
  });
});
