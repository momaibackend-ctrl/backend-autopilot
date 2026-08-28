import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionEngine } from "../../packages/execution-engine/src/index.js";
import { fileChangeSchema } from "../../packages/schemas/src/index.js";
import type { Task } from "../../packages/schemas/src/index.js";

// DELETE exists so an agent can relocate code. CORE-BE-15 failed its architecture gate because
// PostgresContentRepository sat in com.momna.platform while depending on com.momna.modules; the
// only real fix is to move the class out of platform, and with CREATE/UPDATE alone the old copy
// could never be removed -- it would keep violating no matter what was added.
const task = {
  id: "11111111-1111-1111-1111-111111111111",
  projectId: "22222222-2222-2222-2222-222222222222",
  externalKey: "CORE-BE-15",
  title: "Content Platform",
} as unknown as Task;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function engineOn(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "autopilot-delete-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content, "utf8");
  }
  const git = {
    snapshot: vi.fn(async () => ({ branch: "autopilot/CORE-BE-15-content-platform", baseCommit: "base" })),
    branch: vi.fn(async () => undefined),
    stage: vi.fn(async () => undefined),
    diff: vi.fn(async () => "a real diff"),
    commit: vi.fn(async () => "commit-sha"),
  };
  return { root, git, engine: new ExecutionEngine(git as never, { now: () => "2026-08-28T00:00:00.000Z" }) };
}

describe("ExecutionEngine DELETE", () => {
  it("moves a file: writes the new path and removes the old one", async () => {
    const oldPath = "src/main/kotlin/com/momna/platform/database/adapters/PostgresContentRepository.kt";
    const newPath = "src/main/kotlin/com/momna/modules/content/persistence/PostgresContentRepository.kt";
    const { root, engine } = await engineOn({ [oldPath]: "package com.momna.platform.database.adapters\n" });

    const result = await engine.execute({
      workspace: root,
      task,
      changes: [
        { path: newPath, content: "package com.momna.modules.content.persistence\n", operation: "CREATE" },
        { path: oldPath, operation: "DELETE" },
      ] as never,
    });

    expect(existsSync(join(root, oldPath))).toBe(false);
    expect(await readFile(join(root, newPath), "utf8")).toContain("com.momna.modules.content.persistence");
    expect(result.changedFiles).toEqual([newPath, oldPath]);
  });

  it("is idempotent: deleting an absent path is a no-op, not a failure", async () => {
    const { root, engine } = await engineOn({ "keep.txt": "kept" });
    await expect(
      engine.execute({ workspace: root, task, changes: [{ path: "never-existed.kt", operation: "DELETE" }] as never }),
    ).resolves.toMatchObject({ commitSha: "commit-sha" });
    expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("kept");
  });

  it("refuses to delete outside the workspace", async () => {
    const { root, engine } = await engineOn({ "keep.txt": "kept" });
    await expect(
      engine.execute({ workspace: root, task, changes: [{ path: "../escape.kt", operation: "DELETE" }] as never }),
    ).rejects.toThrowError(/escapes project workspace/);
  });

  it("requires content for writes but not for deletes", () => {
    expect(fileChangeSchema.safeParse({ path: "a.kt", operation: "DELETE" }).success).toBe(true);
    expect(fileChangeSchema.safeParse({ path: "a.kt", operation: "CREATE" }).success).toBe(false);
    expect(fileChangeSchema.safeParse({ path: "a.kt", content: "x", operation: "UPDATE" }).success).toBe(true);
  });
});
