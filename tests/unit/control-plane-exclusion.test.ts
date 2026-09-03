import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyJsonReference,
  closureCounts,
  closureNeedles,
  closureTotal,
  emptyClosure,
  evaluateTransientTaskGate,
  excludedIdsForTable,
  hashRows,
  historicalTables,
  isHistoricalTable,
  parseExcludedTaskIds,
  RELATIONSHIP_NORMALIZED_TABLE,
  stripExcludedRelationships,
  sample,
  SAMPLE_LIMIT,
  selectPageSqlExcluding,
  structuredTaskReferences,
  tablePlan,
  type ExclusionClosure,
} from "../../packages/control-plane-migration/src/index.js";

const A = "410f320b-af24-48d2-b29b-b4506293b8ba";
const B = "20508cde-b1f5-4d52-a932-a37f3e380e1b";
const SURVIVOR = "99999999-9999-4999-8999-999999999999";

const closure = (overrides: Partial<ExclusionClosure> = {}): ExclusionClosure => ({ ...emptyClosure(), ...overrides });

describe("excluded task id parsing", () => {
  it("accepts repeated flags and comma lists, dedupes and sorts them", () => {
    expect(parseExcludedTaskIds([A, B, A])).toEqual([B, A].sort());
    expect(parseExcludedTaskIds([`${A},${B}`])).toEqual([B, A].sort());
    expect(parseExcludedTaskIds([` ${A} `, ""])).toEqual([A]);
  });

  it("is deterministic regardless of the order the caller supplied", () => {
    expect(parseExcludedTaskIds([A, B])).toEqual(parseExcludedTaskIds([B, A]));
  });

  it("rejects anything that is not an exact UUID", () => {
    for (const invalid of ["MOMNA-CLOUD-RUN-STARTUP-CONTRACT", "410f320b", `${A}x`, "not-a-uuid", "410f320b_af24_48d2_b29b_b4506293b8ba"]) {
      expect(() => parseExcludedTaskIds([invalid])).toThrow(/not a UUID/);
    }
  });

  it("returns nothing when no exclusion was requested", () => {
    expect(parseExcludedTaskIds([])).toEqual([]);
    expect(parseExcludedTaskIds([""])).toEqual([]);
  });
});

