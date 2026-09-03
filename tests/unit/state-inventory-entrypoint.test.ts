import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The unit tests around the migration plan import pure helpers, so they never evaluated the script
// as a *program*. That is exactly how a temporal-dead-zone bug reached a real run: `count` was a
// `const` arrow declared below the module's top-level `await`, so calling it from inventory() --
// which runs during that await -- threw `ReferenceError: Cannot access 'count' before
// initialization` before a single row was read.
//
// This test executes the real entrypoint against a controlled pg Client. No database, no network,
// no credential: the connection strings are obvious fakes and every statement is answered in
// memory. Its job is to prove the executable path reaches the query layer at all.

const { FakeClient, seenStatements, plannedTables, POISON, LONG_TITLE, STUCK_TASKS, ACTIVE_JOBS } = vi.hoisted(() => {
  const plannedTables = [
    "projects", "resources", "project_contexts", "tasks", "runs", "artifacts", "execution_jobs",
    "task_transitions", "audit_events", "admin_operations", "canonical_development_repositories",
    "system_settings", "console_screens", "migration_markers",
    "autopilot_operators", "autopilot_project_memberships",
  ];
  const seenStatements: Array<{ connection: string; text: string; values: unknown[] }> = [];
  // Every row the fake returns also carries fields the projection did not ask for. Postgres would
  // never send them, but a mapper that spread the row wholesale would leak them -- which is exactly
  // the failure these tests exist to catch.
  const POISON = "SENTINEL_MUST_NEVER_BE_LOGGED";
  const LONG_TITLE = `stuck-task-title-${"x".repeat(400)}`;
  const STUCK_TASKS = 25;
  const ACTIVE_JOBS = 2;
  const poisoned = {
    data: { description: POISON, requirements: [POISON], context: POISON, payload: { prompt: POISON }, token: POISON },
    description: POISON,
    payload: POISON,
    connectionString: POISON,
  };

  const answer = (text: string): unknown[] => {
    if (/FROM pg_class/.test(text)) return plannedTables.map(relname => ({ relname }));
    if (/count\(\*\)::bigint AS count FROM "/.test(text)) return [{ count: "0" }];
    if (/pg_try_advisory_xact_lock/.test(text)) return [{ locked: true }];
    if (/count\(\*\)::bigint AS count FROM execution_jobs/.test(text)) return [{ status: "RUNNING", count: String(ACTIVE_JOBS) }];
    if (/count\(\*\)::bigint AS count FROM tasks/.test(text)) return [{ state: "IMPLEMENTING", count: "6" }];
    if (/AS provider, count/.test(text)) return [{ provider: "supabase", count: "3" }];
    if (/^SELECT id, project_id, external_key/.test(text)) {
      return Array.from({ length: STUCK_TASKS }, (_, index) => ({
        id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
        project_id: "22222222-2222-4222-8222-222222222222",
        external_key: `MOMNA-${1000 + index}`,
        state: "IMPLEMENTING",
        title: LONG_TITLE,
        created_at: new Date("2026-08-01T00:00:00.000Z"),
        updated_at: "2026-08-02T00:00:00.000Z",
        ...poisoned,
      }));
    }
    if (/^SELECT id, project_id, task_id, status/.test(text)) {
      return Array.from({ length: ACTIVE_JOBS }, (_, index) => ({
        id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
        project_id: "22222222-2222-4222-8222-222222222222",
        task_id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
        status: "RUNNING",
        created_at: new Date("2026-08-01T00:00:00.000Z"),
        updated_at: new Date("2026-08-02T00:00:00.000Z"),
        ...poisoned,
      }));
    }
    return [];
  };

  class FakeClient {
    private readonly connection: string;
    constructor(config: { connectionString: string }) { this.connection = config.connectionString; }
    async connect(): Promise<void> { /* no socket is ever opened */ }
    async end(): Promise<void> { /* nothing to close */ }
    async query(config: string | { text: string; values?: unknown[] }, values?: unknown[]): Promise<{ rows: unknown[] }> {
      const text = typeof config === "string" ? config : config.text;
      const bound = (typeof config === "string" ? values : config.values) ?? [];
      seenStatements.push({ connection: this.connection, text, values: bound });
      return { rows: answer(text) };
    }
  }
  return { FakeClient, seenStatements, plannedTables, POISON, LONG_TITLE, STUCK_TASKS, ACTIVE_JOBS };
});

vi.mock("pg", () => ({ Client: FakeClient }));

const SOURCE = "postgresql://inventory-test:fake@source.invalid:5432/autopilot";
const TARGET = "postgresql://inventory-test:fake@target.invalid:5432/autopilot";

describe("executable inventory entrypoint", () => {
  const originalArgv = process.argv;
  const logged: string[] = [];
  let failure: unknown;

  const reportOf = (): Record<string, unknown> => {
    const report = logged
      .map(line => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; } })
      .find(value => value?.["event"] === "control_plane_state.inventory");
    if (!report) throw new Error(`no inventory report was emitted; output was: ${logged.join(" | ")}`);
    return report;
  };
  const sourceSection = (): Record<string, unknown> => reportOf()["source"] as Record<string, unknown>;

  beforeAll(async () => {
    process.argv = ["node", "migrate-control-plane-state-next.ts", "--mode", "inventory"];
    process.env["SOURCE_DATABASE_URL"] = SOURCE;
    process.env["TARGET_DATABASE_URL"] = TARGET;
    const log = vi.spyOn(console, "log").mockImplementation(message => { logged.push(String(message)); });
    const error = vi.spyOn(console, "error").mockImplementation(message => { logged.push(String(message)); });
    try {
      // Importing the script IS running it: the module body connects, dispatches the mode and awaits
      // the whole inventory at top level.
      await import("../../scripts/migrate-control-plane-state-next.js");
    } catch (thrown) {
      failure = thrown;
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  afterAll(() => {
    process.argv = originalArgv;
    delete process.env["SOURCE_DATABASE_URL"];
    delete process.env["TARGET_DATABASE_URL"];
    process.exitCode = 0;
  });

  it("runs to completion without a ReferenceError from an uninitialised helper", () => {
    // The assertion that would have caught the shipped bug.
    if (failure instanceof ReferenceError) throw new Error(`Inventory entrypoint hit a temporal-dead-zone error: ${failure.message}`);
    expect(failure).toBeUndefined();
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("actually exercises the helper that was in the dead zone", () => {
    // Without a per-table count query the run would never have reached `count()`, and the test
    // above would pass while covering nothing.
    const counts = seenStatements.filter(entry => /count\(\*\)::bigint AS count FROM "/.test(entry.text));
    expect(counts.length).toBeGreaterThanOrEqual(plannedTables.length - 2);
    expect(counts.some(entry => entry.connection === SOURCE)).toBe(true);
    expect(counts.some(entry => entry.connection === TARGET)).toBe(true);
  });

  it("opens both connections read-only and issues no write statement", () => {
    for (const connection of [SOURCE, TARGET]) {
      const statements = seenStatements.filter(entry => entry.connection === connection).map(entry => entry.text);
      expect(statements[0]).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      expect(statements).toContain("ROLLBACK");
      for (const statement of statements) {
        expect(statement).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|COMMIT)\b/i);
      }
    }
  });

  it("emits one structured inventory report describing both control planes", () => {
    const report = logged.map(line => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; } })
      .find(value => value?.["event"] === "control_plane_state.inventory");
    expect(report, `no inventory report was emitted; output was: ${logged.join(" | ")}`).toBeDefined();
    expect(report?.["mode"]).toBe("inventory");
    const source = report?.["source"] as { role: string; tables: Array<{ table: string; present: boolean; rows: number | null }> };
    expect(source.role).toBe("SOURCE");
    expect((report?.["target"] as { role: string }).role).toBe("TARGET");
    expect(source.tables.every(entry => entry.present && entry.rows === 0)).toBe(true);
    // No connection string may appear anywhere in the emitted report.
    expect(JSON.stringify(report)).not.toContain("source.invalid");
    expect(JSON.stringify(report)).not.toContain("target.invalid");
  });

  it("names the transient tasks that block a copy, with their state", () => {
    const identities = sourceSection()["transientTaskIdentities"] as Array<Record<string, unknown>>;
    expect(identities.length).toBeGreaterThan(0);
    expect(identities[0]).toEqual({
      taskId: "11111111-1111-4111-8111-000000000000",
      projectId: "22222222-2222-4222-8222-222222222222",
      externalKey: "MOMNA-1000",
      state: "IMPLEMENTING",
      title: expect.any(String),
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    });
    expect(identities.every(entry => entry["state"] === "IMPLEMENTING")).toBe(true);
    expect((sourceSection()["transientTasks"] as Array<Record<string, unknown>>)).toEqual([{ key: "IMPLEMENTING", count: 6 }]);
  });

  it("caps the identity lists at twenty rows, in SQL and again on the result", () => {
    const identities = sourceSection()["transientTaskIdentities"] as unknown[];
    expect(STUCK_TASKS).toBeGreaterThan(20); // the fake deliberately returns more than the cap
    expect(identities).toHaveLength(20);
    const statement = seenStatements.find(entry => /^SELECT id, project_id, external_key/.test(entry.text));
    expect(statement?.text).toContain("LIMIT $2");
    expect(statement?.values[1]).toBe(20);
  });

  it("truncates the untrusted task title", () => {
    const identities = sourceSection()["transientTaskIdentities"] as Array<Record<string, unknown>>;
    const title = identities[0]?.["title"] as string;
    expect(LONG_TITLE.length).toBeGreaterThan(120);
    expect(title.length).toBeLessThanOrEqual(123);
    expect(title.endsWith("...")).toBe(true);
  });

  it("names active execution jobs the same way when there are any", () => {
    const identities = sourceSection()["activeExecutionJobIdentities"] as Array<Record<string, unknown>>;
    expect(identities).toHaveLength(ACTIVE_JOBS);
    expect(identities[0]).toEqual({
      executionJobId: "33333333-3333-4333-8333-000000000000",
      projectId: "22222222-2222-4222-8222-222222222222",
      taskId: "11111111-1111-4111-8111-000000000000",
      status: "RUNNING",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    });
  });

  it("never selects or emits task payload, context or any other envelope field", () => {
    // The projection asks for named scalar paths only; `data` is never selected whole.
    const statement = seenStatements.find(entry => /^SELECT id, project_id, external_key/.test(entry.text))?.text ?? "";
    expect(statement).toContain("data->>'state'");
    expect(statement).toContain("data->>'title'");
    expect(statement).not.toMatch(/SELECT[^]*?\bdata\b\s*(,|\bFROM\b)/);
    for (const forbidden of ["description", "requirements", "relationships", "payload", "context"]) {
      expect(statement, `${forbidden} must not be selected`).not.toContain(forbidden);
    }
    // And the mapper copies named fields rather than spreading the row, so the sentinel the fake
    // attached to every row cannot reach the output.
    expect(JSON.stringify(logged)).not.toContain(POISON);
  });

  it("declares every helper below the top-level await as a hoisted function", () => {
    // The smoke run above only walks the inventory path, so the copy/verify-only helpers
    // (blockingJobIds, blockingTaskIds, insertPage) would not be caught by it. Everything after the
    // module's top-level await runs *during* that await, so a `const` function expression there is
    // in the temporal dead zone by construction, whatever calls it.
    const script = readFileSync(resolve(__dirname, "../../scripts/migrate-control-plane-state-next.ts"), "utf8").split(/\r?\n/);
    const topLevelAwait = script.findIndex(line => /^await source\.connect\(\)/.test(line));
    expect(topLevelAwait).toBeGreaterThan(-1);
    const deadZone = script
      .map((line, index) => ({ line: index + 1, text: line }))
      .filter(entry => entry.line > topLevelAwait + 1 && /^const\s+\w+\s*[:=].*=>/.test(entry.text));
    expect(deadZone.map(entry => `${entry.line}: ${entry.text.trim()}`)).toEqual([]);
  });
});
