import { rm, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { redact } from "../../audit/src/index.js";
import { ExecutionFailed, PolicyViolation } from "../../core/src/errors.js";

// An interrupted run (crash, cancelled workflow, lost lease) can leave a reused execution
// workspace with uncommitted or untracked files. The very next run then dies inside
// ExecutionEngine's `ensureClean` precondition BEFORE the payload is ever applied, and stays
// dead until a human cleans the directory by hand.
//
// The fix is to treat the workspace as disposable rather than to weaken the precondition. The
// clean-tree check is still authoritative: it is what detects the problem here. What changes is
// the response -- capture the dirt as evidence, mark the attempt quarantined, delete the
// directory, and re-create a clean checkout for the SAME job. Only the workspace is recreated;
// durable job/task/run state and every already-completed external step are left untouched, so
// the caller resumes from its own checkpoints instead of repeating provider calls.

/** Size caps so a pathological diff can never dominate an artifact or an audit row. */
export const workspaceEvidenceLimits = {
  maxStatusChars: 16_000,
  maxDiffChars: 64_000,
} as const;

export interface WorkspaceInspection {
  /** `git status --porcelain` output; empty (after trim) means clean. */
  status: string;
  /** `git diff HEAD` output, or whatever diff the caller considers authoritative. */
  diff: string;
}

export interface WorkspaceQuarantine {
  attempt: number;
  quarantinedAt: string;
  reason: string;
  workspace: string;
  status: string;
  diff: string;
  statusTruncated: boolean;
  diffTruncated: boolean;
  disposed: boolean;
}

export interface DisposableWorkspaceOptions {
  /**
   * A stable workspace directory that may already hold a reusable checkout. Omit it for
   * callers that mint a fresh directory per checkout (the GitHub Actions runner), in which
   * case `create` is always what decides the path.
   */
  workspace?: string;
  /** Bounded recreate loop; 2 means "one quarantine then one fresh checkout". */
  maxAttempts?: number;
  now(): string;
  /** True when the directory already holds a checkout that could be reused. */
  exists(workspace: string): Promise<boolean>;
  /** Creates a brand new checkout and returns its path. Cloning only -- no other side effect. */
  create(attempt: number): Promise<string>;
  /** Reads the authoritative clean-tree evidence. */
  inspect(workspace: string): Promise<WorkspaceInspection>;
  /** Removes the directory; `disposeWorkspaceDirectory` is the intended implementation. */
  dispose(workspace: string): Promise<void>;
  /** Persists the quarantine evidence (artifact + audit) before the directory is destroyed. */
  quarantine(record: WorkspaceQuarantine): Promise<void>;
}

export interface DisposableWorkspaceResult {
  workspace: string;
  attempts: number;
  /** True when this run had to create the checkout rather than reuse an existing one. */
  created: boolean;
  quarantines: WorkspaceQuarantine[];
}

function cap(value: string, limit: number) {
  const safe = String(redact(value ?? ""));
  return safe.length > limit
    ? { text: safe.slice(0, limit), truncated: true }
    : { text: safe, truncated: false };
}

/**
 * Guarantees this run starts from a clean checkout at `options.workspace`, recreating the
 * directory when a previous run left it dirty. Returns without any quarantine when the existing
 * workspace is already clean, so the happy path is unchanged.
 */
export async function ensureDisposableCleanWorkspace(
  options: DisposableWorkspaceOptions,
): Promise<DisposableWorkspaceResult> {
  const maxAttempts = options.maxAttempts ?? 2;
  if (maxAttempts < 1)
    throw new PolicyViolation("maxAttempts must be at least 1");
  const quarantines: WorkspaceQuarantine[] = [];
  let created = false;
  let candidate = options.workspace;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (!candidate || !(await options.exists(candidate))) {
      candidate = await options.create(attempt);
      created = true;
    }
    const workspace = candidate;
    // The clean-tree check is never skipped, not even for a checkout this run just created.
    const inspection = await options.inspect(workspace);
    if (!inspection.status.trim())
      return { workspace, attempts: attempt, created, quarantines };
    const status = cap(inspection.status, workspaceEvidenceLimits.maxStatusChars);
    const diff = cap(inspection.diff, workspaceEvidenceLimits.maxDiffChars);
    const record: WorkspaceQuarantine = {
      attempt,
      quarantinedAt: options.now(),
      reason:
        "Reused workspace had an unclean working tree before the payload was applied",
      workspace,
      status: status.text,
      diff: diff.text,
      statusTruncated: status.truncated,
      diffTruncated: diff.truncated,
      disposed: false,
    };
    // Evidence is persisted BEFORE the directory is destroyed, so a failure to dispose still
    // leaves an auditable record of exactly what was found.
    await options.quarantine(record);
    await options.dispose(workspace);
    record.disposed = true;
    quarantines.push(record);
  }
  throw new ExecutionFailed(
    "Workspace was still unclean after the bounded disposable-checkout recovery",
    {
      attempts: maxAttempts,
      quarantinedAttempts: quarantines.map((value) => value.attempt),
    },
  );
}

/**
 * Refuses to delete anything that is not a disposable workspace strictly inside `root`.
 * `rm -rf` is the one genuinely destructive operation in this path, so the guard is explicit
 * rather than implied by the caller passing the right string.
 */
export function assertDisposableWorkspace(workspace: string, root: string) {
  const target = resolve(workspace);
  const base = resolve(root);
  if (!isAbsolute(target) || !isAbsolute(base))
    throw new PolicyViolation("Disposable workspace paths must be absolute");
  const inside = relative(base, target);
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    throw new PolicyViolation(
      "Refusing to dispose a path outside the configured workspace root",
      { root: base },
    );
  const cwd = resolve(process.cwd());
  if (target === cwd || !relative(target, cwd).startsWith(".."))
    throw new PolicyViolation(
      "Refusing to dispose the current working directory or any ancestor of it",
    );
  if (target === resolve(target, "..") || !target.includes(sep))
    throw new PolicyViolation("Refusing to dispose a filesystem root");
  return target;
}

export async function disposeWorkspaceDirectory(
  workspace: string,
  root: string,
) {
  const target = assertDisposableWorkspace(workspace, root);
  await rm(target, { recursive: true, force: true });
}

/** A checkout is present when `.git` exists -- a directory for a clone, a file for a worktree. */
export async function workspaceCheckoutExists(workspace: string) {
  try {
    await stat(resolve(workspace, ".git"));
    return true;
  } catch {
    return false;
  }
}
