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

describe("audit events are summarised, not inlined whole", () => {
  // After paging landed, audit became the dominant term by a wide margin: an event carries full
  // `input` and `result` payloads and averages ~19 kB here, so twenty of them were 195 kB of a
  // 226 kB project_snapshot, and ten of them 188 kB of one project entry in the system overview.
  const stores = ["packages/project-registry/src/postgrest-store.ts", "packages/project-registry/src/postgres-store.ts", "packages/project-registry/src/memory-store.ts", "packages/project-registry/src/file-store.ts"];

  it("every store implements the digest read, so the port is genuinely satisfied", () => {
    for (const path of stores) expect(readFileSync(join(root, path), "utf8"), path).toContain("listRecentAuditDigests");
  });

  it("projects the fields server-side rather than reading the document", () => {
    const postgrest = readFileSync(join(root, "packages/project-registry/src/postgrest-store.ts"), "utf8");
    expect(postgrest).toContain("actor:data->>actor");
    expect(postgrest).not.toMatch(/listRecentAuditDigests[\s\S]{0,600}select=data&/);
  });

  it("the polled and agent-facing views all use digests", () => {
    expect(tool("project_snapshot")).toContain("listRecentAuditDigests");
    expect(superadmin).toContain("listRecentAuditDigests");
    expect(readFileSync(join(root, "supabase/functions/control-api/index.ts"), "utf8")).toContain("listRecentAuditDigests");
  });
});

describe("the system overview counts what it does not need to enumerate", () => {
  const body = superadmin.slice(superadmin.indexOf("async systemOverview("), superadmin.indexOf("projectList(principal: SuperadminPrincipal)"));

  it("no longer inlines every run and every job of every project", () => {
    // 172 job summaries + 175 runs was 180 kB of a 466 kB response, per project, to render a tally.
    expect(body).toContain("jobStatuses:");
    expect(body).toContain("activeJobs:");
    expect(body).toContain("latestRuns: runs.slice(-10)");
    expect(body).not.toMatch(/^\s+jobs,$/m);
    expect(body).not.toMatch(/^\s+runs,$/m);
  });

  it("still reports the totals it stopped enumerating", () => {
    expect(body).toContain("counts: { tasks: tasks.length, jobs: jobs.length, runs: runs.length, artifacts: artifacts.length }");
  });
});

describe("tool descriptions point only at tools that exist", () => {
  // A description naming a tool the server does not register sends an autonomous caller looking for
  // something unreachable: the same dead end as an unusable response, because it has been told what
  // to do next and cannot do it. I introduced exactly this while writing project_snapshot's new
  // description, which pointed at a "project_export" that does not exist.
  const registered = new Set([...mcp.matchAll(/registerTool\('([a-z0-9_]+)'/g)].map(match => match[1]!));

  it("finds the registered tools, so the scrape is not silently empty", () => {
    expect(registered.size).toBeGreaterThan(50);
  });

  it("every tool name referenced inside a description is a registered tool", () => {
    const prefixes = /\b(?:superadmin|project|task|artifact|job|run|audit|resource|context|system)_[a-z0-9_]+\b/g;
    const dangling: string[] = [];
    for (const name of registered) {
      const body = tool(name);
      const start = body.indexOf("description:");
      const description = start === -1 ? "" : body.slice(start, body.indexOf(",inputSchema", start));
      for (const referenced of description.match(prefixes) ?? [])
        if (!registered.has(referenced)) dangling.push(name + " -> " + referenced);
    }
    expect(dangling).toEqual([]);
  });
});

describe("a project can be read one component at a time", () => {
  const body = tool("project_components");

  it("is registered and groups by CORE, MODULE and UNASSIGNED", () => {
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("'CORE'");
    expect(body).toContain("'UNASSIGNED'");
  });

  it("does not fold unbound tasks into CORE", () => {
    // An unbound task is a real gap in the export story. Counting it as core would hide precisely
    // what the component binding exists to surface.
    expect(body).toContain("unassignedTasks");
  });

  it("uses the bounded artifact read", () => {
    expect(body).toContain("listArtifactDigests");
  });
});

describe("reading one artifact is bounded too", () => {
  // Listing was fixed first, which left the other half of the same failure in place: CORE-BE-25's
  // two COMMAND_STDOUT artifacts are 3.0 MB each, and because every tool result is serialised twice
  // (text content plus structuredContent) a single artifact_read returned 6 057 768 B in 8.1 s.
  // That is the "extract the test log" step an agent was observed stalling on: the reply arrives,
  // no client can ingest it, and the caller goes looking for the failure somewhere else.
  const read = tool("artifact_read");
  const adminRead = tool("superadmin_artifact_get");

  it("both readers take the same slice inputs", () => {
    for (const [name, body] of [["artifact_read", read], ["superadmin_artifact_get", adminRead]] as const)
      expect(body, name).toContain("...sliceInput");
  });

  it("offers tail, because on a failing log the end is the part worth reading", () => {
    expect(mcp).toContain("tail:z.boolean()");
    expect(read).toContain("tail=true to read the END of a log");
  });

  it("caps a slice and says so in the reply", () => {
    expect(mcp).toContain("const defaultArtifactSlice=32_768, maxArtifactSlice=131_072");
    expect(mcp).toContain("contentLength:content.length");
    expect(mcp).toContain("truncated:content.length>slice.length");
    expect(mcp).toContain("nextOffset:end");
  });

  it("never cuts structured content into unparseable JSON", () => {
    // Slicing a log leaves something that still reads as a log. Slicing a JSON document leaves
    // something that parses as nothing, so an oversized one is described rather than mangled.
    expect(mcp).toContain("STRUCTURED_CONTENT_TOO_LARGE");
    expect(mcp).toContain("typeof content!=='string'");
  });

  it("shares one implementation between both readers", () => {
    expect(read).toContain("sliceArtifact(");
    expect(adminRead).toContain("sliceArtifact(");
  });
});

describe("the merge tool states its own policy, so a caller does not invent one", () => {
  // An agent was withholding merges "until native CI confirms and you give a separate command".
  // Half of that is real and enforced -- READY requires a CI_REPORT from the actual CI run for that
  // exact commit. The other half exists nowhere in this platform: merge takes no confirmation
  // token, unlike every genuinely destructive tool. A caller with no stated policy invents a
  // cautious one, and an approval step whose approver cannot evaluate the change adds latency
  // without adding safety.
  const body = tool("superadmin_sandbox_pull_request_merge");

  it("says no separate human confirmation is required", () => {
    expect(body).toContain("NO SEPARATE HUMAN CONFIRMATION IS REQUIRED OR ACCEPTED");
  });

  it("takes no confirmation token, unlike the destructive tools", () => {
    expect(body).not.toContain("confirmation:");
    for (const destructive of ["superadmin_task_delete", "superadmin_resource_delete", "superadmin_run_delete"])
      expect(tool(destructive), destructive).toContain("confirmation:z.literal(");
  });

  it("names the evidence it does enforce, so the real gate is not mistaken for ceremony", () => {
    for (const evidence of ["TEST_REPORT", "SECURITY_REPORT", "REVIEW_REPORT", "CI_REPORT", "FINAL_CHANGE_MANIFEST"])
      expect(body, evidence).toContain(evidence);
    expect(body).toContain("non-production");
  });
});
