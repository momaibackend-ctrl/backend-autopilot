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

const { FakeClient, seenStatements, plannedTables } = vi.hoisted(() => {
  const plannedTables = [
    "projects", "resources", "project_contexts", "tasks", "runs", "artifacts", "execution_jobs",
    "task_transitions", "audit_events", "admin_operations", "canonical_development_repositories",
    "system_settings", "console_screens", "migration_markers",
    "autopilot_operators", "autopilot_project_memberships",
  ];
  const seenStatements: Array<{ connection: string; text: string }> = [];

  const answer = (text: string): unknown[] => {
    if (/FROM pg_class/.test(text)) return plannedTables.map(relname => ({ relname }));
    if (/count\(\*\)::bigint AS count FROM "/.test(text)) return [{ count: "0" }];
    if (/pg_try_advisory_xact_lock/.test(text)) return [{ locked: true }];
    return [];
  };

  class FakeClient {
    private readonly connection: string;
    constructor(config: { connectionString: string }) { this.connection = config.connectionString; }
    async connect(): Promise<void> { /* no socket is ever opened */ }
    async end(): Promise<void> { /* nothing to close */ }
    async query(config: string | { text: string }, _values?: unknown[]): Promise<{ rows: unknown[] }> {
      const text = typeof config === "string" ? config : config.text;
      seenStatements.push({ connection: this.connection, text });
      return { rows: answer(text) };
    }
  }
  return { FakeClient, seenStatements, plannedTables };
});

vi.mock("pg", () => ({ Client: FakeClient }));

const SOURCE = "postgresql://inventory-test:fake@source.invalid:5432/autopilot";
const TARGET = "postgresql://inventory-test:fake@target.invalid:5432/autopilot";

describe("executable inventory entrypoint", () => {
  const originalArgv = process.argv;
  const logged: string[] = [];
  let failure: unknown;

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
