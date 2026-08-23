// Reproduces the reported failure end-to-end against real git: an interrupted run leaves the
// reused workspace dirty, and the next run dies inside ExecutionEngine's clean-tree precondition
// BEFORE the payload is applied. The precondition is deliberately still there -- what this proves
// is that the dirty tree is now captured, quarantined and recovered from, and that the very same
// job then applies its payload on top of its own persisted branch checkpoint.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../packages/artifact-store/src/index.js";
import { AuditLog } from "../../packages/audit/src/index.js";
import { LocalGitAdapter } from "../../packages/adapters/git/src/index.js";
import { deterministicTaskBranch } from "../../packages/core/src/branch.js";
import { systemClock, uuidGenerator } from "../../packages/core/src/ports.js";
import {
  CommandPolicy,
  CommandRunner,
  ExecutionEngine,
  disposeWorkspaceDirectory,
  ensureDisposableCleanWorkspace,
  workspaceCheckoutExists,
} from "../../packages/execution-engine/src/index.js";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";
import type { Task } from "../../packages/schemas/src/index.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const task: Task = {
  id: "22222222-2222-4222-8222-222222222222",
  projectId,
  externalKey: "WS-1",
  title: "Disposable workspace recovery",
  description: "",
  requirements: [],
  state: "IMPLEMENTING",
  relationships: [],
  repairAttempts: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const checkpointBranch = deterministicTaskBranch(task);

let root: string;
let origin: string;
let workspaceRoot: string;
let workspace: string;
let store: MemoryStateStore;
let artifacts: ArtifactStore;
let audit: AuditLog;
let commands: CommandRunner;
let git: LocalGitAdapter;
/** Stands in for the external provider steps (push, CI, PR) that must never be repeated. */
let externalStepCalls = 0;

