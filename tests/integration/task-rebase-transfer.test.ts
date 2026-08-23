// Reproduces, against real git, the exact situation this mechanism exists for:
//
//   * a dependency task D is merged into main;
//   * main then moves on with unrelated merged work that touches the same file;
//   * task T was already completed and verified on top of D's branch, so its pull request now
//     conflicts and cannot be merged.
//
// The transfer must replay only T's own commits onto the current main, keep the merged work that
// arrived after T forked, surface the genuine overlap as a conflict with three-sided evidence
// rather than picking a side, accept a semantic resolution for exactly that path, and refuse any
// result that reverts something the base already carried.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyResolutions,
  assertBaseChangesPreserved,
  assertDependencyMerged,
  taskChangedPaths,
  transferTaskCommits,
  type RebaseGit,
} from "../../packages/execution-engine/src/index.js";
import { rebaseBranchName } from "../../packages/superadmin/src/rebase-eligibility.js";

let root: string;
let repo: string;
let git: RebaseGit;
let originalBase = "";
let taskHead = "";
let targetBase = "";

const sh = (args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sha = (ref: string) => sh(["rev-parse", ref]).trim();
const write = async (path: string, content: string) => {
  await mkdir(join(repo, path, ".."), { recursive: true });
  await writeFile(join(repo, path), content, "utf8");
};
const commit = async (message: string) => {
  sh(["add", "."]);
  sh(["commit", "-m", message]);
  return sha("HEAD");
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "autopilot-rebase-"));
  repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  sh(["init", "-b", "main"]);
  sh(["config", "user.email", "autopilot@localhost.invalid"]);
  sh(["config", "user.name", "Backend Autopilot"]);

  await write("src/app.kt", ["fun main() {", "    serve()", "}"].join("\n") + "\n");
  await write("src/untouched.kt", "val untouched = 1\n");
  await commit("baseline");

  // Dependency D, merged into main before the task forks from it.
  await write("src/database.kt", "val database = \"postgres\"\n");
  originalBase = await commit("autopilot: DEP persistence foundation");

  // Task T is completed and verified on top of D, across several commits.
  sh(["switch", "-c", "autopilot/TASK-04-platform"]);
  await write("src/jobs.kt", "val jobs = \"queue\"\n");
  await commit("autopilot: TASK-04 jobs");
  await write(
    "src/app.kt",
    ["fun main() {", "    when (role()) {", "        Role.API -> serve()", "        Role.WORKER -> runWorker()", "    }", "}"].join("\n") + "\n",
  );
  await write("src/worker.kt", "fun runWorker() {}\n");
  taskHead = await commit("autopilot: TASK-04 worker role");

  // main moves on: unrelated merged work touching the same region of the same file, plus a file
  // the task never touches.
  sh(["switch", "main"]);
  await write(
    "src/app.kt",
    ["fun main() {", "    log.info(\"starting\")", "    serve(port())", "}"].join("\n") + "\n",
  );
  await write("src/cloudrun.kt", "val port = 8080\n");
  targetBase = await commit("autopilot: CLOUD-RUN observable bootstrap");

  git = async (args) => {
    try {
      return { exitCode: 0, stdout: sh(args), stderr: "" };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return {
        exitCode: failure.status ?? 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
      };
    }
  };
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("transfer of a verified task onto the current base", () => {
  it("requires the dependency to actually be contained in the target base", async () => {
    await expect(assertDependencyMerged(git, originalBase, targetBase)).resolves.toBeUndefined();
    // A base that does not contain the dependency fails closed.
    const detached = sh(["rev-list", "--max-parents=0", "HEAD"]).trim();
    await expect(assertDependencyMerged(git, originalBase, detached)).rejects.toMatchObject({
      code: "POLICY_VIOLATION",
    });
  });

  it("replays only the task's own commits and reports the genuine conflict with three-sided evidence", async () => {
    const branch = rebaseBranchName("autopilot/TASK-04-platform", targetBase);
    sh(["switch", "-C", branch, targetBase]);
    const paths = await taskChangedPaths(git, originalBase, taskHead);
    expect(paths.sort()).toEqual(["src/app.kt", "src/jobs.kt", "src/worker.kt"]);
    // The state the task merely inherited is not part of the transfer.
    expect(paths).not.toContain("src/database.kt");

    const transfer = await transferTaskCommits(git, {
      originalBaseCommit: originalBase,
      sourceCommitSha: taskHead,
      readFile: (path) => readFile(join(repo, path), "utf8"),
    });
    expect(transfer.method).toBe("CHERRY_PICK_RANGE");
    expect(transfer.replayedCommits).toHaveLength(2);
    expect(transfer.conflicts.map((c) => c.path)).toEqual(["src/app.kt"]);
    expect(transfer.conflicts[0]?.kind).toBe("CONTENT");

    // diff3 evidence: current base, original base, and the task's intent are all present, which
    // is what makes an intent-based resolution possible instead of ours/theirs.
    const merged = transfer.conflicts[0]?.merged ?? "";
    expect(merged).toContain("<<<<<<<");
    expect(merged).toContain("||||||| ");
    expect(merged).toContain('log.info("starting")');
    expect(merged).toContain("Role.WORKER -> runWorker()");
    expect(merged).toContain("    serve()");

    // The conflict-free part of the task already landed.
    expect(await readFile(join(repo, "src/jobs.kt"), "utf8")).toContain("queue");
  });

  it("refuses resolutions outside the conflict set or still carrying markers", async () => {
    const conflicts = [{ path: "src/app.kt", kind: "CONTENT" as const, merged: "", truncated: false }];
    const writeFile = async (path: string, content: string) => write(path, content);
    await expect(
      applyResolutions(git, { conflicts, resolutions: [{ path: "src/untouched.kt", content: "x" }], writeFile }),
    ).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await expect(
      applyResolutions(git, { conflicts, resolutions: [{ path: "src/app.kt", content: "<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n" }], writeFile }),
    ).rejects.toThrowError(/conflict markers/);
    await expect(
      applyResolutions(git, {
        conflicts: [...conflicts, { path: "src/jobs.kt", kind: "CONTENT" as const, merged: "", truncated: false }],
        resolutions: [{ path: "src/app.kt", content: "ok\n" }],
        writeFile,
      }),
    ).rejects.toThrowError(/Not every conflicted path was resolved/);
  });

  it("accepts a semantic resolution that keeps both intents and completes the transfer", async () => {
    // Neither ours nor theirs: the base's logging and port handling AND the task's role dispatch.
    const resolved = [
      "fun main() {",
      '    log.info("starting")',
      "    when (role()) {",
      "        Role.API -> serve(port())",
      "        Role.WORKER -> runWorker()",
      "    }",
      "}",
    ].join("\n") + "\n";
    const applied = await applyResolutions(git, {
      conflicts: [{ path: "src/app.kt", kind: "CONTENT", merged: "", truncated: false }],
      resolutions: [{ path: "src/app.kt", content: resolved }],
      writeFile: (path, content) => write(path, content),
    });
    expect(applied).toEqual([{ path: "src/app.kt", kind: "CONTENT", bytes: Buffer.byteLength(resolved, "utf8") }]);

    execFileSync("git", ["-c", "core.editor=true", "cherry-pick", "--continue"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GIT_EDITOR: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(sh(["diff", "--name-only", "--diff-filter=U"]).trim()).toBe("");

    const rebasedCommitSha = sha("HEAD");
    const preserved = await assertBaseChangesPreserved(git, {
      originalBaseCommit: originalBase,
      targetBaseCommit: targetBase,
      rebasedCommitSha,
      taskPaths: await taskChangedPaths(git, originalBase, taskHead),
    });
    // src/cloudrun.kt arrived on the base after the task forked and was not touched by the task.
    expect(preserved.verifiedPaths).toBe(1);
    expect(await readFile(join(repo, "src/cloudrun.kt"), "utf8")).toContain("8080");

    // The task's own work is intact, and both intents survive in the resolved file.
    const app = await readFile(join(repo, "src/app.kt"), "utf8");
    expect(app).toContain('log.info("starting")');
    expect(app).toContain("Role.WORKER -> runWorker()");
    expect(app).toContain("serve(port())");
    expect(await readFile(join(repo, "src/worker.kt"), "utf8")).toContain("runWorker");
    expect(sh(["rev-list", "--count", `${targetBase}..${rebasedCommitSha}`]).trim()).toBe("2");
  });

  it("rejects a transfer that reverts work the target base already carried", async () => {
    sh(["switch", "-C", "autopilot/TASK-04-clobber", targetBase]);
    await write("src/cloudrun.kt", "val port = 1\n");
    const clobbered = await commit("clobber base work");
    await expect(
      assertBaseChangesPreserved(git, {
        originalBaseCommit: originalBase,
        targetBaseCommit: targetBase,
        rebasedCommitSha: clobbered,
        taskPaths: ["src/app.kt", "src/jobs.kt", "src/worker.kt"],
      }),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      details: { reverted: ["src/cloudrun.kt"] },
    });
  });
});
