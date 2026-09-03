import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Executes the real copy path against an in-memory database that honours the denylist predicate the
// way PostgreSQL would, so "the excluded task never reaches the target" is proven by what actually
// gets inserted rather than by reading the source. No database, no network, no credential.

const STALE_TASK = "410f320b-af24-48d2-b29b-b4506293b8ba";
const STALE_RUN = "aaaaaaaa-0000-4000-8000-000000000001";
const STALE_ARTIFACT = "aaaaaaaa-0000-4000-8000-000000000002";
const STALE_JOB = "aaaaaaaa-0000-4000-8000-000000000003";
const STALE_TRANSITION = "aaaaaaaa-0000-4000-8000-000000000004";
const STALE_AUDIT = "aaaaaaaa-0000-4000-8000-000000000005";
const LIVE_TASK = "bbbbbbbb-0000-4000-8000-000000000001";
const LIVE_RUN = "bbbbbbbb-0000-4000-8000-000000000002";
const LIVE_ARTIFACT = "bbbbbbbb-0000-4000-8000-000000000003";
const LIVE_AUDIT = "bbbbbbbb-0000-4000-8000-000000000004";
const SEVENTH_TASK = "cccccccc-0000-4000-8000-000000000001";
const PROJECT = "22222222-2222-4222-8222-222222222222";

