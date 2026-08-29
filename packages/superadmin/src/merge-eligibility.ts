import {
  NotFound,
  PolicyViolation,
  UnsupportedOperation,
} from "../../core/src/errors.js";
import type { Artifact, Resource, Run, Task } from "../../schemas/src/index.js";

/**
 * The single, server-side source of truth for what a guarded pull-request merge is allowed to
 * merge. Never accepts a caller-supplied repository, PR number, or ref -- everything here is
 * derived from durable task/resource/run/artifact state. Throws unless the task is READY, the
 * resource is an active non-production registered GitHub repository with WRITE and ADMIN
 * permission, and the latest run's commit exactly matches the task's own verified
 * FINAL_CHANGE_MANIFEST -- i.e. the same TEST/SECURITY/REVIEW/CI evidence gate that already
 * governs reaching READY at all.
 *
 * Run status is deliberately not a second source of truth once the task is READY. A runner may
 * fail after all formal evidence has been persisted (for example a read-after-write race while
 * finalizing review), and a later formal review can legitimately make the task READY on that
 * exact commit. Requiring the historical runner status to be SUCCEEDED would deadlock an already
 * verified commit even though the manifest and SHA are authoritative.
 */
export function resolveMergeableCommit(input: {
  task?: Task;
  resource?: Resource;
  runs: Run[];
  artifacts: Artifact[];
}): { branch: string; commitSha: string } {
  const { task, resource, runs, artifacts } = input;
  if (!task) throw new NotFound("Task not found");
  if (task.state !== "READY")
    throw new PolicyViolation(
      "Pull request merge requires a task that passed all READY gates",
    );
  if (!resource) throw new NotFound("Resource not found");
  if (
    resource.type !== "GITHUB_REPOSITORY" ||
    resource.provider !== "github" ||
    resource.status !== "ACTIVE"
  )
    throw new PolicyViolation(
      "An active registered GitHub repository is required for pull request merge",
    );
  if (resource.environment === "PRODUCTION")
    throw new UnsupportedOperation("Production resource mutation is not supported");
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
      "Task has no verified FINAL_CHANGE_MANIFEST to merge",
    );
  const latest = runs.at(-1);
  if (
    !latest ||
    latest.commitSha !== verifiedCommitSha ||
    !latest.branch?.startsWith("autopilot/")
  )
    throw new PolicyViolation(
      "Latest run commit/branch does not match the task's verified commit evidence",
      { expected: verifiedCommitSha, actual: latest?.commitSha, branch: latest?.branch },
    );
  return { branch: latest.branch, commitSha: verifiedCommitSha };
}
