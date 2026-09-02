import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  activeExecutionJobStatuses,
  assertSafeIdentifier,
  authBoundTables,
  compareKeyedData,
  compareMarkers,
  conflictBehaviorFor,
  controlPlaneMigrationPlan,
  countSql,
  evaluateSourceActivity,
  evaluateTargetReadiness,
  hashRows,
  insertRowsSql,
  markerConflictResolution,
  nextSupabaseUrlPattern,
  readOnlySnapshotStatement,
  resolveNextSupabaseProjectRef,
  sameDatabaseEndpoint,
  selectPageSql,
  tablePlan,
  tablesRequiringEmptyTarget,
  transientTaskStates,
} from "../../packages/control-plane-migration/src/index.js";

const root = resolve(__dirname, "../..");
const readRepoFile = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("migration table allowlist", () => {
  it("copies exactly the durable control-plane tables, in one explicit list", () => {
    expect(controlPlaneMigrationPlan.map(entry => entry.table)).toEqual([
      "projects",
      "resources",
      "project_contexts",
      "tasks",
      "runs",
      "artifacts",
      "execution_jobs",
      "task_transitions",
      "audit_events",
      "admin_operations",
      "canonical_development_repositories",
      "system_settings",
      "console_screens",
      "migration_markers",
    ]);
  });

  it("never copies the Auth-bound operator tables", () => {
    for (const table of authBoundTables) expect(controlPlaneMigrationPlan.map(entry => entry.table)).not.toContain(table);
    expect([...authBoundTables]).toEqual(["autopilot_operators", "autopilot_project_memberships"]);
  });

  it("matches the real schema's columns for every copied table", () => {
    // Guards against a later migration adding a column that the copy would silently drop.
    const schema = ["0001_initial", "0002_remote_runtime", "0003_superadmin_mcp", "0004_http_validation_runner", "0005_task_rebase", "0006_canonical_repository"]
      .map(name => readRepoFile(`packages/project-registry/migrations/${name}.sql`))
      .join("\n");
    for (const entry of controlPlaneMigrationPlan) {
      for (const column of entry.columns) expect(schema, `${entry.table}.${column} must exist in the migrations`).toContain(column);
      expect(entry.columns).toContain(entry.primaryKey[0]);
      expect(new Set(entry.columns).size, `${entry.table} lists a column twice`).toBe(entry.columns.length);
    }
  });

  it("only accepts identifiers that are safe to interpolate into SQL", () => {
    for (const entry of controlPlaneMigrationPlan) {
      expect(assertSafeIdentifier(entry.table)).toBe(entry.table);
      for (const column of entry.columns) expect(assertSafeIdentifier(column)).toBe(column);
    }
    for (const hostile of ['projects; DROP TABLE projects', 'projects"', "Projects", "1projects", "projects--", ""]) {
      expect(() => assertSafeIdentifier(hostile)).toThrow();
    }
  });

  it("refuses to plan a table outside the allowlist", () => {
    expect(() => tablePlan("autopilot_operators")).toThrow();
    expect(tablePlan("projects").table).toBe("projects");
  });
});

describe("foreign-key-safe copy order", () => {
  it("writes every table after the tables it references", () => {
    const references: Record<string, string[]> = {
      resources: ["projects"],
      project_contexts: ["projects"],
      tasks: ["projects"],
      runs: ["projects", "tasks"],
      artifacts: ["projects", "tasks", "runs"],
      execution_jobs: ["projects", "tasks", "resources", "runs"],
      task_transitions: ["tasks"],
      audit_events: ["projects"],
      admin_operations: ["projects"],
      canonical_development_repositories: ["projects", "resources"],
    };
    const order = controlPlaneMigrationPlan.map(entry => entry.table);
    for (const [table, parents] of Object.entries(references)) {
      for (const parent of parents) {
        expect(order.indexOf(parent), `${parent} must be copied before ${table}`).toBeGreaterThanOrEqual(0);
        expect(order.indexOf(parent)).toBeLessThan(order.indexOf(table));
      }
    }
  });
});

