import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The reconciler is the only component that reads the control plane unattended, on a timer, with
// nobody looking at the result. That makes an unbounded read here a different kind of defect from
// the same read on a page someone opens: it repeats 96 times a day whether or not anything needs
// reconciling, and its cost is paid in egress rather than in latency somebody notices.
//
// It went exactly that way. `listExecutionJobs` returns the whole `data` document, whose `payload`,
// `result` and `error` fields average 29 kB per row and reach 202 kB -- about 5 MB per project per
// run just to read a status column. Every other caller in the system had already been moved to the
// summary read for that reason; this one was missed, and four runs an hour consumed the project's
// entire monthly egress allowance in roughly ten days. Supabase then restricted the organization,
// and every service on the project -- MCP, Control API, PostgREST and Auth -- answered HTTP 402
// for a week. The connector, the Operator Console and every execution callback went down with it.
//
// Nothing in the test suite could have caught that: the code was correct, the types were right,
// and a unit test of the reconciler's logic passes either way. The cost lived entirely in which
// store method it called. So that is what this asserts, against the real file.

const source = readFileSync(resolve(__dirname, "../../supabase/functions/reconcile/index.ts"), "utf8");

// Reads that return a whole JSON envelope per row, and so grow without bound as history accumulates.
const unboundedReads = ["listExecutionJobs", "listArtifacts", "listRuns", "listAudit", "listTasks", "listTransitions"];

describe("scheduled reconciler reads", () => {
  it("never lists full envelopes on its timer path", () => {
    const used = unboundedReads.filter((method) => source.includes(`${method}(`));
    expect(used, `The scheduled reconciler runs every 15 minutes against every project. These reads return each row's full JSON document, so their cost grows with history and is paid in egress on every run forever. Read the indexed summary instead, and fetch the full envelope only for the few rows that actually need it.`).toEqual([]);
  });

  it("reads statuses through the summary projection", () => {
    expect(source).toContain("listExecutionJobSummaries(");
  });

  it("still fetches the full envelope for the jobs it acts on", () => {
    // Narrowing the list read would be a bug of its own if it also narrowed what reconciliation
    // works with: classifyExecutionJob and the write-backs need the whole job, not a summary.
    expect(source).toContain("getExecutionJob(");
  });
});
