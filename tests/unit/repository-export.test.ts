import { describe, expect, it } from "vitest";
import { verifyRepositoryExport, type ExportVerificationFacts } from "../../packages/canonical-repository/src/export.js";
import { commitSha } from "../helpers/repository-provider.js";

const head = commitSha("aaaa1111");
const older = commitSha("bbbb2222");
const now = "2026-08-30T00:00:00.000Z";

const description = (reference: string, defaultBranch = "main") => ({
  externalReference: reference,
  repositoryId: `id-${reference}`,
  defaultBranch,
  isEmpty: false,
  visibility: "private",
  permissions: { pull: true, push: true, admin: true },
  protectedBranches: [] as string[],
});

const complete = (): ExportVerificationFacts => ({
  projectId: "11111111-1111-4111-8111-111111111111",
  sourceRepository: "momai/source",
  targetRepository: "momai/target",
  sourceDescription: description("momai/source"),
  targetDescription: description("momai/target"),
  sourceHeadSha: head,
  targetHeadSha: head,
  expectedBranches: [{ name: "main", sha: head }, { name: "release/1.x", sha: older }],
  expectedTags: [{ name: "v1.0.0", sha: older }],
  targetBranches: [{ name: "main", sha: head }, { name: "release/1.x", sha: older }],
  targetTags: [{ name: "v1.0.0", sha: older }],
  sourceHeadPresentInTarget: true,
  now,
});

const codes = (value: { blockers: Array<{ code: string }> }) => value.blockers.map((blocker) => blocker.code);
const status = (value: ReturnType<typeof verifyRepositoryExport>, check: string) =>
  value.checks.find((entry) => entry.check === check)?.status;

describe("repository export verification", () => {
  it("passes only when identity, head, default branch, every ref, every tag and the history all check out", () => {
    const value = verifyRepositoryExport(complete());
    expect(value.result).toBe("PASS");
    expect(value.blockers).toEqual([]);
    expect(value.missingRefs).toEqual([]);
    expect(value.missingTags).toEqual([]);
    for (const check of ["SOURCE_IDENTITY", "TARGET_IDENTITY", "SOURCE_HEAD", "TARGET_HEAD", "DEFAULT_BRANCH", "REQUIRED_REFS", "REQUIRED_TAGS", "HISTORY_EQUIVALENCE", "NO_SECRET_TRANSFER"])
      expect(status(value, check), check).toBe("PASS");
  });

  it("blocks when a branch is missing from the target rather than reporting partial success", () => {
    const value = verifyRepositoryExport({ ...complete(), targetBranches: [{ name: "main", sha: head }] });
    expect(value.result).toBe("BLOCKED");
    expect(value.missingRefs).toEqual(["refs/heads/release/1.x"]);
    expect(codes(value)).toContain("REQUIRED_REFS_MISSING");
  });

  it("blocks when a branch arrived at a different commit", () => {
    const value = verifyRepositoryExport({ ...complete(), targetBranches: [{ name: "main", sha: head }, { name: "release/1.x", sha: head }] });
    expect(value.result).toBe("BLOCKED");
    expect(value.missingRefs).toEqual(["refs/heads/release/1.x"]);
  });

  it("blocks when tags did not travel with the history", () => {
    const value = verifyRepositoryExport({ ...complete(), targetTags: [] });
    expect(value.result).toBe("BLOCKED");
    expect(value.missingTags).toEqual(["v1.0.0"]);
    expect(codes(value)).toContain("REQUIRED_TAGS_MISSING");
  });

  it("treats a source with no tags as NOT_APPLICABLE rather than as a failure", () => {
    const value = verifyRepositoryExport({ ...complete(), expectedTags: [], targetTags: [] });
    expect(status(value, "REQUIRED_TAGS")).toBe("NOT_APPLICABLE");
    expect(value.result).toBe("PASS");
  });

  it("blocks a target head that diverged from the source head", () => {
    const value = verifyRepositoryExport({ ...complete(), targetHeadSha: older });
    expect(codes(value)).toContain("TARGET_SHA_MISMATCH");
    expect(value.result).toBe("BLOCKED");
  });

  it("blocks when the source head is not present in the target at all", () => {
    const value = verifyRepositoryExport({ ...complete(), sourceHeadPresentInTarget: false });
    expect(codes(value)).toContain("HISTORY_MISMATCH");
    expect(status(value, "HISTORY_EQUIVALENCE")).toBe("BLOCKED");
  });

  it("blocks when history equivalence simply could not be checked", () => {
    const facts = complete();
    delete facts.sourceHeadPresentInTarget;
    const value = verifyRepositoryExport(facts);
    expect(codes(value)).toContain("HISTORY_UNVERIFIABLE");
    expect(value.result).toBe("BLOCKED");
  });

  it("blocks a repository whose identity does not match the registration it was verified under", () => {
    const value = verifyRepositoryExport({ ...complete(), targetDescription: description("someone-else/target") });
    expect(codes(value)).toContain("TARGET_IDENTITY_MISMATCH");
  });

  it("blocks a target whose default branch differs from the source", () => {
    const value = verifyRepositoryExport({ ...complete(), targetDescription: description("momai/target", "master") });
    expect(codes(value)).toContain("DEFAULT_BRANCH_MISMATCH");
  });

  it("blocks a missing source head instead of vacuously passing", () => {
    const facts = complete();
    delete facts.sourceHeadSha;
    const value = verifyRepositoryExport(facts);
    expect(codes(value)).toContain("SOURCE_SHA_MISSING");
    expect(value.result).toBe("BLOCKED");
  });

  it("blocks when the source ref set is unknown, so completeness cannot be established", () => {
    const value = verifyRepositoryExport({ ...complete(), expectedBranches: [] });
    expect(codes(value)).toContain("REQUIRED_REFS_UNVERIFIABLE");
    expect(value.result).toBe("BLOCKED");
  });
});