describe("source activity gate", () => {
  it("blocks a copy while execution jobs are in flight", () => {
    const activity = evaluateSourceActivity({ activeExecutionJobs: [{ key: "RUNNING", count: 2 }], transientTasks: [] });
    expect(activity.blocked).toBe(true);
    expect(activity.activeExecutionJobs).toEqual([{ key: "RUNNING", count: 2 }]);
  });

  it("blocks a copy while a task sits in a transient state", () => {
    expect(evaluateSourceActivity({ activeExecutionJobs: [], transientTasks: [{ key: "TESTING", count: 1 }] }).blocked).toBe(true);
  });

  it("allows a copy against a quiet source, ignoring zero tallies", () => {
    const activity = evaluateSourceActivity({ activeExecutionJobs: [{ key: "QUEUED", count: 0 }], transientTasks: [{ key: "IMPLEMENTING", count: 0 }] });
    expect(activity.blocked).toBe(false);
    expect(activity.activeExecutionJobs).toEqual([]);
  });

  it("treats every non-terminal job status and transient task state as blocking", () => {
    expect([...activeExecutionJobStatuses]).toEqual(["QUEUED", "DISPATCHING", "DISPATCHED", "CLAIMED", "RUNNING"]);
    expect([...transientTaskStates]).toEqual(["IMPLEMENTING", "TESTING", "REVIEWING"]);
  });
});

describe("target precondition", () => {
  it("requires every operational table to be empty and leaves the seeded three out of it", () => {
    expect(tablesRequiringEmptyTarget()).toEqual([
      "projects",
      "resources",
      "project_contexts",
      "tasks",
      "runs",
      "artifacts",
      "execution_jobs",
      "task_transitions",
      "audit_events",
      "admin_operations",
      "canonical_development_repositories",
    ]);
    for (const seeded of ["system_settings", "console_screens", "migration_markers"]) expect(tablesRequiringEmptyTarget()).not.toContain(seeded);
  });

  it("blocks a copy into a target that already holds operational state, naming only tables and counts", () => {
    const readiness = evaluateTargetReadiness([{ key: "projects", count: 1 }, { key: "tasks", count: 0 }]);
    expect(readiness.ready).toBe(false);
    expect(readiness.occupied).toEqual([{ key: "projects", count: 1 }]);
  });

  it("accepts a target whose operational tables are all empty", () => {
    expect(evaluateTargetReadiness([{ key: "projects", count: 0 }, { key: "tasks", count: 0 }]).ready).toBe(true);
  });
});

describe("write strategies", () => {
  it("inserts operational rows strictly, with no ON CONFLICT escape", () => {
    const sql = insertRowsSql(tablePlan("projects"), 2, conflictBehaviorFor(tablePlan("projects")));
    expect(sql).toBe('INSERT INTO "projects" ("id","slug","data","created_at") VALUES ($1,$2,$3,$4),($5,$6,$7,$8)');
    expect(sql).not.toContain("ON CONFLICT");
  });

  it("upserts seeded system_settings and console_screens so the live source configuration wins over the migration seed", () => {
    expect(conflictBehaviorFor(tablePlan("system_settings"))).toBe("DO_UPDATE");
    expect(insertRowsSql(tablePlan("system_settings"), 1, "DO_UPDATE")).toBe(
      'INSERT INTO "system_settings" ("key","data","updated_at") VALUES ($1,$2,$3) ON CONFLICT ("key") DO UPDATE SET "data"=EXCLUDED."data","updated_at"=EXCLUDED."updated_at"',
    );
    expect(insertRowsSql(tablePlan("console_screens"), 1, "DO_UPDATE")).toContain('ON CONFLICT ("screen_id") DO UPDATE SET "data"=EXCLUDED."data"');
  });

  it("keeps the target's own schema markers but carries every other marker over", () => {
    expect(markerConflictResolution("schema:0001_initial")).toBe("KEEP_TARGET");
    expect(markerConflictResolution("schema:0006_canonical_repository")).toBe("KEEP_TARGET");
    expect(markerConflictResolution("state:file-import")).toBe("PREFER_SOURCE");
    expect(conflictBehaviorFor(tablePlan("migration_markers"), "schema:0001_initial")).toBe("DO_NOTHING");
    expect(conflictBehaviorFor(tablePlan("migration_markers"), "state:file-import")).toBe("DO_UPDATE");
    expect(insertRowsSql(tablePlan("migration_markers"), 1, "DO_NOTHING")).toContain('ON CONFLICT ("key") DO NOTHING');
  });

  it("binds every value as a parameter and refuses a non-positive row count", () => {
    const sql = insertRowsSql(tablePlan("audit_events"), 3, "STRICT");
    expect(sql.match(/\$\d+/g)).toHaveLength(3 * tablePlan("audit_events").columns.length);
    expect(() => insertRowsSql(tablePlan("audit_events"), 0, "STRICT")).toThrow();
  });

  it("reads pages in primary-key order so the two sides stay comparable", () => {
    expect(selectPageSql(tablePlan("runs"))).toBe('SELECT "id","project_id","task_id","operation_id","data","created_at" FROM "runs" ORDER BY "id" LIMIT $1 OFFSET $2');
    expect(countSql("projects")).toBe('SELECT count(*)::bigint AS count FROM "projects"');
  });
});

