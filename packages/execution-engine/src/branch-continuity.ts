/**
 * The pure decision behind resuming an already-existing task branch: a persisted expected commit
 * SHA exists to detect concurrent modification, but treating any mismatch as fatal creates a
 * permanent deadlock the moment the branch legitimately advances (e.g. an operator pushing an
 * unrelated fix to the same branch) -- every future job for the task inherits the same stale
 * expected SHA from job history and would re-fail identically forever. A fast-forward (the
 * expected commit is still a real ancestor of the new HEAD) means nothing this job depended on
 * was lost or rewritten, so it's safe to adopt the new HEAD. Genuine divergence -- force-push,
 * rebase, history rewrite -- still fails closed.
 *
 * UNPUBLISHED is the third case, and it is not divergence at all: the expected commit is not a
 * reachable object in the repository, so it never reached origin (a job that dies between
 * committing and pushing leaves exactly this), or it is no longer referenced by anything. Either
 * way it contributed nothing to the branch, so there is no work it could have lost -- and it can
 * never become an ancestor of anything, which is what made DIVERGED permanent here: every retry
 * re-inherited the same unreachable SHA and re-failed identically. Adopting the real HEAD is the
 * only reading that is both safe and not a deadlock.
 */
export type BranchContinuityDecision =
  | { status: "MATCH" }
  | { status: "FAST_FORWARD"; healedSha: string }
  | { status: "UNPUBLISHED"; healedSha: string }
  | { status: "DIVERGED" };

export function resolveBranchContinuity(input: {
  expectedSha: string;
  actualHeadSha: string;
  isAncestor: boolean;
  /**
   * Whether the expected commit resolves to a real object in the clone. Defaults to true so an
   * ancestry-only caller keeps the original two-sided behaviour.
   */
  expectedExists?: boolean;
}): BranchContinuityDecision {
  if (input.actualHeadSha === input.expectedSha) return { status: "MATCH" };
  if (input.expectedExists === false)
    return { status: "UNPUBLISHED", healedSha: input.actualHeadSha };
  if (input.isAncestor)
    return { status: "FAST_FORWARD", healedSha: input.actualHeadSha };
  return { status: "DIVERGED" };
}
