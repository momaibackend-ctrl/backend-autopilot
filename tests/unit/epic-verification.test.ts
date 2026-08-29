import { describe, expect, it } from "vitest";
import { buildEpicVerification, outstandingDimensions, type EpicMemberInput } from "../../packages/core/src/epic-verification.js";
import type { Artifact, ImplementationPlan, Task } from "../../packages/schemas/src/index.js";

const HEAD = "f121f544a43f7231db08cb977398aada46383fba";
const NOW = "2026-08-30T12:00:00.000Z";

const task = (externalKey: string, state = "READY"): Task =>
  ({ id: `id-${externalKey}`, projectId: "p", externalKey, title: externalKey, description: "d", requirements: ["r"], relationships: [], state, repairAttempts: 0, createdAt: NOW, updatedAt: NOW }) as unknown as Task;

const manifest = (verifiedCommitSha: string): Artifact =>
  ({ id: `manifest-${verifiedCommitSha.slice(0, 6)}`, projectId: "p", kind: "FINAL_CHANGE_MANIFEST", schemaVersion: "5", content: { verifiedCommitSha }, contentHash: "h", status: "AVAILABLE", createdAt: NOW }) as unknown as Artifact;

const plan = (over: Partial<ImplementationPlan> = {}) =>
  ({
    testsRequired: ["UNIT", "INTEGRATION", "CONTRACT", "SECURITY", "REGRESSION"],
    databaseChanges: [],
    apiChanges: [],
    ...over,
  }) as Pick<ImplementationPlan, "testsRequired" | "databaseChanges" | "apiChanges" | "verification">;

const member = (externalKey: string, verifiedSha: string, over: Partial<EpicMemberInput> = {}): EpicMemberInput => ({
  task: task(externalKey),
  plan: plan(),
  artifacts: [manifest(verifiedSha)],
  ...over,
});

const dimension = (report: ReturnType<typeof buildEpicVerification>, name: string) =>
  report.dimensions.find((value) => value.dimension === name)!;