const { FakeClient, db } = vi.hoisted(() => {
  interface Row { [column: string]: unknown }
  const db = {
    tables: {} as Record<string, Row[]>,
    inserts: [] as Array<{ table: string; columns: string[]; rows: unknown[][] }>,
    sourceStatements: [] as string[],
    targetStatements: [] as string[],
    sourceUrl: "",
    reset(tables: Record<string, Row[]>, sourceUrl: string) {
      this.tables = tables; this.inserts = []; this.sourceStatements = []; this.targetStatements = []; this.sourceUrl = sourceUrl;
    },
    rows(table: string): Row[] { return this.tables[table] ?? []; },
    insertedIds(table: string): string[] {
      return this.inserts.filter(entry => entry.table === table).flatMap(entry => {
        const index = entry.columns.indexOf(entry.columns.includes("operation_id") && table === "admin_operations" ? "operation_id" : "id");
        return entry.rows.map(row => String(row[index]));
      });
    },
    insertedRow(table: string, id: string): Record<string, unknown> | undefined {
      for (const entry of this.inserts.filter(value => value.table === table)) {
        const index = entry.columns.indexOf("id");
        const row = entry.rows.find(candidate => String(candidate[index]) === id);
        if (row) return Object.fromEntries(entry.columns.map((column, position) => [column, row[position]]));
      }
      return undefined;
    },
  };

  const asArray = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

  const answer = (text: string, values: unknown[]): unknown[] => {
    const flat = text.replace(/\s+/g, " ").trim();
    if (/FROM pg_class/.test(flat)) return Object.keys(db.tables).map(relname => ({ relname }));
    if (/pg_try_advisory_xact_lock/.test(flat)) return [{ locked: true }];
    if (/count\(\*\)::bigint AS count FROM "/.test(flat)) return [{ count: "0" }];
    if (/^SELECT status, count\(\*\)::bigint AS count FROM execution_jobs/.test(flat)) {
      const statuses = asArray(values[0]);
      return [...new Set(db.rows("execution_jobs").map(row => String(row["status"])))]
        .filter(status => statuses.includes(status))
        .map(status => ({ status, count: String(db.rows("execution_jobs").filter(row => row["status"] === status).length) }));
    }
    if (/^SELECT id FROM execution_jobs WHERE status = ANY/.test(flat)) {
      const statuses = asArray(values[0]);
      return db.rows("execution_jobs").filter(row => statuses.includes(String(row["status"]))).map(row => ({ id: row["id"] }));
    }
    if (/count\(\*\)::bigint AS count FROM tasks/.test(flat)) {
      const states = asArray(values[0]);
      return [...new Set(db.rows("tasks").map(row => String(row["state"])))]
        .filter(state => states.includes(state))
        .map(state => ({ state, count: String(db.rows("tasks").filter(row => row["state"] === state).length) }));
    }
    // Closure resolution -- foreign keys and the canonical audit path.
    if (/^SELECT id FROM tasks WHERE id = ANY/.test(flat)) return db.rows("tasks").filter(row => asArray(values[0]).includes(String(row["id"]))).map(row => ({ id: row["id"] }));
    if (/^SELECT id FROM runs WHERE task_id = ANY/.test(flat)) return db.rows("runs").filter(row => asArray(values[0]).includes(String(row["task_id"]))).map(row => ({ id: row["id"] }));
    if (/^SELECT id FROM execution_jobs WHERE task_id = ANY/.test(flat)) return db.rows("execution_jobs").filter(row => asArray(values[0]).includes(String(row["task_id"])) || asArray(values[1]).includes(String(row["run_id"]))).map(row => ({ id: row["id"] }));
    if (/^SELECT id FROM artifacts WHERE task_id = ANY/.test(flat)) return db.rows("artifacts").filter(row => asArray(values[0]).includes(String(row["task_id"])) || asArray(values[1]).includes(String(row["run_id"]))).map(row => ({ id: row["id"] }));
    if (/^SELECT id FROM task_transitions WHERE task_id = ANY/.test(flat)) return db.rows("task_transitions").filter(row => asArray(values[0]).includes(String(row["task_id"]))).map(row => ({ id: row["id"] }));
    if (/^SELECT id FROM audit_events WHERE data->>'taskId' = ANY/.test(flat)) return db.rows("audit_events").filter(row => asArray(values[0]).includes(String((row["data"] as Record<string, unknown>)?.["taskId"]))).map(row => ({ id: row["id"] }));
    if (/EXISTS \(SELECT 1 FROM jsonb_array_elements/.test(flat)) return db.rows("tasks").filter(row => !asArray(values[0]).includes(String(row["id"])) && (row["relationshipTargets"] as string[] | undefined)?.some(target => asArray(values[1]).includes(target))).map(row => ({ id: row["id"] }));
    if (/EXISTS \(SELECT 1 FROM unnest/.test(flat)) {
      const table = /FROM "(\w+)"/.exec(flat)?.[1] ?? "";
      const excluded = asArray(values[0]);
      const needles = asArray(values[1]);
      const key = table === "admin_operations" ? "operation_id" : table === "system_settings" ? "key" : table === "console_screens" ? "screen_id" : table === "migration_markers" ? "key" : "id";
      return db.rows(table)
        .filter(row => !excluded.includes(String(row[key])) && needles.some(needle => JSON.stringify(row["data"] ?? {}).includes(needle)))
        .map(row => ({ id: row[key] }));
    }
    if (/^SELECT id, data->>'state' AS state FROM tasks/.test(flat)) {
      const states = asArray(values[0]);
      return db.rows("tasks").filter(row => states.includes(String(row["state"]))).map(row => ({ id: row["id"], state: row["state"] }));
    }
    // The paged reads copy and verify use: columns and key come from the statement itself, so the
    // fake stays in step with whatever the plan asks for.
    const paged = /^SELECT (.+?) FROM "(\w+)"(?: WHERE "(\w+)"::text <> ALL\(\$3::text\[\]\))? ORDER BY (.+?) LIMIT \$1 OFFSET \$2$/.exec(flat);
    if (paged) {
      const columns = (paged[1] as string).split(",").map(column => column.replace(/"/g, "").trim());
      const table = paged[2] as string;
      const key = (paged[3] ?? (paged[4] as string).replace(/"/g, "").split(",")[0]) as string;
      const excluded = paged[3] ? asArray(values[2]) : [];
      const limit = Number(values[0]);
      const offset = Number(values[1]);
      return db.rows(table)
        .filter(row => !excluded.includes(String(row[key])))
        .sort((left, right) => String(left[key]).localeCompare(String(right[key])))
        .slice(offset, offset + limit)
        .map(row => columns.map(column => row[column] ?? null));
    }
    return [];
  };

  class FakeClient {
    private readonly connection: string;
    constructor(config: { connectionString: string }) { this.connection = config.connectionString; }
    async connect(): Promise<void> { /* no socket */ }
    async end(): Promise<void> { /* nothing to close */ }
    async query(config: string | { text: string; values?: unknown[] }, values?: unknown[]): Promise<{ rows: unknown[] }> {
      const text = typeof config === "string" ? config : config.text;
      const bound = ((typeof config === "string" ? values : config.values) ?? []) as unknown[];
      (this.connection === db.sourceUrl ? db.sourceStatements : db.targetStatements).push(text.replace(/\s+/g, " ").trim());
      const insert = /^INSERT INTO "(\w+)" \((.+?)\) VALUES/.exec(text.replace(/\s+/g, " ").trim());
      if (insert) {
        const columns = (insert[2] as string).split(",").map(column => column.replace(/"/g, "").trim());
        const rows: unknown[][] = [];
        for (let index = 0; index < bound.length; index += columns.length) rows.push(bound.slice(index, index + columns.length));
        db.inserts.push({ table: insert[1] as string, columns, rows });
        return { rows: [] };
      }
      return { rows: answer(text.replace(/\s+/g, " ").trim(), bound) };
    }
  }
  return { FakeClient, db };
});

vi.mock("pg", () => ({ Client: FakeClient }));

const SOURCE = "postgresql://copy-test:fake@source.invalid:5432/autopilot";
const TARGET = "postgresql://copy-test:fake@target.invalid:5432/autopilot";

type Tables = Record<string, Array<Record<string, unknown>>>;

/** One task each: the stale one being excluded, and a live one that must cross untouched. */
function fixture(extra: { seventhTransientTask?: boolean } = {}): Tables {
  return {
    projects: [{ id: PROJECT, slug: "p", data: { id: PROJECT }, created_at: new Date("2026-01-01T00:00:00.000Z") }],
    tasks: [
      // Same external key as one of the real stale tasks: exclusion must not key off it.
      { id: LIVE_TASK, project_id: PROJECT, external_key: "CORE-BE-05", state: "READY", data: { id: LIVE_TASK, state: "READY", title: "live" }, created_at: new Date("2026-02-01T00:00:00.000Z") },
      { id: STALE_TASK, project_id: PROJECT, external_key: "SELF-REPAIR-ARGV-META-1", state: "IMPLEMENTING", data: { id: STALE_TASK, state: "IMPLEMENTING", title: "stale" }, created_at: new Date("2026-02-02T00:00:00.000Z") },
      ...(extra.seventhTransientTask ? [{ id: SEVENTH_TASK, project_id: PROJECT, external_key: "SEVENTH", state: "IMPLEMENTING", data: { id: SEVENTH_TASK, state: "IMPLEMENTING" }, created_at: new Date("2026-02-03T00:00:00.000Z") }] : []),
    ],
    runs: [
      { id: LIVE_RUN, project_id: PROJECT, task_id: LIVE_TASK, operation_id: "op-live", data: { id: LIVE_RUN }, created_at: new Date("2026-02-01T00:00:00.000Z") },
      { id: STALE_RUN, project_id: PROJECT, task_id: STALE_TASK, operation_id: "op-stale", data: { id: STALE_RUN }, created_at: new Date("2026-02-02T00:00:00.000Z") },
    ],
    artifacts: [
      { id: LIVE_ARTIFACT, project_id: PROJECT, task_id: LIVE_TASK, run_id: LIVE_RUN, kind: "CODE_DIFF", status: "AVAILABLE", content_hash: "h1", storage_bucket: "autopilot-artifacts", storage_path: `${PROJECT}/${LIVE_ARTIFACT}.json`, byte_size: "10", data: { id: LIVE_ARTIFACT, storage: { provider: "supabase" } }, created_at: new Date("2026-02-01T00:00:00.000Z") },
      { id: STALE_ARTIFACT, project_id: PROJECT, task_id: STALE_TASK, run_id: STALE_RUN, kind: "CODE_DIFF", status: "AVAILABLE", content_hash: "h2", storage_bucket: "autopilot-artifacts", storage_path: `${PROJECT}/${STALE_ARTIFACT}.json`, byte_size: "10", data: { id: STALE_ARTIFACT, storage: { provider: "supabase" } }, created_at: new Date("2026-02-02T00:00:00.000Z") },
    ],
    execution_jobs: [
      { id: STALE_JOB, project_id: PROJECT, task_id: STALE_TASK, resource_id: PROJECT, run_id: STALE_RUN, operation_id: "op-stale", kind: "IMPLEMENTATION", status: "FAILED", attempt: 1, workflow_run_id: null, lease_owner: null, lease_expires_at: null, data: { id: STALE_JOB }, created_at: new Date("2026-02-02T00:00:00.000Z"), updated_at: new Date("2026-02-02T00:00:00.000Z") },
    ],
    task_transitions: [
      { id: STALE_TRANSITION, task_id: STALE_TASK, data: { id: STALE_TRANSITION }, created_at: new Date("2026-02-02T00:00:00.000Z") },
    ],
    audit_events: [
      { id: LIVE_AUDIT, project_id: PROJECT, data: { id: LIVE_AUDIT, taskId: LIVE_TASK }, created_at: new Date("2026-02-01T00:00:00.000Z") },
      { id: STALE_AUDIT, project_id: PROJECT, data: { id: STALE_AUDIT, taskId: STALE_TASK }, created_at: new Date("2026-02-02T00:00:00.000Z") },
    ],
    resources: [], project_contexts: [], admin_operations: [], canonical_development_repositories: [],
    system_settings: [], console_screens: [], migration_markers: [],
  };
}

interface RunResult { logs: string[]; errors: string[]; failure: unknown; exitCode: number }

async function runCopy(options: { exclude: string[]; tables: Record<string, Array<Record<string, unknown>>> }): Promise<RunResult> {
  db.reset(options.tables, SOURCE);
  process.argv = ["node", "migrate-control-plane-state-next.ts", "--mode", "copy", ...options.exclude.flatMap(id => ["--exclude-task-id", id])];
  process.env["SOURCE_DATABASE_URL"] = SOURCE;
  process.env["TARGET_DATABASE_URL"] = TARGET;
  process.exitCode = 0;
  const logs: string[] = [];
  const errors: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation(message => { logs.push(String(message)); });
  const error = vi.spyOn(console, "error").mockImplementation(message => { errors.push(String(message)); });
  let failure: unknown;
  vi.resetModules();
  try {
    await import("../../scripts/migrate-control-plane-state-next.js");
  } catch (thrown) {
    failure = thrown;
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return { logs, errors, failure, exitCode: process.exitCode ?? 0 };
}

const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
  delete process.env["SOURCE_DATABASE_URL"];
  delete process.env["TARGET_DATABASE_URL"];
  process.exitCode = 0;
});

describe("copy with an exclusion closure", () => {
  let result: RunResult;
  beforeEach(async () => { result = await runCopy({ exclude: [STALE_TASK], tables: fixture() }); });

  it("completes without error", () => {
    expect(result.failure).toBeUndefined();
    expect(result.errors).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("never inserts the excluded task", () => {
    expect(db.insertedIds("tasks")).toEqual([LIVE_TASK]);
    expect(db.insertedIds("tasks")).not.toContain(STALE_TASK);
  });

  it("never inserts the excluded task's run, artifact, execution job or transition", () => {
    expect(db.insertedIds("runs")).toEqual([LIVE_RUN]);
    expect(db.insertedIds("artifacts")).toEqual([LIVE_ARTIFACT]);
    expect(db.insertedIds("execution_jobs")).toEqual([]);
    expect(db.insertedIds("task_transitions")).toEqual([]);
  });

  it("never inserts the audit row whose canonical taskId is the excluded task", () => {
    expect(db.insertedIds("audit_events")).toEqual([LIVE_AUDIT]);
  });

  it("copies every unrelated row unchanged", () => {
    expect(db.insertedIds("projects")).toEqual([PROJECT]);
    const artifact = db.insertedRow("artifacts", LIVE_ARTIFACT);
    const original = (fixture()["artifacts"] ?? []).find(row => row["id"] === LIVE_ARTIFACT);
    expect(artifact?.["content_hash"]).toBe(original?.["content_hash"]);
    expect(artifact?.["storage_bucket"]).toBe(original?.["storage_bucket"]);
    expect(artifact?.["storage_path"]).toBe(original?.["storage_path"]);
    // The persisted storage provider is untouched, so the legacy reader still resolves it.
    expect((artifact?.["data"] as { storage: { provider: string } }).storage.provider).toBe("supabase");
    expect(db.insertedRow("tasks", LIVE_TASK)?.["external_key"]).toBe("CORE-BE-05");
  });

  it("does not exclude by external key: a live task sharing a stale task's key still crosses", () => {
    expect(db.insertedRow("tasks", LIVE_TASK)?.["external_key"]).toBe("CORE-BE-05");
    expect(db.insertedIds("tasks")).toContain(LIVE_TASK);
  });

  it("leaves no dangling reference among the inserted rows", () => {
    const tasks = new Set(db.insertedIds("tasks"));
    const runs = new Set(db.insertedIds("runs"));
    for (const entry of db.inserts.filter(value => ["runs", "artifacts", "execution_jobs", "task_transitions"].includes(value.table))) {
      const taskIndex = entry.columns.indexOf("task_id");
      const runIndex = entry.columns.indexOf("run_id");
      for (const row of entry.rows) {
        if (taskIndex >= 0 && row[taskIndex]) expect(tasks, `${entry.table}.task_id must point at a copied task`).toContain(String(row[taskIndex]));
        if (runIndex >= 0 && row[runIndex]) expect(runs, `${entry.table}.run_id must point at a copied run`).toContain(String(row[runIndex]));
      }
    }
  });

  it("emits the exclusion plan before the first write", () => {
    const plan = result.logs.map(line => JSON.parse(line) as Record<string, unknown>).find(entry => entry["event"] === "control_plane_state.exclusion_plan");
    expect(plan).toBeDefined();
    expect(plan?.["excluded"]).toEqual({ tasks: 1, runs: 1, artifacts: 1, executionJobs: 1, taskTransitions: 1, auditEvents: 1, adminOperations: 0 });
    expect((plan?.["excludedIds"] as { tasks: string[] }).tasks).toEqual([STALE_TASK]);
  });

  it("issues no write statement of any kind against the source", () => {
    expect(db.sourceStatements.length).toBeGreaterThan(0);
    for (const statement of db.sourceStatements) {
      expect(statement).not.toMatch(/^(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|COMMIT)\b/i);
    }
    expect(db.sourceStatements[0]).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(db.inserts.every(entry => entry.table.length > 0)).toBe(true);
    expect(db.targetStatements.some(statement => /^INSERT INTO/.test(statement))).toBe(true);
  });

  it("does not mutate the source representation", () => {
    expect(db.rows("tasks").map(row => row["id"])).toEqual([LIVE_TASK, STALE_TASK]);
    expect(db.rows("tasks").find(row => row["id"] === STALE_TASK)?.["state"]).toBe("IMPLEMENTING");
  });
});

describe("copy gates", () => {
  it("blocks on a seventh transient task that was not excluded, before any write", async () => {
    const result = await runCopy({ exclude: [STALE_TASK], tables: fixture({ seventhTransientTask: true }) });
    expect(result.exitCode).toBe(1);
    expect(db.inserts).toEqual([]);
    const blocked = result.errors.map(line => JSON.parse(line) as Record<string, unknown>).find(entry => entry["event"] === "control_plane_state.blocked");
    expect((blocked?.["blockingTransientTasks"] as Array<{ taskId: string }>)[0]?.taskId).toBe(SEVENTH_TASK);
    expect((blocked?.["excludedTransientTasks"] as Array<{ taskId: string }>)[0]?.taskId).toBe(STALE_TASK);
  });

  it("blocks while the stale task is still transient and NOT excluded", async () => {
    const result = await runCopy({ exclude: [], tables: fixture() });
    expect(result.exitCode).toBe(1);
    expect(db.inserts).toEqual([]);
  });

  it("blocks on an active execution job even when every transient task is excluded", async () => {
    const tables = fixture();
    tables["execution_jobs"] = [{ ...(tables["execution_jobs"] ?? [])[0], status: "RUNNING" }];
    const result = await runCopy({ exclude: [STALE_TASK], tables });
    expect(result.exitCode).toBe(1);
    expect(db.inserts).toEqual([]);
  });

  it("blocks when a surviving task depends on an excluded one instead of rewriting it", async () => {
    const tables = fixture();
    tables["tasks"] = (tables["tasks"] ?? []).map(row => (row["id"] === LIVE_TASK ? { ...row, relationshipTargets: [STALE_TASK] } : row));
    const result = await runCopy({ exclude: [STALE_TASK], tables });
    expect(result.exitCode).toBe(1);
    expect(db.inserts).toEqual([]);
    const blocked = result.errors.map(line => JSON.parse(line) as Record<string, unknown>).find(entry => entry["event"] === "control_plane_state.blocked");
    expect(blocked?.["tasksDependingOnExcludedTasks"]).toEqual([LIVE_TASK]);
  });

  it("blocks on an unresolvable JSON mention rather than dropping or copying it silently", async () => {
    const tables = fixture();
    // A surviving admin row that names the excluded task in free-form JSON. adminOperationSchema has
    // no task reference, so this cannot be proved stale -- and is never removed on that basis.
    tables.admin_operations = [{ operation_id: "op-1", actor: "a", tool: "t", project_id: PROJECT, data: { note: `see ${STALE_TASK}` }, created_at: new Date("2026-02-02T00:00:00.000Z") }];
    const result = await runCopy({ exclude: [STALE_TASK], tables });
    expect(result.exitCode).toBe(1);
    expect(db.inserts).toEqual([]);
    const blocked = result.errors.map(line => JSON.parse(line) as Record<string, unknown>).find(entry => entry["event"] === "control_plane_state.blocked");
    expect(blocked?.["ambiguousReferences"]).toEqual([{ table: "admin_operations", count: 1, sample: ["op-1"] }]);
  });
});
