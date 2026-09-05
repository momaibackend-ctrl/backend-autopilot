import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";
import type { Task } from "../../packages/schemas/src/index.js";

// A person looking at a board has the key on the ticket -- CORE-BE-25 -- and nothing else. Every
// task tool took a UUID, and finding the UUID needed the project id, which they also did not have.
// So the only identifier a human actually holds could not be used to ask about anything.
const root = resolve(__dirname, "../..");

const task = (over: Partial<Task>): Task => ({
  id: crypto.randomUUID(), projectId: crypto.randomUUID(), externalKey: "CORE-BE-25", title: "Context assembly",
  description: "d", requirements: [], state: "IMPLEMENTING", relationships: [], repairAttempts: 1,
  createdAt: "2026-09-05T09:00:00.000Z", updatedAt: "2026-09-05T09:44:13.000Z", ...over,
});

describe("a task can be found by the key on its ticket", () => {
  it("matches the key exactly", async () => {
    const store = new MemoryStateStore();
    await store.createTask(task({}));
    await store.createTask(task({ externalKey: "CORE-BE-26" }));
    const found = await store.findTasksByExternalKey("CORE-BE-25");
    expect(found.map(value => value.externalKey)).toEqual(["CORE-BE-25"]);
  });

  it("ignores case and surrounding whitespace, because a key gets typed by hand", async () => {
    const store = new MemoryStateStore();
    await store.createTask(task({}));
    for (const typed of ["core-be-25", "  CORE-BE-25  ", "Core-Be-25"])
      expect((await store.findTasksByExternalKey(typed)).length, typed).toBe(1);
  });

  it("does not match a key that merely contains it", async () => {
    // CORE-BE-25 must not return CORE-BE-250: acting on the wrong task is worse than not finding it.
    const store = new MemoryStateStore();
    await store.createTask(task({ externalKey: "CORE-BE-250" }));
    expect(await store.findTasksByExternalKey("CORE-BE-25")).toEqual([]);
  });

  it("spans projects, since the person naming a task rarely knows which project row holds it", async () => {
    const store = new MemoryStateStore();
    await store.createTask(task({ projectId: "11111111-1111-4111-8111-111111111111" }));
    await store.createTask(task({ projectId: "22222222-2222-4222-8222-222222222222" }));
    expect((await store.findTasksByExternalKey("CORE-BE-25")).length).toBe(2);
  });

  it("returns nothing rather than guessing when the key is unknown", async () => {
    expect(await new MemoryStateStore().findTasksByExternalKey("NOPE-1")).toEqual([]);
  });
});

describe("every store implements the lookup", () => {
  it("is present in all four, so the port is genuinely satisfied", () => {
    for (const path of ["memory-store", "file-store", "postgres-store", "postgrest-store"])
      expect(readFileSync(join(root, `packages/project-registry/src/${path}.ts`), "utf8"), path).toContain("findTasksByExternalKey");
  });

  it("filters server-side in both PostgreSQL stores rather than scanning in memory", () => {
    expect(readFileSync(join(root, "packages/project-registry/src/postgrest-store.ts"), "utf8")).toContain("data->>externalKey=ilike.");
    expect(readFileSync(join(root, "packages/project-registry/src/postgres-store.ts"), "utf8")).toContain("lower(${s.tasks.data}->>'externalKey')");
  });
});

describe("task_find answers what to do, not merely whether the row exists", () => {
  const mcp = readFileSync(join(root, "supabase/functions/mcp/index.ts"), "utf8");
  const start = mcp.indexOf("server.registerTool('task_find'");
  const body = mcp.slice(start, mcp.indexOf("server.registerTool('", start + 1));

  it("is registered and takes the ticket key", () => {
    expect(body).toContain("externalKey:z.string()");
    expect(body).toContain("Case-insensitive");
  });

  it("reports state, the next call, and what still blocks READY", () => {
    expect(body).toContain("nextAction:readiness?.nextAction");
    expect(body).toContain("blockers:readiness?.blockers");
    expect(body).toContain("waitingOnYou");
  });

  it("names the failing log so the caller does not have to hunt for it", () => {
    // Reading it from the end is the difference between 42 KB of failures and 3 MB of Gradle noise.
    expect(body).toContain("failingLog");
    expect(body).toContain("tail:true");
  });

  it("respects project scoping rather than leaking tasks across projects", () => {
    expect(body).toContain("mcpProjectAllowed(task.projectId)");
  });

  it("says so when a key is ambiguous instead of silently picking one", () => {
    expect(body).toContain("more than one project");
  });
});