describe("closure shape", () => {
  it("holds exactly the explicit denylist as its task set", () => {
    // Nothing may ever be added to `tasks` by inference; the entrypoint fills it from the CLI ids.
    expect(emptyClosure().tasks).toEqual([]);
    expect(Object.keys(emptyClosure()).sort()).toEqual(["adminOperations", "artifacts", "auditEvents", "executionJobs", "operationIds", "runs", "taskTransitions", "tasks"]);
  });

  it("maps every closure category onto the table it filters", () => {
    const full = closure({ tasks: [A], runs: ["r"], executionJobs: ["j"], artifacts: ["a"], taskTransitions: ["t"], auditEvents: ["e"] });
    expect(excludedIdsForTable(full, "tasks")).toEqual([A]);
    expect(excludedIdsForTable(full, "runs")).toEqual(["r"]);
    expect(excludedIdsForTable(full, "execution_jobs")).toEqual(["j"]);
    expect(excludedIdsForTable(full, "artifacts")).toEqual(["a"]);
    expect(excludedIdsForTable(full, "task_transitions")).toEqual(["t"]);
    expect(excludedIdsForTable(full, "audit_events")).toEqual(["e"]);
  });

  it("never filters a table that carries no task reference", () => {
    const full = closure({ tasks: [A], runs: ["r"], artifacts: ["a"] });
    for (const table of ["projects", "resources", "project_contexts", "canonical_development_repositories", "system_settings", "console_screens", "migration_markers"]) {
      expect(excludedIdsForTable(full, table), `${table} must be copied whole`).toEqual([]);
    }
    // adminOperationSchema declares no task reference, so nothing there can be proved stale.
    expect(excludedIdsForTable(full, "admin_operations")).toEqual([]);
  });

  it("counts the closure per table and in total", () => {
    const full = closure({ tasks: [A, B], runs: ["r"], artifacts: ["a1", "a2", "a3"] });
    expect(closureCounts(full)).toEqual({ tasks: 2, runs: 1, artifacts: 3, executionJobs: 0, taskTransitions: 0, auditEvents: 0, adminOperations: 0 });
    expect(closureTotal(full)).toBe(6);
    expect(closureTotal(emptyClosure())).toBe(0);
  });

  it("cascades only through ownership: foreign keys, the canonical audit path and the operation key", () => {
    const references = structuredTaskReferences.map(entry => entry.reference);
    expect(references).toEqual([
      "runs.task_id",
      "artifacts.task_id",
      "artifacts.run_id",
      "execution_jobs.task_id",
      "execution_jobs.run_id",
      "task_transitions.task_id",
      "audit_events.data->>'taskId'",
      "runs.operation_id",
      "execution_jobs.operation_id",
      "admin_operations.operation_id",
      "audit_events.data->>'correlationId'",
    ]);
    for (const entry of structuredTaskReferences) {
      expect(["FOREIGN_KEY", "CANONICAL_JSON_PATH", "OPERATION_SOURCE", "CANONICAL_OPERATION_KEY"]).toContain(entry.kind);
    }
  });

  it("never cascades along a relationship edge", () => {
    // The final policy: a relationship is a reference, not ownership. No relationship type may pull
    // a task into the closure -- the edge is normalized away instead, and the task survives.
    expect(structuredTaskReferences.map(entry => entry.reference).join(" ")).not.toContain("relationships");
    expect(RELATIONSHIP_NORMALIZED_TABLE).toBe("tasks");
  });

  it("allows an exact-scalar JSON match only for the historical tables", () => {
    expect([...historicalTables]).toEqual(["artifacts", "audit_events", "admin_operations"]);
    for (const table of ["tasks", "runs", "execution_jobs", "task_transitions", "projects", "resources"]) {
      expect(isHistoricalTable(table), `${table} must never leave on JSON evidence`).toBe(false);
    }
  });

  it("collects the needles a historical row may be matched against", () => {
    const full = closure({ tasks: [A, B], runs: ["run-1"], operationIds: ["op-1"], artifacts: ["artifact-1"] });
    // Artifact and job ids are deliberately absent: a row is proved stale by naming the task, the
    // run or the operation, not by naming another piece of evidence.
    expect([...closureNeedles(full)].sort()).toEqual([A, B, "op-1", "run-1"].sort());
  });

  it("caps reported id samples", () => {
    expect(sample(Array.from({ length: 100 }, (_, index) => `id-${index}`))).toHaveLength(SAMPLE_LIMIT);
  });

});

describe("exclusion-aware paged read", () => {
  it("binds the denylist as a parameter and keeps primary-key order", () => {
    expect(selectPageSqlExcluding(tablePlan("tasks"))).toBe(
      'SELECT "id","project_id","external_key","data","created_at" FROM "tasks" WHERE "id"::text <> ALL($3::text[]) ORDER BY "id" LIMIT $1 OFFSET $2',
    );
    expect(selectPageSqlExcluding(tablePlan("audit_events"))).toContain('WHERE "id"::text <> ALL($3::text[])');
    // admin_operations is text-keyed; one predicate shape serves both.
    expect(selectPageSqlExcluding(tablePlan("admin_operations"))).toContain('WHERE "operation_id"::text <> ALL($3::text[])');
  });

  it("selects the same columns as the unfiltered read, so excluded rows are the only difference", () => {
    for (const table of ["tasks", "runs", "artifacts", "execution_jobs", "task_transitions", "audit_events"]) {
      const entry = tablePlan(table);
      expect(selectPageSqlExcluding(entry).startsWith(`SELECT ${entry.columns.map(column => `"${column}"`).join(",")} FROM "${table}"`)).toBe(true);
    }
  });

  it("never puts an id into the statement text", () => {
    expect(selectPageSqlExcluding(tablePlan("tasks"))).not.toContain(A);
  });
});