describe("epic verification", () => {
  it("refuses to call an epic green just because every member is green", () => {
    // The exact CORE-BE-01..21 situation. Twenty-one members, every one READY with its own passing
    // evidence -- at twenty-one different commits. None of them says anything about the assembled
    // system, and before this gate existed that distinction had no way to be expressed.
    const members = Array.from({ length: 21 }, (_, index) =>
      member(`CORE-BE-${String(index + 1).padStart(2, "0")}`, `sha${index}`.padEnd(40, "0")),
    );
    const report = buildEpicVerification({ epicKey: "CORE-BE", headSha: HEAD, members, headEvidence: [], generatedAt: NOW });

    expect(report.result).toBe("BLOCKED");
    expect(report.members.every((value) => value.settled)).toBe(true);
    expect(report.members.every((value) => value.evidenceIsAtHead)).toBe(false);
    // The reason has to name the staleness, not just say "missing".
    expect(dimension(report, "CONTRACTS").reasons.join(" ")).toContain("says nothing about the assembled system");
    expect(dimension(report, "CONTRACTS").reasons.join(" ")).toContain("CORE-BE-01@");
  });

  it("passes only once every required dimension has evidence at the head SHA itself", () => {
    const members = [member("CORE-BE-01", "a".repeat(40)), member("CORE-BE-02", "b".repeat(40))];
    const required = ["CONTRACTS", "CONSUMERS", "INTEGRATION_DEPENDENCIES", "SECURITY_PRIVACY", "JOURNEYS"] as const;
    const report = buildEpicVerification({
      epicKey: "CORE-BE",
      headSha: HEAD,
      members,
      headEvidence: required.map((d) => ({ dimension: d, artifactId: `art-${d}`, commitSha: HEAD, passed: true, detail: `${d} suite green at head` })),
      generatedAt: NOW,
    });
    expect(report.result).toBe("PASS");
    expect(report.blockers).toEqual([]);
    // Members are still stale in their own right; the epic is green because the epic ran, not
    // because the members did.
    expect(report.members.every((value) => value.evidenceIsAtHead)).toBe(false);
    expect(dimension(report, "CONTRACTS").evidenceIds).toEqual(["art-CONTRACTS"]);
  });

  it("rejects evidence produced at any other commit, however recent", () => {
    const members = [member("CORE-BE-01", "a".repeat(40)), member("CORE-BE-02", "b".repeat(40))];
    const report = buildEpicVerification({
      epicKey: "CORE-BE",
      headSha: HEAD,
      members,
      headEvidence: [{ dimension: "CONTRACTS", artifactId: "art-1", commitSha: "c".repeat(40), passed: true, detail: "green, but not at head" }],
      generatedAt: NOW,
    });
    expect(dimension(report, "CONTRACTS").status).toBe("BLOCKED");
    expect(report.result).toBe("BLOCKED");
  });

  it("reports a failed epic run as the failure it was, not as missing evidence", () => {
    const members = [member("CORE-BE-01", HEAD), member("CORE-BE-02", HEAD)];
    const report = buildEpicVerification({
      epicKey: "CORE-BE",
      headSha: HEAD,
      members,
      headEvidence: [{ dimension: "CONSUMERS", artifactId: "art-2", commitSha: HEAD, passed: false, detail: "diary module no longer resolves the timeline contract" }],
      generatedAt: NOW,
    });
    const consumers = dimension(report, "CONSUMERS");
    expect(consumers.status).toBe("BLOCKED");
    expect(consumers.reasons.join(" ")).toContain("no longer resolves the timeline contract");
    expect(consumers.evidenceIds).toEqual(["art-2"]);
  });

  it("gives every dimension a verdict, so nothing can be silently skipped", () => {
    const report = buildEpicVerification({
      epicKey: "SOLO",
      headSha: HEAD,
      members: [member("ONLY-1", HEAD)],
      headEvidence: [],
      generatedAt: NOW,
    });
    expect(report.dimensions).toHaveLength(7);
    for (const value of report.dimensions) {
      expect(["PASS", "BLOCKED", "NOT_APPLICABLE"]).toContain(value.status);
      expect(value.reasons.length).toBeGreaterThan(0);
      if (value.status === "BLOCKED") expect(value.remediation?.length).toBeGreaterThan(0);
    }
    // A one-member epic composes nothing, and the verdict says so rather than omitting the row.
    expect(dimension(report, "CONSUMERS").status).toBe("NOT_APPLICABLE");
    expect(dimension(report, "CONSUMERS").reasons.join(" ")).toContain("composes nothing");
  });

  it("derives each dimension's requirement from what the members actually declared", () => {
    const withMigration = member("DB-1", HEAD, { plan: plan({ databaseChanges: ["versioned migration"] }) });
    const withProperty = member("ALG-1", HEAD, {
      plan: plan({ verification: { profileVersion: "1", decisions: [{ layer: "PROPERTY", status: "REQUIRED", reasons: ["time/DST"] }] } }),
    });
    const report = buildEpicVerification({ epicKey: "MIX", headSha: HEAD, members: [withMigration, withProperty], headEvidence: [], generatedAt: NOW });
    expect(dimension(report, "MIGRATIONS").requirement).toBe("REQUIRED");
    expect(dimension(report, "INVARIANTS").requirement).toBe("REQUIRED");

    const plain = [member("A", HEAD, { plan: plan({ testsRequired: ["UNIT", "SECURITY", "REGRESSION"] }) }), member("B", HEAD, { plan: plan({ testsRequired: ["UNIT", "SECURITY", "REGRESSION"] }) })];
    const quiet = buildEpicVerification({ epicKey: "PLAIN", headSha: HEAD, members: plain, headEvidence: [], generatedAt: NOW });
    expect(dimension(quiet, "MIGRATIONS").status).toBe("NOT_APPLICABLE");
    expect(dimension(quiet, "INVARIANTS").status).toBe("NOT_APPLICABLE");
    expect(dimension(quiet, "INTEGRATION_DEPENDENCIES").status).toBe("NOT_APPLICABLE");
    // Security is unconditional; an epic never opts out of it.
    expect(dimension(quiet, "SECURITY_PRIVACY").requirement).toBe("REQUIRED");
  });

  it("blocks while any member is still mid-flight or unplanned", () => {
    const report = buildEpicVerification({
      epicKey: "CORE-BE",
      headSha: HEAD,
      members: [
        member("CORE-BE-01", HEAD),
        { task: task("CORE-BE-02", "IMPLEMENTING"), plan: plan(), artifacts: [] },
        { task: task("CORE-BE-03"), artifacts: [manifest(HEAD)] },
      ],
      headEvidence: [],
      generatedAt: NOW,
    });
    const codes = report.blockers.map((blocker) => blocker.code);
    expect(codes).toContain("EPIC_MEMBER_NOT_READY");
    expect(codes).toContain("EPIC_MEMBER_UNPLANNED");
    expect(report.blockers.find((b) => b.code === "EPIC_MEMBER_NOT_READY")?.reason).toContain("CORE-BE-02 (IMPLEMENTING)");
  });

  it("names exactly which dimensions an epic run still has to cover", () => {
    const members = [member("CORE-BE-01", "a".repeat(40)), member("CORE-BE-02", "b".repeat(40))];
    const report = buildEpicVerification({
      epicKey: "CORE-BE",
      headSha: HEAD,
      members,
      headEvidence: [{ dimension: "SECURITY_PRIVACY", artifactId: "art-sec", commitSha: HEAD, passed: true }],
      generatedAt: NOW,
    });
    const outstanding = outstandingDimensions(report);
    expect(outstanding).not.toContain("SECURITY_PRIVACY");
    expect(outstanding).toContain("CONTRACTS");
    expect(outstanding).toContain("CONSUMERS");
    expect(outstanding).toContain("JOURNEYS");
  });
});
