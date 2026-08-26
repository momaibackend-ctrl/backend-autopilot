import { describe, expect, it } from "vitest";
import { resolveBranchContinuity } from "../../packages/execution-engine/src/branch-continuity.js";

describe("resolveBranchContinuity", () => {
  it("matches when the branch is exactly where the job expects it", () => {
    const result = resolveBranchContinuity({
      expectedSha: "a".repeat(40),
      actualHeadSha: "a".repeat(40),
      isAncestor: true,
    });
    expect(result).toEqual({ status: "MATCH" });
  });

  it("heals to the new HEAD on a fast-forward -- expected commit is still an ancestor", () => {
    const expectedSha = "a".repeat(40);
    const actualHeadSha = "b".repeat(40);
    const result = resolveBranchContinuity({ expectedSha, actualHeadSha, isAncestor: true });
    expect(result).toEqual({ status: "FAST_FORWARD", healedSha: actualHeadSha });
  });

  it("fails closed on genuine divergence -- expected commit is not an ancestor of the new HEAD", () => {
    const result = resolveBranchContinuity({
      expectedSha: "a".repeat(40),
      actualHeadSha: "c".repeat(40),
      isAncestor: false,
    });
    expect(result).toEqual({ status: "DIVERGED" });
  });
});
