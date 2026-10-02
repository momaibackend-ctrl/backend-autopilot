import { describe, expect, it } from "vitest";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";
import { PostgrestStateStore } from "../../packages/project-registry/src/postgrest-store.js";
import type { ExecutionJob } from "../../packages/schemas/src/index.js";

// The status filter has to be applied by the store, not by the caller. That distinction is the
// whole defect: the scheduled reconciler already filtered by status, but it did so in JavaScript
// after reading every job the project had ever run. The rows still crossed the wire, so the cost
// grew with history until a month's egress allowance was gone and the project was restricted.
//
// So these assert where the filtering happens, not just that the right rows come back -- a store
// that fetched everything and filtered in memory would satisfy the result but reintroduce the bug.

const job = (id: string, status: string, projectId: string): ExecutionJob =>
  ({ id, projectId, taskId: "t", resourceId: "r", operationId: `op-${id}`, kind: "EXECUTE", status, attempt: 1, queuedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }) as unknown as ExecutionJob;

describe("execution job summary status filter", () => {
  it("returns only the requested statuses", async () => {
    const store = new MemoryStateStore();
    for (const [id, status] of [["1", "RUNNING"], ["2", "SUCCEEDED"], ["3", "QUEUED"], ["4", "FAILED"]] as const)
      await store.createExecutionJob(job(id, status, "p"));
    const active = await store.listExecutionJobSummaries("p", undefined, ["QUEUED", "RUNNING"]);
    expect(active.map((summary) => summary.id).sort()).toEqual(["1", "3"]);
  });

  it("returns every status when no filter is given, so existing callers are unchanged", async () => {
    const store = new MemoryStateStore();
    for (const [id, status] of [["1", "RUNNING"], ["2", "SUCCEEDED"]] as const)
      await store.createExecutionJob(job(id, status, "p"));
    expect(await store.listExecutionJobSummaries("p")).toHaveLength(2);
  });

  it("pushes the filter into the PostgREST query instead of reading rows to discard them", async () => {
    const requested: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      await new PostgrestStateStore("https://abcdefghijklmnopqrst.supabase.co", "service-key").listExecutionJobSummaries("p", undefined, ["QUEUED", "RUNNING"]);
    } finally {
      globalThis.fetch = original;
    }
    const url = requested.join(" ");
    expect(url).toContain("status=in.(QUEUED,RUNNING)");
    // The payload columns must stay out of the projection even with a filter in play.
    expect(url).not.toContain("select=*");
  });
});
