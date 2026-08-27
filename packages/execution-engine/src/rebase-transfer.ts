import { redact } from "../../audit/src/index.js";
import { ExecutionFailed, PolicyViolation } from "../../core/src/errors.js";

// Transfers an already-verified task onto a newer base branch after its dependency was merged.
//
// The mechanism is a real 3-way merge of the task's own net change (`git merge --squash`), never
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
  method: "SQUASH_MERGE";
  /** The task's own commits, recorded as evidence of exactly what was transferred. */
  replayedCommits: string[];
  conflicts: RebaseConflict[];
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
 * Applies exactly the task's own net change onto the branch that is currently checked out.
 *
 * Because the task's original base is an ancestor of the target base, git's merge base between
 * the target base and the task head IS that original base -- so `git merge --squash` performs
 * precisely the right 3-way merge: current base as ours, original base as the common ancestor,
 * the task's verified end state as theirs. The state the task merely inherited is never carried
 * over, work the base gained since the fork is preserved, and the result is a single clean
 * commit rather than a replay of intermediate repair states that the verified result already
 * superseded. Squashing also means a genuine overlap is reported once, against the task's final
 * intent, instead of once per intermediate commit.
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
  const merged = await git(["merge", "--squash", input.sourceCommitSha]);
  const conflicts =
    merged.exitCode === 0 ? [] : await collectConflicts(git, input.readFile);
  if (merged.exitCode !== 0 && !conflicts.length)
    throw new ExecutionFailed("Transfer failed without a reported conflict", {
      stderr: String(redact(merged.stderr)).slice(0, 800),
    });
  return { method: "SQUASH_MERGE", replayedCommits, conflicts };
}

/**
 * Commits the transferred result once every conflict is resolved and staged.
 *
 * Returns `undefined`, never throws, when nothing ended up staged. That happens when the target
 * base already carries the task's verified end state byte-for-byte -- typically because the
 * task's own pull request was already merged before this rebase ran. It is not a failure: the
 * caller re-verifies against the target base tip and returns the task straight to READY instead
 * of opening a pull request with zero commits, which GitHub would reject anyway.
 */
export async function commitTransfer(git: RebaseGit, message: string): Promise<string | undefined> {
  const remaining = await git(["diff", "--name-only", "--diff-filter=U"]);
  if (remaining.stdout.trim())
    throw new ExecutionFailed("Conflicts remain unresolved", {
      paths: lines(remaining.stdout),
    });
  await checked(git, ["add", "-A"], "Could not stage the transferred result");
  const staged = await git(["diff", "--cached", "--name-only"]);
  if (!staged.stdout.trim()) return undefined;
  await checked(git, ["commit", "-m", message], "Could not commit the transfer");
  const head = await checked(git, ["rev-parse", "HEAD"], "Could not read the transferred commit");
  return head.stdout.trim();
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