describe("transient task gate", () => {
  it("lets an excluded task through without blocking, because it is never copied", () => {
    const gate = evaluateTransientTaskGate({ transient: [{ taskId: A, state: "IMPLEMENTING" }, { taskId: B, state: "IMPLEMENTING" }], excludedTaskIds: [A, B] });
    expect(gate.blocked).toBe(false);
    expect(gate.excluded).toHaveLength(2);
    expect(gate.blocking).toEqual([]);
  });

  it("blocks on a seventh transient task that is not on the denylist", () => {
    const gate = evaluateTransientTaskGate({
      transient: [{ taskId: A, state: "IMPLEMENTING" }, { taskId: SURVIVOR, state: "IMPLEMENTING" }],
      excludedTaskIds: [A],
    });
    expect(gate.blocked).toBe(true);
    expect(gate.blocking).toEqual([{ taskId: SURVIVOR, state: "IMPLEMENTING" }]);
    expect(gate.excluded).toEqual([{ taskId: A, state: "IMPLEMENTING" }]);
  });

  it("blocks on any transient state, not just IMPLEMENTING", () => {
    expect(evaluateTransientTaskGate({ transient: [{ taskId: SURVIVOR, state: "TESTING" }], excludedTaskIds: [A] }).blocked).toBe(true);
    expect(evaluateTransientTaskGate({ transient: [{ taskId: SURVIVOR, state: "REVIEWING" }], excludedTaskIds: [] }).blocked).toBe(true);
  });

  it("passes a quiet source", () => {
    expect(evaluateTransientTaskGate({ transient: [], excludedTaskIds: [A] }).blocked).toBe(false);
  });

  it("matches ids case-insensitively but never by any other attribute", () => {
    expect(evaluateTransientTaskGate({ transient: [{ taskId: A.toUpperCase(), state: "IMPLEMENTING" }], excludedTaskIds: [A] }).blocked).toBe(false);
  });
});

describe("exact scalar classification", () => {
  const needles = new Set([A, "op-42"]);

  it("proves a reference when a leaf value IS the id, at any depth", () => {
    expect(classifyJsonReference({ taskId: A }, needles)).toBe("EXACT_SCALAR");
    expect(classifyJsonReference({ input: { nested: { taskId: A } } }, needles)).toBe("EXACT_SCALAR");
    expect(classifyJsonReference({ ids: ["other", A] }, needles)).toBe("EXACT_SCALAR");
    expect(classifyJsonReference({ result: { operationId: "op-42" } }, needles)).toBe("EXACT_SCALAR");
    expect(classifyJsonReference([{ correlationId: "op-42" }], needles)).toBe("EXACT_SCALAR");
  });

  it("refuses to treat a UUID buried in free text as a reference", () => {
    expect(classifyJsonReference({ reason: `rebased onto ${A} yesterday` }, needles)).toBe("MENTION_ONLY");
    expect(classifyJsonReference({ diff: `- id: ${A}\n+ id: other` }, needles)).toBe("MENTION_ONLY");
    expect(classifyJsonReference({ note: `${A} ` }, needles)).toBe("MENTION_ONLY");
    expect(classifyJsonReference({ note: `see-${A}` }, needles)).toBe("MENTION_ONLY");
  });

  it("prefers hard evidence when a document has both", () => {
    expect(classifyJsonReference({ taskId: A, reason: `about ${A}` }, needles)).toBe("EXACT_SCALAR");
  });

  it("reports nothing when the document does not involve an excluded id", () => {
    expect(classifyJsonReference({ taskId: SURVIVOR, reason: "unrelated" }, needles)).toBe("NONE");
    expect(classifyJsonReference({ taskId: A }, new Set())).toBe("NONE");
    expect(classifyJsonReference(null, needles)).toBe("NONE");
    expect(classifyJsonReference({ count: 42, ok: true }, needles)).toBe("NONE");
  });

  it("never matches on a key name, only on a value", () => {
    expect(classifyJsonReference({ [A]: "value" }, needles)).toBe("NONE");
  });
});

