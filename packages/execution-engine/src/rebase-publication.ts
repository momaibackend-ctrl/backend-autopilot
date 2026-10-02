/**
 * How a completed transfer is published onto its `...-rebase-<base>` working branch.
 *
 * That branch name is deterministic in the transfer's INPUTS -- one (task, target base) pair --
 * but the commit it produces is not: replaying the same work onto the same base yields a
 * byte-identical tree under a fresh commit SHA, because commit identity includes a timestamp.
 * So a second run of the same transfer built a commit that was neither equal to nor a descendant
 * of the one the first run had already published, and the plain push was rejected as a
 * non-fast-forward with nothing to retry into.
 *
 * A rebase branch is a disposable ref the autopilot owns outright, so it may be replaced -- but
 * replacing it when the result is identical is pure churn: it rewrites the head of a branch an
 * open pull request already points at, for no change in content. Hence three outcomes:
 *
 *   CREATE  -- origin has no such branch; an ordinary push publishes it.
 *   ADOPT   -- origin already carries this exact transfer (same tree on the same parent). Nothing
 *              is pushed and nothing is rewritten; the already-published commit IS the result.
 *   REPLACE -- origin carries a genuinely different transfer for the same (task, base). It is
 *              superseded under a lease pinned to the SHA we actually observed, so a ref that
 *              moved underneath us fails the push instead of being silently clobbered.
 */
export interface RebaseCommitIdentity {
  /** `git rev-parse <commit>^{tree}` -- the exact content the commit publishes. */
  tree: string;
  /** `git rev-parse <commit>^` -- the base the transfer was cut from. */
  parent: string;
}

export type RebasePublicationDecision =
  | { action: "CREATE" }
  | { action: "ADOPT"; commitSha: string }
  | { action: "REPLACE"; lease: string };

export function resolveRebasePublication(input: {
  /** What origin holds for the rebase branch right now, or undefined if it has no such branch. */
  remoteBranchSha?: string;
  /** Identity of the remote commit; undefined when it could not be resolved in the clone. */
  remote?: RebaseCommitIdentity;
  local: RebaseCommitIdentity;
}): RebasePublicationDecision {
  if (!input.remoteBranchSha) return { action: "CREATE" };
  if (
    input.remote &&
    input.remote.tree === input.local.tree &&
    input.remote.parent === input.local.parent
  )
    return { action: "ADOPT", commitSha: input.remoteBranchSha };
  return { action: "REPLACE", lease: input.remoteBranchSha };
}
