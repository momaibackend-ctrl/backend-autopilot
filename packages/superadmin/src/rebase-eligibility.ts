import {
  InvalidState,
  NotFound,
  PolicyViolation,
  UnsupportedOperation,
} from "../../core/src/errors.js";
import type { Artifact, Resource, Run, Task } from "../../schemas/src/index.js";

export interface RebasePlan {
  /** The task's own verified branch, produced by its last successful run. */
  sourceBranch: string;
  /** The exact commit the task's FINAL_CHANGE_MANIFEST verified. */
  sourceCommitSha: string;
  /** The commit the task originally forked from -- its first run's base. */
  originalBaseCommit: string;
  /** The manifest that made the task READY, kept for traceability. */
  manifestArtifactId: string;
  /** Prefix of the new working branch; the runner appends the resolved base short SHA. */
  rebaseBranchPrefix: string;
}

/**
 * The single, server-side source of truth for what may be transferred onto a newer base.
 *
 * Deliberately mirrors resolveMergeableCommit: nothing here comes from caller input -- not the
 * repository, branch, base, commit, nor manifest. A task only qualifies when it is already READY
 * (so its work is complete and gate-verified), its verified FINAL_CHANGE_MANIFEST commit is
 * exactly the head of its latest SUCCEEDED run, and its very first run recorded the base it
 * forked from. That first-run base is what makes the transfer exact: it is the boundary between
 * "state the task inherited" (which must NOT move to the new base) and "changes the task made"
 * (which must be preserved in full).
 */
export function resolveRebasePlan(input: {
  task?: Task;
  resource?: Resource;
  runs: Run[];
  artifacts: Artifact[];
}): RebasePlan {
  const { task, resource, runs, artifacts } = input;
  if (!task) throw new NotFound("Task not found");
  if (task.state !== "READY")
    throw new PolicyViolation(
      "Rebase onto the current base requires a task that already passed every READY gate",
      { state: task.state },
    );
  if (!resource) throw new NotFound("Resource not found");
  if (
    resource.type !== "GITHUB_REPOSITORY" ||
    resource.provider !== "github" ||
    resource.status !== "ACTIVE"
  )
    throw new PolicyViolation(
      "An active registered GitHub repository is required for a task rebase",
    );
  if (resource.environment === "PRODUCTION")
    throw new UnsupportedOperation(
      "Production resource mutation is not supported",
    );
  if (
    !resource.permissions.includes("WRITE") ||
    !resource.permissions.includes("ADMIN")
  )
    throw new PolicyViolation("Resource permission denied", {
      required: ["WRITE", "ADMIN"],
    });
  const manifest = [...artifacts]
    .reverse()
    .find(
      (artifact) =>
        artifact.kind === "FINAL_CHANGE_MANIFEST" &&
        artifact.status === "AVAILABLE",
    );
  const verifiedCommitSha = (
    manifest?.content as { verifiedCommitSha?: string } | undefined
  )?.verifiedCommitSha;
  if (!manifest || !verifiedCommitSha)
    throw new PolicyViolation(
      "Task has no verified FINAL_CHANGE_MANIFEST to transfer",
    );
  const ordered = [...runs].sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt),
  );
  const latest = ordered.at(-1);
  if (
    !latest ||
    latest.status !== "SUCCEEDED" ||
    latest.commitSha !== verifiedCommitSha ||
    !latest.branch?.startsWith("autopilot/")
  )
    throw new PolicyViolation(
      "Latest run does not match the task's verified commit SHA",
      { expected: verifiedCommitSha, actual: latest?.commitSha },
    );
  const originalBaseCommit = ordered.find((run) => run.baseCommit)?.baseCommit;
  if (!originalBaseCommit)
    throw new InvalidState(
      "Task has no recorded original base commit; the transfer boundary cannot be derived",
    );
  if (originalBaseCommit === verifiedCommitSha)
    throw new InvalidState(
      "Task's original base equals its verified commit; there is nothing to transfer",
    );
  return {
    sourceBranch: latest.branch,
    sourceCommitSha: verifiedCommitSha,
    originalBaseCommit,
    manifestArtifactId: manifest.id,
    rebaseBranchPrefix: latest.branch,
  };
}

/** Deterministic, collision-free working branch for one (task, target base) transfer. */
export function rebaseBranchName(prefix: string, targetBaseSha: string) {
  const base = targetBaseSha.slice(0, 12);
  const room = 240 - `-rebase-${base}`.length;
  return `${prefix.slice(0, room)}-rebase-${base}`;
}
