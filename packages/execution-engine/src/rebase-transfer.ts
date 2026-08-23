import { redact } from "../../audit/src/index.js";
import { ExecutionFailed, PolicyViolation } from "../../core/src/errors.js";

// Transfers an already-verified task onto a newer base branch after its dependency was merged.
//
// The mechanism is a real 3-way replay (`git cherry-pick` of the task's own commit range), never
// a file copy and never an ours/theirs shortcut. Everything git can merge safely, git merges;
// what remains is a genuine semantic conflict, which is reported with full three-sided evidence
// (base / current code / task intent) so it can be resolved deliberately and then re-verified.
//
// Two invariants make the result trustworthy:
//   * the dependency really is in the new base -- the original base must be its ancestor;
//   * nothing the new base carries is silently reverted -- every file the base changed since the
//     original base, and which the task never touched, must be byte-identical afterwards.

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export interface RebaseGit {
  (args: string[]): Promise<GitCommandResult>;
}

export const rebaseEvidenceLimits = {
  maxConflictChars: 24_000,
  maxConflictFiles: 50,
} as const;

export type RebaseConflictKind =
  | "CONTENT"
  | "DELETED_BY_BASE"
  | "DELETED_BY_TASK"
  | "ADDED_BY_BOTH"
  | "UNKNOWN";

export interface RebaseConflict {
  path: string;
  kind: RebaseConflictKind;
  /** Working-tree content carrying diff3 markers: current base, original base, task intent. */
  merged: string;
  truncated: boolean;
}

export interface RebaseTransfer {
  method: "CHERRY_PICK_RANGE";
  replayedCommits: string[];
  conflicts: RebaseConflict[];
  stoppedAtCommit?: string;
}

async function checked(git: RebaseGit, args: string[], failure: string) {
  const result = await git(args);
  if (result.exitCode !== 0)
    throw new ExecutionFailed(failure, {
      args,
      stderr: String(redact(result.stderr)).slice(0, 800),
    });
  return result;
}

const lines = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

/** Fails closed unless the dependency the task was built on really is contained in the new base. */
export async function assertDependencyMerged(
  git: RebaseGit,
  originalBaseCommit: string,
  targetBaseCommit: string,
) {
  const contained = await git([
    "merge-base",
    "--is-ancestor",
    originalBaseCommit,
    targetBaseCommit,
  ]);
  if (contained.exitCode !== 0)
    throw new PolicyViolation(
      "The task's original base is not contained in the target base; the dependency is not merged yet",
      { originalBaseCommit, targetBaseCommit },
    );
}

export async function taskChangedPaths(
  git: RebaseGit,
  originalBaseCommit: string,
  sourceCommitSha: string,
) {
  const result = await checked(
    git,
    ["diff", "--name-only", `${originalBaseCommit}..${sourceCommitSha}`],
    "Could not derive the task's changed paths",
  );
  return lines(result.stdout);
}

async function conflictKind(
  git: RebaseGit,
  path: string,
): Promise<RebaseConflictKind> {
  const stages = await git(["ls-files", "-u", "--", path]);
  if (stages.exitCode !== 0) return "UNKNOWN";
  const present = new Set(
    lines(stages.stdout)
      .map((line) => /\s(\d)\t/.exec(line)?.[1])
      .filter((stage): stage is string => Boolean(stage)),
  );
  if (!present.has("1")) return "ADDED_BY_BOTH";
  if (!present.has("2")) return "DELETED_BY_BASE";
  if (!present.has("3")) return "DELETED_BY_TASK";
  return "CONTENT";
}

/** Reads every unresolved path with full diff3 evidence, redacted and size-capped. */
export async function collectConflicts(
  git: RebaseGit,
  readFile: (path: string) => Promise<string>,
): Promise<RebaseConflict[]> {
  const listed = await checked(
    git,
    ["diff", "--name-only", "--diff-filter=U"],
    "Could not list conflicted paths",
  );
  const paths = lines(listed.stdout).slice(
    0,
    rebaseEvidenceLimits.maxConflictFiles,
  );
  const conflicts: RebaseConflict[] = [];
  for (const path of paths) {
    const kind = await conflictKind(git, path);
    let merged = "";
    try {
      merged = await readFile(path);
    } catch {
      merged = "";
    }
    const safe = String(redact(merged));
    conflicts.push({
      path,
      kind,
      merged: safe.slice(0, rebaseEvidenceLimits.maxConflictChars),
      truncated: safe.length > rebaseEvidenceLimits.maxConflictChars,
    });
  }
  return conflicts;
}

/**
 * Replays exactly the task's own commits onto the branch that is currently checked out. The
 * range is `originalBase..sourceCommit`, so the state the task merely inherited is never
 * carried over -- only what the task itself changed.
 */
