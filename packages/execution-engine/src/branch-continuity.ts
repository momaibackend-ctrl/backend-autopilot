/**
 * The pure decision behind resuming an already-existing task branch: a persisted expected commit
 * SHA exists to detect concurrent modification, but treating any mismatch as fatal creates a
 * permanent deadlock the moment the branch legitimately advances (e.g. an operator pushing an
 * unrelated fix to the same branch) -- every future job for the task inherits the same stale
 * expected SHA from job history and would re-fail identically forever. A fast-forward (the
 * expected commit is still a real ancestor of the new HEAD) means nothing this job depended on
 * was lost or rewritten, so it's safe to adopt the new HEAD. Genuine divergence -- force-push,
 * rebase, history rewrite -- still fails closed.
 */
export type BranchContinuityDecision =
  | { status: "MATCH" }
  | { status: "FAST_FORWARD"; healedSha: string }
  | { status: "DIVERGED" };

export function resolveBranchContinuity(input: {
  expectedSha: string;
  actualHeadSha: string;
  isAncestor: boolean;
}): BranchContinuityDecision {
  if (input.actualHeadSha === input.expectedSha) return { status: "MATCH" };
  if (input.isAncestor)
    return { status: "FAST_FORWARD", healedSha: input.actualHeadSha };
  return { status: "DIVERGED" };
}