describe("source read-only semantics", () => {
  it("snapshots with a repeatable-read READ ONLY transaction", () => {
    expect(readOnlySnapshotStatement).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  });

  it("opens the snapshot with that constant and keeps the guarded helper's rejection in place", () => {
    const script = readRepoFile("scripts/migrate-control-plane-state-next.ts");
    expect(script).toContain("readOnlySnapshotStatement");
    expect(script).toContain("Refusing to run a non-read statement against the migration source");
    expect(script).not.toMatch(/source\.query\((['"`])\s*(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)/i);
  });

  it("has exactly one source.query callsite, inside sourceQuery itself", () => {
    // Anything else -- a paged copy read, a tally, a hash page -- would reach the source without
    // passing the read-only assertion, which is the whole point of the helper.
    const script = readRepoFile("scripts/migrate-control-plane-state-next.ts");
    const callsites = [...script.matchAll(/\bsource\.query\(/g)].map(match => match.index ?? -1);
    expect(callsites).toHaveLength(1);
    const start = script.indexOf("async function sourceQuery");
    const end = script.indexOf("\n}", start);
    expect(start).toBeGreaterThan(-1);
    expect(callsites[0]).toBeGreaterThan(start);
    expect(callsites[0]).toBeLessThan(end);
  });

  it("reads copy pages through sourceQuery rather than the raw client", () => {
    const script = readRepoFile("scripts/migrate-control-plane-state-next.ts");
    const copyTable = script.slice(script.indexOf("async function copyTable"), script.indexOf("const insertPage"));
    expect(copyTable).toContain("await sourceQuery<unknown[]>(selectPageSql(entry)");
  });

  it("collects the blocking ids inside the snapshot that blocked, before the rollback", () => {
    const copyMode = readRepoFile("scripts/migrate-control-plane-state-next.ts");
    const body = copyMode.slice(copyMode.indexOf("async function copy()"), copyMode.indexOf("async function verify()"));
    expect(body.indexOf("await blockingJobIds()")).toBeGreaterThan(-1);
    expect(body.indexOf("await blockingTaskIds()")).toBeGreaterThan(-1);
    expect(body.indexOf("await blockingJobIds()")).toBeLessThan(body.indexOf("await sourceQuery('ROLLBACK')"));
    expect(body.indexOf("await blockingTaskIds()")).toBeLessThan(body.indexOf("await sourceQuery('ROLLBACK')"));
  });
});

describe("same-database detection", () => {
  const pooler = (ref: string, extra = "") => `postgresql://postgres.${ref}:secret@aws-0-eu-central-1.pooler.supabase.com:5432/postgres${extra}`;

  it("treats one endpoint reached with different credentials as the same database", () => {
    expect(sameDatabaseEndpoint("postgresql://u:p@host:5432/db", "postgresql://u:p@host:5432/db")).toBe(true);
    expect(sameDatabaseEndpoint("postgresql://u:p@host:5432/db", "postgresql://other:secret@host:5432/db?sslmode=require")).toBe(true);
    expect(sameDatabaseEndpoint("postgresql://u:p@host/db", "postgresql://u:p@host:5432/db")).toBe(true);
  });

  it("separates ordinary endpoints by host and database", () => {
    expect(sameDatabaseEndpoint("postgresql://u:p@host:5432/db", "postgresql://u:p@host:5432/other")).toBe(false);
    expect(sameDatabaseEndpoint("postgresql://u:p@host:5432/db", "postgresql://u:p@elsewhere:5432/db")).toBe(false);
  });

  it("tells two Supabase pooler tenants apart even though they share host, port and database", () => {
    // The regression this guards: every project behind one regional pooler looks identical except
    // for the project ref in the username, so ignoring the username reported them as one database
    // and would have let a migration between two real projects be refused as a self-copy.
    expect(sameDatabaseEndpoint(pooler("aaaaaaaaaaaaaaaaaaaa"), pooler("bbbbbbbbbbbbbbbbbbbb"))).toBe(false);
  });

  it("still recognises one pooler project reached with a different password or query string", () => {
    expect(sameDatabaseEndpoint(pooler("aaaaaaaaaaaaaaaaaaaa"), "postgresql://postgres.aaaaaaaaaaaaaaaaaaaa:other@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require")).toBe(true);
    expect(sameDatabaseEndpoint(pooler("aaaaaaaaaaaaaaaaaaaa"), pooler("aaaaaaaaaaaaaaaaaaaa", "?uselibpqcompat=true&sslmode=require"))).toBe(true);
  });

  it("recognises one project reached through different pooler ports or a direct connection", () => {
    const transactionPort = "postgresql://postgres.aaaaaaaaaaaaaaaaaaaa:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres";
    expect(sameDatabaseEndpoint(pooler("aaaaaaaaaaaaaaaaaaaa"), transactionPort)).toBe(true);
    expect(sameDatabaseEndpoint(pooler("aaaaaaaaaaaaaaaaaaaa"), "postgresql://postgres:secret@db.aaaaaaaaaaaaaaaaaaaa.supabase.co:5432/postgres")).toBe(true);
  });

  it("separates two direct Supabase projects", () => {
    expect(sameDatabaseEndpoint("postgresql://postgres:p@db.aaaaaaaaaaaaaaaaaaaa.supabase.co:5432/postgres", "postgresql://postgres:p@db.bbbbbbbbbbbbbbbbbbbb.supabase.co:5432/postgres")).toBe(false);
  });

  it("keeps the fail-safe behaviour for values that are not parseable URLs", () => {
    expect(sameDatabaseEndpoint("not a url", "also not a url")).toBe(false);
    expect(sameDatabaseEndpoint("not a url", "not a url")).toBe(true);
    expect(sameDatabaseEndpoint("not a url", "postgresql://u:p@host:5432/db")).toBe(false);
  });

  it("falls back to host comparison when a pooler username carries no project ref", () => {
    const withoutTenant = "postgresql://postgres:secret@aws-0-eu-central-1.pooler.supabase.com:5432/postgres";
    expect(sameDatabaseEndpoint(withoutTenant, "postgresql://postgres:other@aws-0-eu-central-1.pooler.supabase.com:5432/postgres")).toBe(true);
    expect(sameDatabaseEndpoint(withoutTenant, pooler("aaaaaaaaaaaaaaaaaaaa"))).toBe(true);
  });
});

describe("deterministic verification hash", () => {
  it("is stable for identical rows and independent of jsonb key order", () => {
    const left = [["a", { alpha: 1, beta: [1, 2] }, new Date("2026-01-01T00:00:00.000Z")]];
    const right = [["a", { beta: [1, 2], alpha: 1 }, new Date("2026-01-01T00:00:00.000Z")]];
    expect(hashRows(left)).toBe(hashRows(right));
  });

  it("changes when a value, the row order or the row count changes", () => {
    const base = hashRows([["a", 1], ["b", 2]]);
    expect(hashRows([["b", 2], ["a", 1]])).not.toBe(base);
    expect(hashRows([["a", 1], ["b", 3]])).not.toBe(base);
    expect(hashRows([["a", 1]])).not.toBe(base);
    expect(hashRows([])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("distinguishes null from an empty string and keeps bigint strings intact", () => {
    expect(hashRows([[null]])).not.toBe(hashRows([[""]]));
    expect(hashRows([["9007199254740993"]])).not.toBe(hashRows([["9007199254740992"]]));
  });
});

describe("keyed comparison", () => {
  it("requires every source key to be present in the target with the same data, ignoring target-only seeds", () => {
    const source = new Map<string, unknown>([["a", { value: 1 }], ["b", { value: 2 }]]);
    const target = new Map<string, unknown>([["a", { value: 1 }], ["b", { value: 99 }], ["seed-only", { value: 3 }]]);
    expect(compareKeyedData(source, target)).toEqual({ matched: 1, missing: [], different: ["b"] });
    expect(compareKeyedData(new Map([["missing", {}]]), new Map()).missing).toEqual(["missing"]);
  });

  it("treats a target-kept schema marker as expected rather than as a mismatch", () => {
    const source = new Map<string, unknown>([["schema:0001_initial", { migration: "0001_initial" }], ["state:file-import", { imported: true }]]);
    const target = new Map<string, unknown>([["schema:0001_initial", { migration: "0001_initial", platformVersion: "0.5.0" }], ["state:file-import", { imported: true }]]);
    const comparison = compareMarkers(source, target);
    expect(comparison.schemaKeptByTarget).toEqual(["schema:0001_initial"]);
    expect(comparison.different).toEqual([]);
    expect(comparison.missing).toEqual([]);
    expect(comparison.matched).toBe(1);
  });

  it("still reports a schema marker that never reached the target at all", () => {
    const comparison = compareMarkers(new Map([["schema:0007_future", {}]]), new Map());
    expect(comparison.schemaKeptByTarget).toEqual([]);
    expect(comparison.missing).toEqual(["schema:0007_future"]);
  });
});

describe("next Supabase URL validation", () => {
  it.each([
    ["https://abcdefghijklmnopqrst.supabase.co", "abcdefghijklmnopqrst"],
    ["https://ab1defghijklmnopqr9t.supabase.co", "ab1defghijklmnopqr9t"],
    ["https://abcdefghijklmnopqrst.supabase.co/", "abcdefghijklmnopqrst"],
  ])("accepts %s and extracts the project ref", (url, expected) => {
    expect(resolveNextSupabaseProjectRef(url)).toBe(expected);
  });

  it.each([
    ["https://abcdefghijklmnopqrst.evil.com", "a look-alike host"],
    ["https://abcdefghijklmnopqrst.supabase.co.evil.com", "a suffix host"],
    ["https://abcdefghijklmnopqrst.eu.supabase.co", "a subdomain before supabase.co"],
    ["https://abcdefghijklmnopqrst.supabase.co.", "a trailing dot"],
    ["http://abcdefghijklmnopqrst.supabase.co", "plain http"],
    ["https://ABCDEFGHIJKLMNOPQRST.supabase.co", "an uppercase ref"],
    ["https://short.supabase.co", "a short ref"],
    ["https://abcdefghijklmnopqrstuv.supabase.co", "an over-long ref"],
    ["https://abcdefghijklmnopqrst.supabase.co/rest/v1", "a path"],
    ["https://abcdefghijklmnopqrst.supabase.co?x=1", "a query"],
    ["https://abcdefghijklmnopqrst.supabase.co#f", "a fragment"],
    ["https://abcdefghijklmnopqrst.supabase.co//", "a double trailing slash"],
    ["", "an empty value"],
    ["abcdefghijklmnopqrst.supabase.co", "a scheme-less value"],
  ])("rejects %s (%s)", url => {
    expect(resolveNextSupabaseProjectRef(url)).toBeUndefined();
  });

  it("keeps the deploy workflow's grep pattern identical to the tested one", () => {
    // Same rule, two runtimes: drift here would mean the shell guard no longer matches what these
    // cases prove.
    expect(readRepoFile(".github/workflows/supabase-next.yml")).toContain(`grep -Eq '${nextSupabaseUrlPattern}'`);
  });
});

describe("state migration workflow", () => {
  const workflow = () => readRepoFile(".github/workflows/supabase-next-state.yml");

  it("is manual-only, branch-guarded and confirmed per mode", () => {
    const text = workflow();
    expect(text).not.toMatch(/^on:\s*\n\s*push:/m);
    expect(text).toContain("workflow_dispatch:");
    expect(text).toContain('autopilot/migrate-next-supabase-r2');
    expect(text).toContain("inventory) expected=INSPECT_NEXT_STATE");
    expect(text).toContain("copy)      expected=MIGRATE_NEXT_STATE");
    expect(text).toContain("verify)    expected=VERIFY_NEXT_STATE");
  });

  it("migrates schema only for copy, and only ever against the next database", () => {
    const text = workflow();
    expect(text).toContain("if: ${{ inputs.mode == 'copy' }}");
    expect(text).toContain("DATABASE_URL: ${{ secrets.AUTOPILOT_NEXT_DATABASE_URL }}");
    expect(text).toContain("SOURCE_DATABASE_URL: ${{ secrets.AUTOPILOT_CONTROL_DATABASE_URL }}");
    expect(text).toContain("TARGET_DATABASE_URL: ${{ secrets.AUTOPILOT_NEXT_DATABASE_URL }}");
  });

  it("touches PostgreSQL only -- no Supabase CLI, Management API, Edge Function or R2 step", () => {
    const text = workflow();
    for (const forbidden of ["supabase/setup-cli", "supabase secrets set", "supabase functions deploy", "api.supabase.com", "r2.cloudflarestorage.com", "AUTOPILOT_R2_"]) {
      expect(text, `${forbidden} must not appear in the state-migration workflow`).not.toContain(forbidden);
    }
  });
});
