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
    /** The target is a separate database: verify has to compare two different stores, not one. */
    targetTables: {} as Record<string, Row[]>,
    connection: "",
    inserts: [] as Array<{ table: string; columns: string[]; rows: unknown[][] }>,
    sourceStatements: [] as string[],
    targetStatements: [] as string[],
    sourceUrl: "",
    reset(tables: Record<string, Row[]>, sourceUrl: string, targetTables: Record<string, Row[]> = {}) {
      this.tables = tables; this.targetTables = targetTables; this.inserts = []; this.sourceStatements = []; this.targetStatements = []; this.sourceUrl = sourceUrl; this.connection = sourceUrl;
    },
    rows(table: string): Row[] { return (this.connection === this.sourceUrl ? this.tables : this.targetTables)[table] ?? []; },
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
  const edgesOf = (row: Row): Array<{ type: string; targetTaskId: string }> =>
    (((row["data"] ?? {}) as Record<string, unknown>)["relationships"] ?? []) as Array<{ type: string; targetTaskId: string }>;

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
    if (/^SELECT id FROM audit_events WHERE data->>'taskId' = ANY/.test(flat)) {
      return db.rows("audit_events")
        .filter(row => {
          const data = (row["data"] ?? {}) as Record<string, unknown>;
          return asArray(values[0]).includes(String(data["taskId"])) || asArray(values[1]).includes(String(data["correlationId"]));
        })
        .map(row => ({ id: row["id"] }));
    }
    if (/^SELECT DISTINCT operation_id FROM runs WHERE id = ANY/.test(flat)) {
      return [...new Set(db.rows("runs").filter(row => asArray(values[0]).includes(String(row["id"]))).map(row => String(row["operation_id"])))].map(operation_id => ({ operation_id }));
    }
    if (/^SELECT DISTINCT operation_id FROM execution_jobs WHERE id = ANY/.test(flat)) {
      return [...new Set(db.rows("execution_jobs").filter(row => asArray(values[0]).includes(String(row["id"]))).map(row => String(row["operation_id"])))].map(operation_id => ({ operation_id }));
    }
    if (/^SELECT operation_id FROM admin_operations WHERE operation_id = ANY/.test(flat)) {
      return db.rows("admin_operations").filter(row => asArray(values[0]).includes(String(row["operation_id"]))).map(row => ({ operation_id: row["operation_id"] }));
    }
    if (/^SELECT source.id AS source_task_id/.test(flat)) {
      const sources = asArray(values[0]);
      const targets = asArray(values[1]);
      const byId = new Map(db.rows("tasks").map(row => [String(row["id"]), row]));
      return db.rows("tasks")
        .filter(row => sources.includes(String(row["id"])))
        .flatMap(row => edgesOf(row)
          .filter(edge => targets.includes(edge.targetTaskId))
          .map(edge => ({
            source_task_id: row["id"],
            source_external_key: row["external_key"],
            source_state: (row["data"] as Record<string, unknown>)?.["state"] ?? null,
            relationship_type: edge.type,
            target_task_id: edge.targetTaskId,
            target_external_key: byId.get(edge.targetTaskId)?.["external_key"] ?? null,
            target_state: (byId.get(edge.targetTaskId)?.["data"] as Record<string, unknown> | undefined)?.["state"] ?? null,
          })))
        .sort((left, right) => `${left.source_task_id}${left.relationship_type}`.localeCompare(`${right.source_task_id}${right.relationship_type}`))
        .slice(0, Number(values[2]));
    }
    if (/^SELECT id, external_key, data->>'title' AS title/.test(flat)) {
      return db.rows("tasks")
        .filter(row => asArray(values[0]).includes(String(row["id"])))
        .sort((left, right) => String(left["id"]).localeCompare(String(right["id"])))
        .slice(0, Number(values[1]))
        .map(row => ({ id: row["id"], external_key: row["external_key"], title: (row["data"] as Record<string, unknown>)?.["title"] ?? null, state: (row["data"] as Record<string, unknown>)?.["state"] ?? null }));
    }
    // Verify-only reads.
    if (/^SELECT count\(\*\)::bigint AS count FROM "\w+" c LEFT JOIN/.test(flat)) {
      const edge = /FROM "(\w+)" c LEFT JOIN "(\w+)" p ON p\.id = c\."(\w+)"/.exec(flat);
      const [, child, parent, column] = edge as RegExpExecArray;
      const parents = new Set(db.rows(parent as string).map(row => String(row["id"])));
      const orphans = db.rows(child as string).filter(row => row[column as string] && !parents.has(String(row[column as string])));
      return [{ count: String(orphans.length) }];
    }
    if (/^SELECT count\(\*\)::bigint AS count FROM (runs|artifacts|execution_jobs|task_transitions|audit_events|admin_operations|tasks) WHERE/.test(flat) || /^SELECT count\(\*\)::bigint AS count FROM tasks WHERE EXISTS/.test(flat)) {
      const table = /FROM (\w+) WHERE/.exec(flat)?.[1] as string;
      const wanted = asArray(values[0]);
      const matches = db.rows(table).filter(row => {
        if (/EXISTS \(SELECT 1 FROM jsonb_array_elements/.test(flat)) return edgesOf(row).some(edge => wanted.includes(edge.targetTaskId));
        const column = /WHERE (?:data->>'(\w+)'|(\w+)(?:::text)?) = ANY/.exec(flat);
        const jsonKey = column?.[1];
        const plain = column?.[2];
        const value = jsonKey ? ((row["data"] ?? {}) as Record<string, unknown>)[jsonKey] : row[plain as string];
        return value !== null && value !== undefined && wanted.includes(String(value));
      });
      return [{ count: String(matches.length) }];
    }
    if (/^SELECT id, external_key, data->>'state' AS state FROM tasks WHERE id = ANY/.test(flat)) {
      return db.rows("tasks").filter(row => asArray(values[0]).includes(String(row["id"])))
        .map(row => ({ id: row["id"], external_key: row["external_key"], state: ((row["data"] ?? {}) as Record<string, unknown>)["state"] ?? null }));
    }
    if (/NOT EXISTS \(SELECT 1 FROM tasks target/.test(flat)) {
      const present = new Set(db.rows("tasks").map(row => String(row["id"])));
      return db.rows("tasks").flatMap(row => edgesOf(row).filter(edge => !present.has(edge.targetTaskId))
        .map(edge => ({ id: row["id"], target_task_id: edge.targetTaskId, relationship_type: edge.type })));
    }
    if (/EXISTS \(SELECT 1 FROM unnest/.test(flat)) {
      const table = /FROM "(\w+)"/.exec(flat)?.[1] ?? "";
      const excluded = asArray(values[0]);
      const needles = asArray(values[1]);
      const key = table === "admin_operations" ? "operation_id" : table === "system_settings" ? "key" : table === "console_screens" ? "screen_id" : table === "migration_markers" ? "key" : "id";
      // The real statement also selects `data` for the historical tables, so the exact-scalar walk
      // has something to classify.
      return db.rows(table)
        .filter(row => !excluded.includes(String(row[key])) && needles.some(needle => JSON.stringify(row["data"] ?? {}).includes(needle)))
        .sort((left, right) => String(left[key]).localeCompare(String(right[key])))
        .map(row => ({ id: row[key], data: row["data"] }));
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
      // Which store `answer` reads from: source and target are genuinely different databases.
      db.connection = this.connection;
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

async function runCopy(options: { exclude: string[]; tables: Record<string, Array<Record<string, unknown>>>; mode?: "copy" | "inventory" | "verify"; targetTables?: Record<string, Array<Record<string, unknown>>>; require?: string[] }): Promise<RunResult> {
  db.reset(options.tables, SOURCE, options.targetTables ?? {});
  process.argv = [
    "node", "migrate-control-plane-state-next.ts", "--mode", options.mode ?? "copy",
    ...options.exclude.flatMap(id => ["--exclude-task-id", id]),
    ...(options.require ?? []).flatMap(id => ["--require-task-id", id]),
  ];
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

  it("blocks on an operational row that only mentions an excluded id in free text", async () => {
    const tables = fixture();
    // A surviving RUN whose data merely contains the id inside a sentence. runs is operational, so
    // no JSON evidence can remove it -- and an unexplained reference must not be copied blindly.
    tables["runs"] = [...(tables["runs"] ?? []), { id: "dddddddd-0000-4000-8000-000000000001", project_id: PROJECT, task_id: LIVE_TASK, operation_id: "op-note", data: { note: `rebased away from ${STALE_TASK}` }, created_at: new Date("2026-02-04T00:00:00.000Z") }];
    const result = await runCopy({ exclude: [STALE_TASK], tables });
    expect(result.exitCode).toBe(1);
    expect(db.inserts).toEqual([]);
    const blocked = result.errors.map(line => JSON.parse(line) as Record<string, unknown>).find(entry => entry["event"] === "control_plane_state.blocked");
    expect(blocked?.["ambiguousReferences"]).toEqual([{ table: "runs", count: 1, sample: ["dddddddd-0000-4000-8000-000000000001"] }]);
  });

  it("blocks on an operational task that only mentions an excluded id in free text", async () => {
    const tables = fixture();
    tables["tasks"] = [...(tables["tasks"] ?? []), { id: "eeeeeeee-0000-4000-8000-000000000001", project_id: PROJECT, external_key: "NOTE", state: "READY", data: { description: `superseded ${STALE_TASK} eventually` }, created_at: new Date("2026-02-05T00:00:00.000Z") }];
    const result = await runCopy({ exclude: [STALE_TASK], tables });
    expect(result.exitCode).toBe(1);
    expect(db.inserts).toEqual([]);
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

const DEPENDENT = "dddddddd-1111-4000-8000-000000000001";
const SECOND_LEVEL = "dddddddd-2222-4000-8000-000000000001";
const DEPENDENT_RUN = "dddddddd-1111-4000-8000-000000000002";
const DEPENDENT_ARTIFACT = "dddddddd-1111-4000-8000-000000000003";
const DEPENDENT_TRANSITION = "dddddddd-1111-4000-8000-000000000004";
const HISTORICAL_ARTIFACT = "dddddddd-3333-4000-8000-000000000001";
const HISTORICAL_AUDIT = "dddddddd-3333-4000-8000-000000000002";

/** The stale task, a task depending on it, a task depending on THAT, and history hanging off each. */
function recursiveFixture(): Tables {
  const base = fixture();
  return {
    ...base,
    tasks: [
      ...(base["tasks"] ?? []),
      // The replacement declares what it supersedes (epic-verification.ts), plus one edge that does
      // NOT point into the excluded set -- only the first may be normalized away.
      {
        id: DEPENDENT, project_id: PROJECT, external_key: "DEP-1", state: "READY",
        data: {
          id: DEPENDENT, state: "READY", title: "first level", description: "MUST NOT LEAK", requirements: ["MUST NOT LEAK"], repairAttempts: 0,
          relationships: [{ type: "SUPERSEDES", targetTaskId: STALE_TASK }, { type: "RELATED_TO", targetTaskId: LIVE_TASK }],
        },
        created_at: new Date("2026-02-03T00:00:00.000Z"),
      },
      {
        id: SECOND_LEVEL, project_id: PROJECT, external_key: "DEP-2", state: "READY",
        data: { id: SECOND_LEVEL, state: "READY", title: "second level", relationships: [{ type: "DEPENDS_ON", targetTaskId: DEPENDENT }] },
        created_at: new Date("2026-02-04T00:00:00.000Z"),
      },
    ],
    runs: [...(base["runs"] ?? []), { id: DEPENDENT_RUN, project_id: PROJECT, task_id: DEPENDENT, operation_id: "op-dependent", data: { id: DEPENDENT_RUN }, created_at: new Date("2026-02-03T00:00:00.000Z") }],
    artifacts: [
      ...(base["artifacts"] ?? []),
      { id: DEPENDENT_ARTIFACT, project_id: PROJECT, task_id: DEPENDENT, run_id: DEPENDENT_RUN, kind: "CODE_DIFF", status: "AVAILABLE", content_hash: "h3", storage_bucket: "autopilot-artifacts", storage_path: "x", byte_size: "10", data: { id: DEPENDENT_ARTIFACT }, created_at: new Date("2026-02-03T00:00:00.000Z") },
      // No task_id/run_id at all: only an exact scalar deep in its JSON ties it to the stale run.
      { id: HISTORICAL_ARTIFACT, project_id: PROJECT, task_id: null, run_id: null, kind: "REBASE_REPORT", status: "AVAILABLE", content_hash: "h4", storage_bucket: "autopilot-artifacts", storage_path: "y", byte_size: "10", data: { report: { sourceRunId: STALE_RUN } }, created_at: new Date("2026-02-03T00:00:00.000Z") },
    ],
    task_transitions: [...(base["task_transitions"] ?? []), { id: DEPENDENT_TRANSITION, task_id: DEPENDENT, data: { id: DEPENDENT_TRANSITION }, created_at: new Date("2026-02-03T00:00:00.000Z") }],
    audit_events: [
      ...(base["audit_events"] ?? []),
      // Tied only by correlationId == the stale job's operation id.
      { id: HISTORICAL_AUDIT, project_id: PROJECT, data: { id: HISTORICAL_AUDIT, correlationId: "op-stale", reason: "job finished" }, created_at: new Date("2026-02-02T00:00:00.000Z") },
    ],
    // Exact operation-id match with the stale run/job.
    admin_operations: [
      { operation_id: "op-stale", actor: "a", tool: "t", project_id: PROJECT, data: { operationId: "op-stale" }, created_at: new Date("2026-02-02T00:00:00.000Z") },
      { operation_id: "op-unrelated", actor: "a", tool: "t", project_id: PROJECT, data: { operationId: "op-unrelated" }, created_at: new Date("2026-02-02T00:00:00.000Z") },
    ],
  };
}

describe("final policy: referencing tasks survive with normalized edges", () => {
  let result: RunResult;
  beforeEach(async () => { result = await runCopy({ exclude: [STALE_TASK], tables: recursiveFixture() }); });

  it("completes without blocking", () => {
    expect(result.errors).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("keeps every task that merely REFERENCES an excluded task, at any depth", () => {
    expect(db.insertedIds("tasks")).toEqual([LIVE_TASK, DEPENDENT, SECOND_LEVEL].sort());
    expect(db.insertedIds("tasks")).not.toContain(STALE_TASK);
  });

  it("keeps the referencing task's own runs, artifacts and transitions", () => {
    expect(db.insertedIds("runs")).toEqual([LIVE_RUN, DEPENDENT_RUN].sort());
    expect(db.insertedIds("task_transitions")).toEqual([DEPENDENT_TRANSITION]);
    expect(db.insertedIds("artifacts")).toContain(DEPENDENT_ARTIFACT);
  });

  it("drops only the edge naming the excluded task, keeping the others", () => {
    const relationships = (db.insertedRow("tasks", DEPENDENT)?.["data"] as { relationships: Array<Record<string, string>> }).relationships;
    expect(relationships).toEqual([{ type: "RELATED_TO", targetTaskId: LIVE_TASK }]);
  });

  it("changes no other field of the normalized task", () => {
    const data = db.insertedRow("tasks", DEPENDENT)?.["data"] as Record<string, unknown>;
    const original = (recursiveFixture()["tasks"] ?? []).find(row => row["id"] === DEPENDENT)?.["data"] as Record<string, unknown>;
    for (const key of Object.keys(original)) {
      if (key === "relationships") continue;
      expect(data[key], `${key} must be untouched`).toEqual(original[key]);
    }
    expect(db.insertedRow("tasks", DEPENDENT)?.["external_key"]).toBe("DEP-1");
    expect(db.insertedRow("tasks", DEPENDENT)?.["state"]).toBeUndefined();
  });

  it("leaves a task whose edges all survive completely untouched", () => {
    const data = db.insertedRow("tasks", SECOND_LEVEL)?.["data"] as Record<string, unknown>;
    expect(data).toEqual((recursiveFixture()["tasks"] ?? []).find(row => row["id"] === SECOND_LEVEL)?.["data"]);
  });

  it("still excludes the admin operation whose operation_id equals an excluded run or job operation", () => {
    expect(db.insertedIds("admin_operations")).toEqual(["op-unrelated"]);
  });

  it("still excludes a historical artifact tied only by an exact scalar deep in its JSON", () => {
    expect(db.insertedIds("artifacts")).not.toContain(HISTORICAL_ARTIFACT);
    expect(db.insertedIds("artifacts")).toEqual([LIVE_ARTIFACT, DEPENDENT_ARTIFACT].sort());
  });

  it("still excludes an audit event tied only by its canonical correlationId", () => {
    expect(db.insertedIds("audit_events")).toEqual([LIVE_AUDIT]);
    expect(db.insertedIds("audit_events")).not.toContain(HISTORICAL_AUDIT);
  });

  it("reports the explicit exclusions and the normalized tasks separately", () => {
    const plan = result.logs.map(line => JSON.parse(line) as Record<string, unknown>).find(entry => entry["event"] === "control_plane_state.exclusion_plan");
    expect(plan?.["excludedTaskIds"]).toEqual([STALE_TASK]);
    expect(plan?.["tasksWithNormalizedRelationships"]).toEqual([
      { taskId: DEPENDENT, externalKey: "DEP-1", title: "first level", state: "READY", removedTargetTaskIds: [STALE_TASK] },
    ]);
    expect(plan?.["excludedOperationIds"]).toEqual(["op-stale"]);
    expect(plan?.["excluded"]).toEqual({ tasks: 1, runs: 1, artifacts: 2, executionJobs: 1, taskTransitions: 1, auditEvents: 2, adminOperations: 1 });
  });

  it("is deterministic whatever order the roots are given in", async () => {
    const first = result.logs.find(line => line.includes("exclusion_plan"));
    const rerun = await runCopy({ exclude: [STALE_TASK, STALE_TASK], tables: recursiveFixture() });
    const second = rerun.logs.find(line => line.includes("exclusion_plan"));
    expect(second).toBe(first);
  });

  it("keeps every unrelated row and never writes to the source", () => {
    expect(db.insertedIds("projects")).toEqual([PROJECT]);
    expect(db.insertedRow("tasks", LIVE_TASK)?.["external_key"]).toBe("CORE-BE-05");
    for (const statement of db.sourceStatements) expect(statement).not.toMatch(/^(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i);
  });

  it("computes no relationship diagnostics during a copy", () => {
    const plan = result.logs.map(line => JSON.parse(line) as Record<string, unknown>).find(entry => entry["event"] === "control_plane_state.exclusion_plan");
    expect(plan?.["dependentRelationshipEdges"]).toBeUndefined();
    expect(db.sourceStatements.some(statement => statement.includes("source_task_id"))).toBe(false);
  });
});

/**
 * The state a correct copy leaves behind, derived by hand from the source rather than from the copy
 * implementation: source minus the closure, with the one departed relationship edge removed.
 */
function migratedTargetTables(): Tables {
  const source = recursiveFixture();
  const excludedTasks = new Set([STALE_TASK]);
  const excludedRuns = new Set([STALE_RUN]);
  const keep = (rows: Array<Record<string, unknown>> | undefined, ids: Set<string>, key = "id") => (rows ?? []).filter(row => !ids.has(String(row[key])));
  return {
    projects: source["projects"] ?? [],
    resources: [], project_contexts: [], system_settings: [], console_screens: [], migration_markers: [], canonical_development_repositories: [],
    tasks: keep(source["tasks"], excludedTasks).map(row => {
      const data = row["data"] as Record<string, unknown>;
      const edges = (data["relationships"] ?? []) as Array<{ targetTaskId: string }>;
      const kept = edges.filter(edge => !excludedTasks.has(edge.targetTaskId));
      return kept.length === edges.length ? row : { ...row, data: { ...data, relationships: kept } };
    }),
    runs: keep(source["runs"], excludedRuns),
    artifacts: keep(source["artifacts"], new Set([STALE_ARTIFACT, HISTORICAL_ARTIFACT])),
    execution_jobs: keep(source["execution_jobs"], new Set([STALE_JOB])),
    task_transitions: keep(source["task_transitions"], new Set([STALE_TRANSITION])),
    audit_events: keep(source["audit_events"], new Set([STALE_AUDIT, HISTORICAL_AUDIT])),
    admin_operations: keep(source["admin_operations"], new Set(["op-stale"]), "operation_id"),
  };
}

describe("verify against a migrated target", () => {
  let result: RunResult;
  let report: Record<string, unknown>;

  beforeEach(async () => {
    result = await runCopy({
      mode: "verify",
      exclude: [STALE_TASK],
      require: [LIVE_TASK, DEPENDENT, SECOND_LEVEL],
      tables: recursiveFixture(),
      targetTables: migratedTargetTables(),
    });
    report = (result.logs.map(line => JSON.parse(line) as Record<string, unknown>).find(entry => entry["event"] === "control_plane_state.verify") ?? {}) as Record<string, unknown>;
  });

  it("runs to completion with no ReferenceError from an uninitialised binding", () => {
    // The regression: `const referenceEdges` sat below the module's top-level await, so verify threw
    // "Cannot access 'referenceEdges' before initialization" the moment it reached danglingReferences.
    if (result.failure instanceof ReferenceError) throw new Error(`verify hit a temporal-dead-zone error: ${result.failure.message}`);
    expect(result.failure).toBeUndefined();
    expect(result.errors).toEqual([]);
  });

  it("reaches danglingReferences and actually checks every declared edge", () => {
    const joins = db.targetStatements.filter(statement => /LEFT JOIN "\w+" p ON p\.id = c\./.test(statement));
    expect(joins).toHaveLength(6);
    for (const edge of ['FROM "runs" c LEFT JOIN "tasks" p', 'FROM "artifacts" c LEFT JOIN "tasks" p', 'FROM "artifacts" c LEFT JOIN "runs" p', 'FROM "execution_jobs" c LEFT JOIN "tasks" p', 'FROM "execution_jobs" c LEFT JOIN "runs" p', 'FROM "task_transitions" c LEFT JOIN "tasks" p']) {
      expect(joins.some(statement => statement.includes(edge)), `${edge} must be checked`).toBe(true);
    }
    expect(report["dangling"]).toEqual([]);
  });

  it("reports MATCH for a correctly migrated target", () => {
    expect(report["result"]).toBe("MATCH");
    expect(result.exitCode).toBe(0);
    expect(report["survivingReferences"]).toEqual([]);
    expect(report["danglingRelationships"]).toEqual([]);
    expect(report["activeExecutionJobsInSource"]).toEqual([]);
  });

  it("confirms the required tasks are present with their state", () => {
    expect(report["requiredTasks"]).toEqual([
      { taskId: LIVE_TASK, present: true, externalKey: "CORE-BE-05", state: "READY" },
      { taskId: DEPENDENT, present: true, externalKey: "DEP-1", state: "READY" },
      { taskId: SECOND_LEVEL, present: true, externalKey: "DEP-2", state: "READY" },
    ]);
  });

  it("fails when a required task is missing from the target", async () => {
    const target = migratedTargetTables();
    target["tasks"] = (target["tasks"] ?? []).filter(row => row["id"] !== DEPENDENT);
    const missing = await runCopy({ mode: "verify", exclude: [STALE_TASK], require: [DEPENDENT], tables: recursiveFixture(), targetTables: target });
    expect(missing.exitCode).toBe(1);
    const failed = missing.logs.map(line => JSON.parse(line) as Record<string, unknown>).find(entry => entry["event"] === "control_plane_state.verify");
    expect(failed?.["result"]).toBe("MISMATCH");
    expect((failed?.["requiredTasks"] as Array<Record<string, unknown>>)[0]?.["present"]).toBe(false);
  });

  it("writes nothing to either database and copies nothing", () => {
    expect(db.inserts).toEqual([]);
    for (const statement of [...db.sourceStatements, ...db.targetStatements]) {
      expect(statement).not.toMatch(/^(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|COMMIT)\b/i);
    }
    expect(db.targetStatements.some(statement => statement === "BEGIN")).toBe(false);
    expect(db.targetStatements.some(statement => /pg_try_advisory_xact_lock/.test(statement))).toBe(false);
  });

  it("keeps the source read-only, opened with the repeatable-read snapshot", () => {
    expect(db.sourceStatements[0]).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(db.sourceStatements).toContain("ROLLBACK");
    for (const statement of db.sourceStatements) expect(statement).toMatch(/^(SELECT|BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY|ROLLBACK)/i);
  });
});

describe("inventory relationship diagnostics", () => {
  let plan: Record<string, unknown>;
  let result: RunResult;

  beforeEach(async () => {
    result = await runCopy({ mode: "inventory", exclude: [STALE_TASK], tables: recursiveFixture() });
    const report = result.logs.map(line => JSON.parse(line) as Record<string, unknown>).find(entry => entry["event"] === "control_plane_state.inventory");
    plan = (report?.["exclusionPlan"] ?? {}) as Record<string, unknown>;
  });

  it("names the exact edge each surviving task loses", () => {
    expect(plan["removedRelationshipEdges"]).toEqual([
      { sourceTaskId: DEPENDENT, sourceExternalKey: "DEP-1", sourceState: "READY", relationshipType: "SUPERSEDES", targetTaskId: STALE_TASK, targetExternalKey: "SELF-REPAIR-ARGV-META-1", targetState: "IMPLEMENTING" },
    ]);
  });

  it("shows only the edges that point at an excluded task", () => {
    const edges = plan["removedRelationshipEdges"] as Array<Record<string, unknown>>;
    // DEP-1 also has RELATED_TO -> LIVE_TASK, which survives and must not be reported or removed.
    expect(edges.every(edge => edge["relationshipType"] !== "RELATED_TO")).toBe(true);
    expect(edges.some(edge => edge["targetTaskId"] === LIVE_TASK)).toBe(false);
    // SECOND_LEVEL points only at DEPENDENT, which survives, so it loses nothing.
    expect(edges.some(edge => edge["sourceTaskId"] === SECOND_LEVEL)).toBe(false);
  });

  it("reports only the canonical relationship fields, never task content", () => {
    const edges = plan["removedRelationshipEdges"] as Array<Record<string, unknown>>;
    for (const edge of edges) {
      expect(Object.keys(edge).sort()).toEqual(["relationshipType", "sourceExternalKey", "sourceState", "sourceTaskId", "targetExternalKey", "targetState", "targetTaskId"]);
    }
    expect(JSON.stringify(result.logs)).not.toContain("MUST NOT LEAK");
  });

  it("changes nothing: an inventory writes no row anywhere", () => {
    expect(db.inserts).toEqual([]);
    expect(result.exitCode).toBe(0);
    for (const statement of [...db.sourceStatements, ...db.targetStatements]) {
      expect(statement).not.toMatch(/^(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|COMMIT)\b/i);
    }
  });
});