describe("relationship normalization", () => {
  const excluded = new Set([A, B]);
  const envelope = (relationships: unknown) => ({
    id: SURVIVOR, projectId: "p", externalKey: "CORE-BE-05-FINAL", title: "kept", description: "kept",
    requirements: ["kept"], state: "READY", repairAttempts: 0, relationships, createdAt: "x", updatedAt: "y",
  });

  it("removes only the edges naming an excluded task", () => {
    const result = stripExcludedRelationships(envelope([
      { type: "SUPERSEDES", targetTaskId: A },
      { type: "DEPENDS_ON", targetTaskId: SURVIVOR },
      { type: "RELATED_TO", targetTaskId: B },
    ]), excluded);
    expect(result.removedTargets).toEqual([A, B]);
    expect((result.data as { relationships: unknown[] }).relationships).toEqual([{ type: "DEPENDS_ON", targetTaskId: SURVIVOR }]);
  });

  it("changes no other field of the task envelope", () => {
    const original = envelope([{ type: "SUPERSEDES", targetTaskId: A }]);
    const result = stripExcludedRelationships(original, excluded) as { data: Record<string, unknown> };
    for (const key of Object.keys(original)) {
      if (key === "relationships") continue;
      expect(result.data[key], `${key} must be untouched`).toEqual((original as Record<string, unknown>)[key]);
    }
    expect(Object.keys(result.data).sort()).toEqual(Object.keys(original).sort());
  });

  it("returns the very same object when nothing is removed, so an untouched row hashes identically", () => {
    const original = envelope([{ type: "DEPENDS_ON", targetTaskId: SURVIVOR }]);
    const result = stripExcludedRelationships(original, excluded);
    expect(result.data).toBe(original);
    expect(result.removedTargets).toEqual([]);
    expect(hashRows([[original]])).toBe(hashRows([[result.data]]));
  });

  it("leaves a task with an empty or missing relationship list alone", () => {
    expect(stripExcludedRelationships(envelope([]), excluded).removedTargets).toEqual([]);
    const withoutField = { id: SURVIVOR, state: "READY" };
    expect(stripExcludedRelationships(withoutField, excluded).data).toBe(withoutField);
    expect(stripExcludedRelationships(null, excluded).data).toBeNull();
    expect(stripExcludedRelationships(envelope("not-an-array"), excluded).removedTargets).toEqual([]);
  });

  it("does nothing at all when no task is excluded", () => {
    const original = envelope([{ type: "SUPERSEDES", targetTaskId: A }]);
    expect(stripExcludedRelationships(original, new Set()).data).toBe(original);
  });

  it("ignores malformed edges instead of dropping them", () => {
    const original = envelope([{ type: "SUPERSEDES" }, "junk", null, { targetTaskId: 42 }]);
    const result = stripExcludedRelationships(original, excluded);
    expect(result.removedTargets).toEqual([]);
    expect(result.data).toBe(original);
  });
});