function run(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function seedOrigin() {
  await mkdir(origin, { recursive: true });
  run(origin, ["init", "-b", "main"]);
  run(origin, ["config", "user.email", "autopilot@localhost.invalid"]);
  run(origin, ["config", "user.name", "Backend Autopilot"]);
  await mkdir(join(origin, "src"), { recursive: true });
  await writeFile(join(origin, "src", "app.js"), "export const value = 1;\n", "utf8");
  run(origin, ["add", "."]);
  run(origin, ["commit", "-m", "baseline"]);
  // The interrupted run had already pushed its task branch: that branch is the checkpoint the
  // recreated checkout has to come back to.
  run(origin, ["switch", "-c", checkpointBranch]);
  await writeFile(join(origin, "src", "app.js"), "export const value = 2;\n", "utf8");
  run(origin, ["add", "."]);
  run(origin, ["commit", "-m", "autopilot: WS-1 partial work"]);
  run(origin, ["switch", "main"]);
  return run(origin, ["rev-parse", checkpointBranch]).trim();
}

/** A fresh checkout that restores the persisted task-branch checkpoint. */
async function checkout() {
  // Cloning is not an external provider step, so `externalStepCalls` deliberately stays put.
  run(workspaceRoot, ["clone", origin, workspace]);
  run(workspace, ["config", "user.email", "autopilot@localhost.invalid"]);
  run(workspace, ["config", "user.name", "Backend Autopilot"]);
  run(workspace, ["switch", "--track", `origin/${checkpointBranch}`]);
  return workspace;
}

let checkpointSha: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "autopilot-quarantine-"));
  origin = join(root, "origin");
  workspaceRoot = join(root, "workspaces");
  workspace = join(workspaceRoot, "project");
  await mkdir(workspaceRoot, { recursive: true });
  checkpointSha = await seedOrigin();
  store = new MemoryStateStore();
  artifacts = new ArtifactStore(store, uuidGenerator, systemClock);
  audit = new AuditLog(store, uuidGenerator, systemClock);
  commands = new CommandRunner(new CommandPolicy(), systemClock);
  git = new LocalGitAdapter(commands);
  await store.createProject({
    id: projectId,
    name: "Workspace recovery",
    slug: "workspace-recovery",
    sourceType: "LOCAL",
    environment: "SANDBOX",
    autonomyMode: "AUTONOMOUS_STAGING",
    status: "ACTIVE",
    workspacePath: workspace,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await checkout();
  // The interrupted run: an uncommitted edit plus an untracked leftover.
  await writeFile(join(workspace, "src", "app.js"), "export const value = 99; // half-written\n", "utf8");
  await writeFile(join(workspace, "leftover.tmp"), "partial output\n", "utf8");
  externalStepCalls = 1; // the interrupted run had already completed one external step
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("interrupted run leaves a dirty workspace", () => {
  it("still fails the clean-tree precondition before any payload is applied", async () => {
    await expect(git.snapshot(workspace, task.id)).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      message: "Target repository must have a clean working tree",
    });
    await expect(
      new ExecutionEngine(git, systemClock).execute({
        workspace,
        task,
        changes: [{ path: "src/added.js", content: "export const added = true;\n", operation: "CREATE" }],
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_FAILED" });
    // The payload never reached the tree.
    await expect(stat(join(workspace, "src", "added.js"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("quarantines the attempt, recreates the checkout, and lets the same job continue", async () => {
    const beforeExternalSteps = externalStepCalls;
    const result = await ensureDisposableCleanWorkspace({
      workspace,
      now: () => systemClock.now(),
      exists: workspaceCheckoutExists,
      create: async () => checkout(),
      inspect: async (target) => ({
        status: run(target, ["status", "--porcelain"]),
        diff: run(target, ["diff", "HEAD"]),
      }),
      dispose: (target) => disposeWorkspaceDirectory(target, workspaceRoot),
      quarantine: async (record) => {
        const artifact = await artifacts.write(
          projectId,
          "WORKSPACE_QUARANTINE",
          { quarantined: true, scope: "EXECUTION_JOB", ...record },
          task.id,
        );
        await audit.record({
          actor: "execution-runner",
          action: "execution.workspace.quarantined",
          projectId,
          taskId: task.id,
          input: { workspace: record.workspace, attempt: record.attempt },
          result: { artifactId: artifact.id },
          reason: "Interrupted run left an unclean reused workspace",
          correlationId: "workspace-quarantine-test",
        });
      },
    });

    expect(result.attempts).toBe(2);
    expect(result.created).toBe(true);
    expect(result.quarantines).toHaveLength(1);

    // 1. The dirty tree was captured as evidence before the directory was destroyed.
    const quarantine = (await store.listArtifacts(projectId)).find(
      (artifact) => artifact.kind === "WORKSPACE_QUARANTINE",
    );
    expect(quarantine).toBeDefined();
    const content = quarantine?.content as { quarantined: boolean; status: string; diff: string; disposed: boolean };
    expect(content.quarantined).toBe(true);
    expect(content.status).toContain("src/app.js");
    expect(content.status).toContain("?? leftover.tmp");
    expect(content.diff).toContain("half-written");

    // 2. The attempt is marked quarantined in the append-only audit trail.
    expect(
      (await store.listAudit(projectId)).some(
        (event) => event.action === "execution.workspace.quarantined",
      ),
    ).toBe(true);

    // 3. The workspace really was disposed and recreated: the leftover is gone.
    await expect(stat(join(workspace, "leftover.tmp"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(run(workspace, ["status", "--porcelain"]).trim()).toBe("");

    // 4. The recreated checkout resumed from the persisted branch checkpoint, it did not restart.
    expect(run(workspace, ["branch", "--show-current"]).trim()).toBe(checkpointBranch);
    expect(run(workspace, ["rev-parse", "HEAD"]).trim()).toBe(checkpointSha);

    // 5. No external provider step was repeated by the recovery.
    expect(externalStepCalls).toBe(beforeExternalSteps);

    // 6. The same job now applies its payload, which is what used to be impossible.
    const execution = await new ExecutionEngine(git, systemClock).execute({
      workspace,
      task,
      changes: [{ path: "src/added.js", content: "export const added = true;\n", operation: "CREATE" }],
    });
    expect(execution.branch).toBe(checkpointBranch);
    expect(execution.baseCommit).toBe(checkpointSha);
    expect(execution.changedFiles).toEqual(["src/added.js"]);
    expect(await readFile(join(workspace, "src", "added.js"), "utf8")).toContain("added = true");
    expect(run(workspace, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("keeps the workspace root and origin intact after disposal", async () => {
    expect((await stat(workspaceRoot)).isDirectory()).toBe(true);
    expect((await stat(resolve(origin, ".git"))).isDirectory()).toBe(true);
  });
});
