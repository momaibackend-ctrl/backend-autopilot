import { describe, expect, it } from "vitest";
import { resolveRebasePublication } from "../../packages/execution-engine/src/rebase-publication.js";

const tree = "1".repeat(40);
const parent = "2".repeat(40);
const publishedSha = "3".repeat(40);

describe("resolveRebasePublication", () => {
  it("creates the branch when origin has nothing for this (task, base) pair", () => {
    expect(resolveRebasePublication({ local: { tree, parent } })).toEqual({ action: "CREATE" });
  });

  it("adopts the published commit when the replay produced the same tree on the same parent", () => {
    // The exact case that dead-ended MOMNA-E28-COMPLETENESS-R1: re-running one transfer builds a
    // byte-identical result under a fresh SHA, which a plain push can only reject.
    const result = resolveRebasePublication({
      remoteBranchSha: publishedSha,
      remote: { tree, parent },
      local: { tree, parent },
    });
    expect(result).toEqual({ action: "ADOPT", commitSha: publishedSha });
  });

  it("supersedes under a lease when the transfer now produces different content", () => {
    const result = resolveRebasePublication({
      remoteBranchSha: publishedSha,
      remote: { tree: "9".repeat(40), parent },
      local: { tree, parent },
    });
    expect(result).toEqual({ action: "REPLACE", lease: publishedSha });
  });

  it("supersedes rather than adopts when the same tree sits on a different base", () => {
    const result = resolveRebasePublication({
      remoteBranchSha: publishedSha,
      remote: { tree, parent: "8".repeat(40) },
      local: { tree, parent },
    });
    expect(result).toEqual({ action: "REPLACE", lease: publishedSha });
  });

  it("supersedes when the published commit cannot be identified at all", () => {
    const result = resolveRebasePublication({ remoteBranchSha: publishedSha, local: { tree, parent } });
    expect(result).toEqual({ action: "REPLACE", lease: publishedSha });
  });
});
