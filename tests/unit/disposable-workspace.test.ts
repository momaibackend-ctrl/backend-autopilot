import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertDisposableWorkspace,
  disposeWorkspaceDirectory,
  ensureDisposableCleanWorkspace,
  workspaceCheckoutExists,
  workspaceEvidenceLimits,
  type WorkspaceInspection,
  type WorkspaceQuarantine,
} from "../../packages/execution-engine/src/index.js";

const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "autopilot-disposable-"));
  roots.push(root);
  return root;
}
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** Drives the recovery loop against a scripted sequence of tree states. */
function harness(states: WorkspaceInspection[], options: { workspace?: string } = {}) {
  const events: string[] = [];
  const quarantines: WorkspaceQuarantine[] = [];
  let present = options.workspace !== undefined;
  let index = 0;
  let clock = 0;
  return {
    events,
    quarantines,
    run: (maxAttempts?: number) =>
      ensureDisposableCleanWorkspace({
        ...(options.workspace === undefined
          ? {}
          : { workspace: options.workspace }),
        ...(maxAttempts === undefined ? {} : { maxAttempts }),
        now: () => new Date(1_700_000_000_000 + clock++).toISOString(),
        exists: async () => present,
        create: async (attempt) => {
          events.push(`create:${attempt}`);
          present = true;
          return options.workspace ?? `/tmp/minted-${attempt}`;
        },
        inspect: async () => {
          const state = states[Math.min(index++, states.length - 1)];
          return state ?? { status: "", diff: "" };
        },
        dispose: async () => {
          events.push("dispose");
          present = false;
        },
        quarantine: async (record) => {
          events.push(`quarantine:${record.attempt}`);
          quarantines.push(record);
        },
      }),
  };
}

describe("disposable workspace recovery", () => {
  it("reuses an already clean workspace without quarantining or disposing anything", async () => {
    const test = harness([{ status: "", diff: "" }], { workspace: "/w" });
    const result = await test.run();
    expect(result).toMatchObject({
      workspace: "/w",
      attempts: 1,
      created: false,
    });
    expect(result.quarantines).toEqual([]);
    expect(test.events).toEqual([]);
  });

  it("quarantines a dirty reused tree, disposes it, and continues on a fresh checkout", async () => {
    const test = harness(
      [
        { status: " M src/app.ts\n?? leftover.tmp\n", diff: "diff --git a/src/app.ts" },
        { status: "", diff: "" },
      ],
      { workspace: "/w" },
    );
    const result = await test.run();
    expect(result).toMatchObject({ attempts: 2, created: true });
    // Evidence is persisted before the directory is destroyed.
    expect(test.events).toEqual(["quarantine:1", "dispose", "create:2"]);
    expect(result.quarantines).toHaveLength(1);
    expect(result.quarantines[0]).toMatchObject({
      attempt: 1,
      disposed: true,
      workspace: "/w",
      status: " M src/app.ts\n?? leftover.tmp\n",
      diff: "diff --git a/src/app.ts",
      statusTruncated: false,
      diffTruncated: false,
    });
    expect(result.quarantines[0]?.reason).toMatch(/before the payload was applied/);
  });

  it("still verifies a checkout it just created rather than trusting it", async () => {
    // No pre-existing workspace: create() runs first, and the clean-tree check runs anyway.
    const test = harness([{ status: "?? unexpected\n", diff: "" }, { status: "", diff: "" }]);
    const result = await test.run();
    expect(test.events).toEqual([
      "create:1",
      "quarantine:1",
      "dispose",
      "create:2",
    ]);
    expect(result.created).toBe(true);
    expect(result.workspace).toBe("/tmp/minted-2");
  });

  it("fails with bounded evidence when the tree stays dirty", async () => {
    const test = harness([{ status: " M always.ts\n", diff: "d" }], {
      workspace: "/w",
    });
    await expect(test.run(2)).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      details: { attempts: 2, quarantinedAttempts: [1, 2] },
    });
    expect(test.events).toEqual([
      "quarantine:1",
      "dispose",
      "create:2",
      "quarantine:2",
      "dispose",
    ]);
    expect(test.quarantines).toHaveLength(2);
  });

  it("redacts and truncates the captured evidence", async () => {
    const test = harness(
      [
        {
          status: "?? .env\n",
          diff: `password: "super-secret-value"\n${"x".repeat(workspaceEvidenceLimits.maxDiffChars)}`,
        },
        { status: "", diff: "" },
      ],
      { workspace: "/w" },
    );
    const result = await test.run();
    const record = result.quarantines[0];
    expect(record?.diffTruncated).toBe(true);
    expect(record?.diff.length).toBe(workspaceEvidenceLimits.maxDiffChars);
    expect(record?.diff).not.toContain("super-secret-value");
    expect(record?.diff).toContain("[REDACTED]");
  });

  it("rejects a maxAttempts below one", async () => {
    const test = harness([{ status: "", diff: "" }], { workspace: "/w" });
    await expect(test.run(0)).rejects.toMatchObject({
      code: "POLICY_VIOLATION",
    });
  });
});

describe("workspace disposal guard", () => {
  it("accepts a workspace strictly inside the configured root", async () => {
    const root = await tempRoot();
    const workspace = join(root, "project");
    expect(assertDisposableWorkspace(workspace, root)).toBe(resolve(workspace));
  });

  it("refuses anything outside the root, the root itself, and the working directory", async () => {
    const root = await tempRoot();
    for (const [workspace, base] of [
      [join(root, "..", "elsewhere"), root],
      [root, root],
      [process.cwd(), resolve(process.cwd(), "..")],
      [resolve(process.cwd(), ".."), resolve(process.cwd(), "..", "..")],
    ] as const)
      expect(
        () => assertDisposableWorkspace(workspace, base),
        String(workspace),
      ).toThrowError(/POLICY|Refusing|outside/i);
  });

  it("actually removes a disposable workspace directory", async () => {
    const root = await tempRoot();
    const workspace = join(root, "project");
    await mkdir(join(workspace, "nested"), { recursive: true });
    await writeFile(join(workspace, "nested", "file.txt"), "leftover", "utf8");
    await disposeWorkspaceDirectory(workspace, root);
    await expect(stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
    // The root survives so the next checkout has somewhere to land.
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it("detects an existing checkout by its .git entry", async () => {
    const root = await tempRoot();
    const workspace = join(root, "project");
    await mkdir(workspace, { recursive: true });
    expect(await workspaceCheckoutExists(workspace)).toBe(false);
    await mkdir(join(workspace, ".git"), { recursive: true });
    expect(await workspaceCheckoutExists(workspace)).toBe(true);
  });
});
