import { describe, expect, it } from "vitest";
import { CommandPolicy } from "../../packages/execution-engine/src/command-policy.js";
import { deterministicTaskBranch } from "../../packages/core/src/branch.js";

// CORE-BE-11 is titled "Privacy & Consent Enforcement: data scopes, ACL and Couple boundaries".
// ExecutionEngine builds its commit message as `autopilot: ${externalKey} ${title}`, so the "&"
// landed in the `-m` value, the metacharacter scan classified the command UNKNOWN, and the whole
// execution died with PolicyViolation before a single command ran -- no commit, no COMMAND_LOG.
const realTitle = "Momna CORE-BE-11 / MOMNA-847 — Privacy & Consent Enforcement: data scopes, ACL and Couple boundaries";
const commitMessage = `autopilot: CORE-BE-11 ${realTitle}`;

describe("CommandPolicy commit messages", () => {
  const policy = new CommandPolicy();

  it("allows a commit message carrying shell metacharacters from the task title", () => {
    expect(policy.classify("git", ["commit", "-m", commitMessage])).toBe("BUILD");
    expect(() => policy.assertAllowed("git", ["commit", "-m", commitMessage], ["BUILD"])).not.toThrow();
    // --message is the same opaque position.
    expect(policy.classify("git", ["commit", "--message", "fix: a && b | c"])).toBe("BUILD");
  });

  it("still rejects metacharacters everywhere except that one opaque value", () => {
    // A metacharacter in a flag position on the very same command is still refused.
    expect(policy.classify("git", ["commit", "-m", "safe message", "--author=x;whoami"])).toBe("UNKNOWN");
    // Another subcommand gets no exemption at all.
    expect(policy.classify("git", ["checkout", "branch;whoami"])).toBe("UNKNOWN");
    // And the original guard for non-git commands is untouched.
    expect(() => policy.assertAllowed("node", ["test.js;whoami"], ["TEST"])).toThrow();
    expect(policy.classify("git", ["commit"])).toBe("BUILD");
  });

  it("keeps the ampersand out of the branch name, which is not exempt", () => {
    // The branch is slugified, so it never needed an exemption -- confirm that stays true, since
    // an unsanitised branch would hit the scan in a position this fix deliberately does not cover.
    const branch = deterministicTaskBranch({ externalKey: "CORE-BE-11", title: realTitle });
    expect(branch).not.toMatch(/[;&|><`]/);
    expect(policy.classify("git", ["switch", "-C", branch])).toBe("BUILD");
  });
});