describe("exclusion is never derived from text", () => {
  const script = readFileSync(resolve(__dirname, "../../scripts/migrate-control-plane-state-next.ts"), "utf8");
  // Strictly the resolver: the relationship diagnostic and the identity reader that follow it are
  // reporting code, and they may read identity columns the closure itself must never consult.
  const resolver = script.slice(script.indexOf("async function resolveExclusion"), script.indexOf("/**\n * Which relationship edge actually pulled"));

  it("resolves the closure from foreign keys and the canonical audit path only", () => {
    expect(resolver).toContain("FROM runs WHERE task_id = ANY($1::uuid[])");
    expect(resolver).toContain("FROM execution_jobs WHERE task_id = ANY($1::uuid[]) OR run_id = ANY($2::uuid[])");
    expect(resolver).toContain("FROM artifacts WHERE task_id = ANY($1::uuid[]) OR run_id = ANY($2::uuid[])");
    expect(resolver).toContain("FROM task_transitions WHERE task_id = ANY($1::uuid[])");
    expect(resolver).toContain("FROM audit_events WHERE data->>'taskId' = ANY($1::text[])");
  });

  it("never selects rows for exclusion by title, external key, age or project", () => {
    for (const forbidden of ["external_key", "title", "created_at <", "project_id =", "ILIKE", "similar to"]) {
      expect(resolver.toLowerCase(), `${forbidden} must not decide an exclusion`).not.toContain(forbidden.toLowerCase());
    }
  });

  it("treats a free-text mention of an excluded id as ambiguous, never as a reason to drop a row", () => {
    // The LIKE scan exists, but it only ever *reports*: its rows go into `ambiguous`, which blocks
    // the copy for a human decision instead of removing anything.
    expect(resolver).toContain("LIKE '%' || needle || '%'");
    expect(resolver).toContain("ambiguous.push");
    expect(resolver).not.toMatch(/ambiguous[^]*closure\s*=/);
    const copyBody = script.slice(script.indexOf("async function copy()"), script.indexOf("async function verify()"));
    expect(copyBody).toContain("ambiguous.length");
    expect(copyBody).toContain("MigrationBlocked");
  });

  it("never queries tasks by relationship to decide the closure", () => {
    // The recursive dependent-task exclusion is gone: the resolver's only task query is the exact
    // denylist lookup. A relationship can no longer pull anything into the closure.
    expect(resolver).toContain("SELECT id FROM tasks WHERE id = ANY($1::uuid[])");
    expect(resolver).not.toContain("dependentsOf");
    expect(resolver).not.toContain("MAX_CLOSURE_ITERATIONS");
    expect(resolver).not.toMatch(/EXISTS \(SELECT 1 FROM jsonb_array_elements/);
    const copyBody = script.slice(script.indexOf("async function copy()"), script.indexOf("async function verify()"));
    expect(copyBody).not.toContain("unresolvedDependents");
  });

  it("normalizes a surviving task's edges instead of excluding it, and does not call that ambiguous", () => {
    expect(resolver).toContain("stripExcludedRelationships(row.data, excludedTasks)");
    expect(resolver).toContain("normalizedTasks.push");
    // Once the departed edges are gone the envelope must be clean; only then is the task fine.
    expect(resolver).toContain("classifyJsonReference(normalization.data, needles) === 'NONE'");
  });

  it("derives operation ids only from the excluded runs and jobs themselves", () => {
    expect(resolver).toContain("SELECT DISTINCT operation_id FROM runs WHERE id = ANY($1::uuid[])");
    expect(resolver).toContain("SELECT DISTINCT operation_id FROM execution_jobs WHERE id = ANY($1::uuid[])");
    expect(resolver).toContain("FROM admin_operations WHERE operation_id = ANY($1::text[])");
    expect(resolver).toContain("data->>'correlationId' = ANY($2::text[])");
    // Exact equality only -- no LIKE, prefix or name matching decides an operation.
    expect(resolver).not.toMatch(/operation_id\s+LIKE/);
    expect(resolver).not.toMatch(/operation_id.*\|\|\s*'%'/);
  });

  it("keeps the relationship diagnostic out of the closure decision entirely", () => {
    // It reads identity columns, so it must be reporting-only: computed for inventory, never fed
    // back into the closure, and never consulted by copy or verify.
    const diagnostic = script.slice(script.indexOf("async function dependentRelationshipEdges"), script.indexOf("/** Safe identity of the tasks the recursion pulled in"));
    expect(diagnostic).toContain("external_key");
    expect(diagnostic).toMatch(/^\s*SELECT|SELECT source\.id/m);
    expect(diagnostic).not.toMatch(/closure|proven|ambiguous\.push/);
    expect(script).toContain("options.relationshipDiagnostics ? await dependentRelationshipEdges");
    expect(script).toContain("{ relationshipDiagnostics: true }");
    const copyBody = script.slice(script.indexOf("async function copy()"), script.indexOf("async function verify()"));
    const verifyBody = script.slice(script.indexOf("async function verify()"), script.indexOf("// Reads -- every one of them takes a Query"));
    expect(copyBody).not.toContain("relationshipDiagnostics");
    expect(verifyBody).not.toContain("relationshipDiagnostics");
  });

  it("only lets a JSON document decide for a historical table", () => {
    expect(resolver).toContain("isHistoricalTable(entry.table)");
    expect(resolver).toContain("historical && classifyJsonReference(row.data, needles) === 'EXACT_SCALAR'");
    // An operational table never even fetches `data` -- except `tasks`, which needs it only to
    // normalize its own relationship edges, never to decide an exclusion.
    expect(resolver).toContain("${historical || normalizable ? ', data' : ''}");
    expect(resolver).toContain("entry.table === RELATIONSHIP_NORMALIZED_TABLE");
  });
});

describe("copy and verify honour the closure", () => {
  const script = readFileSync(resolve(__dirname, "../../scripts/migrate-control-plane-state-next.ts"), "utf8");

  it("filters the copy read itself, so an excluded row is never fetched or written", () => {
    const copyTable = script.slice(script.indexOf("async function copyTable"), script.indexOf("/** Every value crosses as a bound parameter"));
    expect(copyTable).toContain("selectPageSqlExcluding(entry)");
    expect(copyTable).toContain("excluded.length");
  });

  it("verifies target against source-minus-closure, normalized the same way the copy normalized it", () => {
    const verify = script.slice(script.indexOf("async function verify()"), script.indexOf("// ---------------------------------------------------------------------------\n// Reads"));
    expect(verify).toContain("hashTable(sourceQuery, entry, excluded, rowNormalizer(entry, resolved.closure))");
    expect(verify).toContain("hashTable(targetQuery, entry)");
    expect(verify).toContain("presentIds(targetQuery, entry, excluded)");
    expect(verify).toContain("absent.length === 0");
    expect(verify).toContain("danglingReferences(targetQuery)");
    expect(verify).toContain("danglingRelationshipTargets(targetQuery)");
    expect(verify).toContain("requiredTaskPresence(targetQuery, requiredTaskIds)");
    expect(verify).toContain("activeJobTally(sourceQuery)");
  });

  it("uses one shared normalizer, so copy and verify cannot disagree about the target contents", () => {
    const copyBody = script.slice(script.indexOf("async function copy()"), script.indexOf("async function verify()"));
    expect(copyBody).toContain("rowNormalizer(entry, resolved.closure)");
    const normalizer = script.slice(script.indexOf("function rowNormalizer"), script.indexOf("async function copyTable"));
    // It touches one field of one table and returns the row untouched otherwise.
    expect(normalizer).toContain("entry.table !== RELATIONSHIP_NORMALIZED_TABLE");
    expect(normalizer).toContain("if (!normalized.removedTargets.length) return row;");
    expect(normalizer).toContain("copy[dataIndex] = normalized.data;");
  });

  it("checks every declared child-to-parent edge for orphans", () => {
    const edges = script.slice(script.indexOf("const referenceEdges"), script.indexOf("async function danglingReferences"));
    for (const edge of ["runs', column: 'task_id", "artifacts', column: 'task_id", "artifacts', column: 'run_id", "execution_jobs', column: 'task_id", "execution_jobs', column: 'run_id", "task_transitions', column: 'task_id"]) {
      expect(edges).toContain(edge);
    }
  });
});