export async function transferTaskCommits(
  git: RebaseGit,
  input: {
    originalBaseCommit: string;
    sourceCommitSha: string;
    readFile: (path: string) => Promise<string>;
  },
): Promise<RebaseTransfer> {
  const listed = await checked(
    git,
    [
      "rev-list",
      "--reverse",
      `${input.originalBaseCommit}..${input.sourceCommitSha}`,
    ],
    "Could not enumerate the task's commits",
  );
  const replayedCommits = lines(listed.stdout);
  if (!replayedCommits.length)
    throw new ExecutionFailed("The task has no commits to transfer", {
      originalBaseCommit: input.originalBaseCommit,
      sourceCommitSha: input.sourceCommitSha,
    });
  // diff3 keeps the original-base side in the markers, which is what makes a conflict
  // resolvable on intent rather than by picking a side.
  await git(["config", "merge.conflictStyle", "diff3"]);
  const picked = await git([
    "cherry-pick",
    "--allow-empty",
    `${input.originalBaseCommit}..${input.sourceCommitSha}`,
  ]);
  if (picked.exitCode === 0)
    return { method: "CHERRY_PICK_RANGE", replayedCommits, conflicts: [] };
  const conflicts = await collectConflicts(git, input.readFile);
  if (!conflicts.length)
    throw new ExecutionFailed("Commit transfer failed without a conflict", {
      stderr: String(redact(picked.stderr)).slice(0, 800),
    });
  const head = await git(["rev-parse", "CHERRY_PICK_HEAD"]);
  return {
    method: "CHERRY_PICK_RANGE",
    replayedCommits,
    conflicts,
    ...(head.exitCode === 0 ? { stoppedAtCommit: head.stdout.trim() } : {}),
  };
}

export interface AppliedResolution {
  path: string;
  kind: RebaseConflictKind;
  bytes: number;
}

/**
 * Applies the agent's semantic resolutions. Deliberately narrow: only paths the transfer itself
 * reported as conflicted may be written, every conflicted path must be resolved, and a
 * resolution that still carries conflict markers is rejected rather than committed.
 */
export async function applyResolutions(
  git: RebaseGit,
  input: {
    conflicts: RebaseConflict[];
    resolutions: Array<{ path: string; content: string }>;
    writeFile: (path: string, content: string) => Promise<void>;
  },
): Promise<AppliedResolution[]> {
  const conflicted = new Map(
    input.conflicts.map((conflict) => [conflict.path, conflict]),
  );
  const applied: AppliedResolution[] = [];
  for (const resolution of input.resolutions) {
    const conflict = conflicted.get(resolution.path);
    if (!conflict)
      throw new PolicyViolation(
        "A rebase resolution may only rewrite a path the transfer reported as conflicted",
        { path: resolution.path },
      );
    if (/^(<{7}|={7}|>{7}|\|{7})/m.test(resolution.content))
      throw new PolicyViolation(
        "Resolved content still contains conflict markers",
        { path: resolution.path },
      );
    await input.writeFile(resolution.path, resolution.content);
    await checked(
      git,
      ["add", "--", resolution.path],
      "Could not stage a resolved path",
    );
    applied.push({
      path: resolution.path,
      kind: conflict.kind,
      bytes: Buffer.byteLength(resolution.content, "utf8"),
    });
  }
  const unresolved = [...conflicted.keys()].filter(
    (path) => !input.resolutions.some((value) => value.path === path),
  );
  if (unresolved.length)
    throw new PolicyViolation("Not every conflicted path was resolved", {
      unresolved,
    });
  return applied;
}

/**
 * The safety net for requirement "the dependency's changes must not be lost". Every path the
 * base gained or changed since the task forked, and which the task itself never touched, must be
 * byte-identical between the target base and the transferred head. Any drift means the replay
 * reverted somebody else's merged work and the whole transfer is rejected.
 */
export async function assertBaseChangesPreserved(
  git: RebaseGit,
  input: {
    originalBaseCommit: string;
    targetBaseCommit: string;
    rebasedCommitSha: string;
    taskPaths: string[];
  },
) {
  const baseMoved = await checked(
    git,
    [
      "diff",
      "--name-only",
      `${input.originalBaseCommit}..${input.targetBaseCommit}`,
    ],
    "Could not derive the base's own changes",
  );
  const taskPaths = new Set(input.taskPaths);
  const inherited = lines(baseMoved.stdout).filter(
    (path) => !taskPaths.has(path),
  );
  const reverted: string[] = [];
  for (const path of inherited) {
    const before = await git([
      "rev-parse",
      `${input.targetBaseCommit}:${path}`,
    ]);
    const after = await git([
      "rev-parse",
      `${input.rebasedCommitSha}:${path}`,
    ]);
    if (before.stdout.trim() !== after.stdout.trim()) reverted.push(path);
  }
  if (reverted.length)
    throw new ExecutionFailed(
      "Transfer reverted changes the target base already carried",
      { reverted: reverted.slice(0, 20), revertedCount: reverted.length },
    );
  return { verifiedPaths: inherited.length };
}
