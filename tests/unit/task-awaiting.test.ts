import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { awaitingCaller } from "../../packages/core/src/task-awaiting.js";

// CORE-BE-25 is the case this exists for. Its execution job ended FAILED, the lifecycle returned the
// task to IMPLEMENTING for a repair attempt, and there it sat for eight hours -- correct behaviour,
// but visible in no overview: not in activeJobs, because its job had finished, and not in
// failedGates, which only covers tasks whose own state is FAILED or BLOCKED. The only way to find it
// was to already know its id.
const root = resolve(__dirname, "../..");
const now = "2026-09-05T18:00:00.000Z";
const task = (over: Partial<Parameters<typeof awaitingCaller>[0]["tasks"][number]> = {}) => ({
  id: "t1", externalKey: "CORE-BE-25", title: "Context assembly", state: "IMPLEMENTING", repairAttempts: 1, updatedAt: "2026-09-05T09:44:13.000Z", ...over,
});

describe("a task handed back by a finished execution is surfaced", () => {
  it("lists the CORE-BE-25 shape: IMPLEMENTING with a FAILED job and nothing running", () => {
    const [waiting] = awaitingCaller({ tasks: [task()], jobs: [{ taskId: "t1", status: "FAILED", updatedAt: "2026-09-05T09:44:13.000Z" }], now });
    expect(waiting?.externalKey).toBe("CORE-BE-25");
    expect(waiting?.lastJobStatus).toBe("FAILED");
    expect(waiting?.idleHours).toBe(8);
  });

  it("says what to do, naming the tools that answer it", () => {
    const [waiting] = awaitingCaller({ tasks: [task()], jobs: [{ taskId: "t1", status: "FAILED", updatedAt: "2026-09-05T09:44:13.000Z" }], now });
    expect(waiting?.why).toContain("repair attempt");
    // Reading a 3 MB log from the start is how the previous agent stalled; the end is the useful part.
    expect(waiting?.why).toContain("artifact_read(tail:true)");
    expect(waiting?.why).toContain("nextAction");
  });

  it("stays quiet while the platform still owes the caller an answer", () => {
    for (const status of ["QUEUED", "DISPATCHING", "DISPATCHED", "CLAIMED", "RUNNING"])
      expect(awaitingCaller({ tasks: [task()], jobs: [{ taskId: "t1", status, updatedAt: now }], now }), status).toEqual([]);
  });

  it("does not nag about finished work", () => {
    for (const state of ["READY", "FAILED"])
      expect(awaitingCaller({ tasks: [task({ state })], jobs: [], now }), state).toEqual([]);
  });

  it("distinguishes never-executed from handed-back", () => {
    const [never] = awaitingCaller({ tasks: [task({ state: "PLANNED" })], jobs: [], now });
    expect(never?.lastJobStatus).toBe("NONE");
    expect(never?.why).toContain("never executed");
  });

  it("explains a BLOCKED task by its blockers rather than by its job", () => {
    const [blocked] = awaitingCaller({ tasks: [task({ state: "BLOCKED" })], jobs: [], now });
    expect(blocked?.why).toContain("readiness.blockers");
  });

  it("reads the newest job when a task has several", () => {
    const [waiting] = awaitingCaller({
      tasks: [task()],
      jobs: [
        { taskId: "t1", status: "SUCCEEDED", updatedAt: "2026-09-05T08:00:00.000Z" },
        { taskId: "t1", status: "TIMED_OUT", updatedAt: "2026-09-05T09:44:13.000Z" },
      ],
      now,
    });
    expect(waiting?.lastJobStatus).toBe("TIMED_OUT");
  });

  it("puts the longest-forgotten task first", () => {
    const rows = awaitingCaller({
      tasks: [task({ id: "recent", externalKey: "R-1", updatedAt: "2026-09-05T17:00:00.000Z" }), task({ id: "old", externalKey: "O-1", updatedAt: "2026-09-01T00:00:00.000Z" })],
      jobs: [{ taskId: "recent", status: "FAILED", updatedAt: now }, { taskId: "old", status: "FAILED", updatedAt: now }],
      now,
    });
    expect(rows.map(row => row.externalKey)).toEqual(["O-1", "R-1"]);
  });
});

describe("both overviews report it", () => {
  it("project_snapshot and systemOverview both answer 'what is waiting on me'", () => {
    expect(readFileSync(join(root, "supabase/functions/mcp/index.ts"), "utf8")).toContain("awaitingCaller:awaitingCaller(");
    expect(readFileSync(join(root, "packages/superadmin/src/index.ts"), "utf8")).toContain("awaitingCaller: awaitingCaller(");
  });
});
