import { describe, expect, it } from "vitest";
import { buildEpicVerification, outstandingDimensions, resolveSupersession, type EpicMemberInput } from "../../packages/core/src/epic-verification.js";
import type { Artifact, ImplementationPlan, Task } from "../../packages/schemas/src/index.js";

const HEAD = "f121f544a43f7231db08cb977398aada46383fba";
const NOW = "2026-08-30T12:00:00.000Z";

const task = (externalKey: string, state = "READY"): Task =>
  ({ id: `id-${externalKey}`, projectId: "p", externalKey, title: externalKey, description: "d", requirements: ["r"], relationships: [], state, repairAttempts: 0, createdAt: NOW, updatedAt: NOW }) as unknown as Task;

const manifest = (verifiedCommitSha: string): Artifact =>
  ({ id: `manifest-${verifiedCommitSha.slice(0, 6)}`, projectId: "p", kind: "FINAL_CHANGE_MANIFEST", schemaVersion: "5", content: { verifiedCommitSha }, contentHash: "h", status: "AVAILABLE", createdAt: NOW }) as unknown as Artifact;

// The default member has been asked about invariants and answered "none". A member planned before
// verification profiles existed carries no profile at all, which is a different thing entirely --
// see the legacy fixture below.
const plan = (over: Partial<ImplementationPlan> = {}) =>
  ({
    testsRequired: ["UNIT", "INTEGRATION", "CONTRACT", "SECURITY", "REGRESSION"],
    databaseChanges: [],
    apiChanges: [],
    verification: { profileVersion: "1", decisions: [{ layer: "PROPERTY", status: "NOT_APPLICABLE", reasons: ["crud: no algorithmic invariant"] }] },
    ...over,
  }) as Pick<ImplementationPlan, "testsRequired" | "databaseChanges" | "apiChanges" | "verification">;

/** A plan from before the classifier existed: nobody ever asked it about invariants. */
const legacyPlan = () =>
  ({ testsRequired: ["UNIT", "INTEGRATION", "CONTRACT", "SECURITY", "REGRESSION"], databaseChanges: [], apiChanges: [] }) as Pick<
    ImplementationPlan,
    "testsRequired" | "databaseChanges" | "apiChanges" | "verification"
  >;

const member = (externalKey: string, verifiedSha: string, over: Partial<EpicMemberInput> = {}): EpicMemberInput => ({
  task: task(externalKey),
  plan: plan(),
  artifacts: [manifest(verifiedSha)],
  ...over,
});

const dimension = (report: ReturnType<typeof buildEpicVerification>, name: string) =>
  report.dimensions.find((value) => value.dimension === name)!;

const REPO = "momaibackend-ctrl/kotlin-sandbox";
/** Evidence as a trusted CI runner records it. */
const ci = (dimension: string, commitSha: string, passed = true, detail?: string) => ({
  dimension: dimension as never,
  artifactId: `art-${dimension}`,
  commitSha,
  passed,
  ...(detail ? { detail } : {}),
  provenance: {
    sourceType: "TRUSTED_CI" as const,
    repository: REPO,
    headSha: commitSha,
    workflowRunId: "33279000000",
    actor: "github-actions:33279000000:1",
    createdAt: NOW,
  },
});
/** The same claim, asserted by a person instead. */
const operator = (dimension: string, commitSha: string, passed = true) => ({
  ...ci(dimension, commitSha, passed),
  provenance: { sourceType: "OPERATOR" as const, repository: REPO, headSha: commitSha, actor: "release-agent", createdAt: NOW },
});

const supersedes = (member: EpicMemberInput, target: EpicMemberInput): EpicMemberInput => ({
  ...member,
  task: { ...member.task, relationships: [{ type: "SUPERSEDES", targetTaskId: target.task.id }] } as Task,
});

describe("epic supersession", () => {
  // Live finding: CORE-BE-05 (IMPLEMENTING), 06 (PLANNED) and 11 (FAILED) blocked the epic while
  // CORE-BE-05-FINAL, 06-FINAL and 11-FINAL sat READY with explicit SUPERSEDES edges. The gate was
  // counting history as if it were still the system, and the reported reason -- "three members are
  // not finished" -- was simply untrue.
  it("judges the replacement and leaves the replaced member's history intact", () => {
    const old05 = { task: task("CORE-BE-05", "IMPLEMENTING"), plan: plan(), artifacts: [] };
    const final05 = supersedes(member("CORE-BE-05-FINAL", HEAD), old05);
    const report = buildEpicVerification({
      epicKey: "CORE-BE", headSha: HEAD, members: [old05, final05],
      headEvidence: [ci("SECURITY_PRIVACY", HEAD)], generatedAt: NOW,
    });
    expect(report.blockers.map((b) => b.code)).not.toContain("EPIC_MEMBER_NOT_READY");
    expect(report.effectiveMembers).toBe(1);
    expect(report.supersededMembers).toEqual([{ externalKey: "CORE-BE-05", state: "IMPLEMENTING", supersededBy: "CORE-BE-05-FINAL" }]);
    // The historical member is still in the report, still telling the truth about itself.
    const historical = report.members.find((m) => m.externalKey === "CORE-BE-05")!;
    expect(historical.state).toBe("IMPLEMENTING");
    expect(historical.settled).toBe(false);
    expect(historical.supersededBy).toBe("CORE-BE-05-FINAL");
  });

  it("follows a chain to its end", () => {
    const a = { task: task("A", "FAILED"), plan: plan(), artifacts: [] };
    const b = supersedes({ task: task("B", "BLOCKED"), plan: plan(), artifacts: [] }, a);
    const c = supersedes(member("C", HEAD), b);
    const resolution = resolveSupersession([a, b, c]);
    expect(resolution.effective.map((m) => m.task.externalKey)).toEqual(["C"]);
    expect(resolution.superseded.map((m) => `${m.externalKey}->${m.supersededBy}`)).toEqual(["A->C", "B->C"]);
  });

  it("blocks on a supersession cycle instead of picking a winner", () => {
    const a = { task: task("A"), plan: plan(), artifacts: [] };
    const b = { task: task("B"), plan: plan(), artifacts: [] };
    const cycleA = supersedes(a, b);
    const cycleB = supersedes(b, a);
    const resolution = resolveSupersession([cycleA, cycleB]);
    expect(resolution.conflicts.map((c) => c.code)).toContain("EPIC_SUPERSESSION_CYCLE");
  });

  it("blocks when two active members claim to supersede the same one", () => {
    const original = { task: task("ORIGINAL", "FAILED"), plan: plan(), artifacts: [] };
    const first = supersedes(member("REPLACEMENT-A", HEAD), original);
    const second = supersedes(member("REPLACEMENT-B", HEAD), original);
    const report = buildEpicVerification({ epicKey: "E", headSha: HEAD, members: [original, first, second], headEvidence: [], generatedAt: NOW });
    const ambiguous = report.blockers.find((b) => b.code === "EPIC_SUPERSESSION_AMBIGUOUS")!;
    expect(ambiguous.reason).toContain("REPLACEMENT-A");
    expect(ambiguous.reason).toContain("REPLACEMENT-B");
  });

  it("never infers supersession from a name", () => {
    // "-FINAL" is a convention someone happens to follow. Reading it as a relationship would let a
    // rename drop a member out of the readiness verdict silently.
    const old11 = { task: task("CORE-BE-11", "FAILED"), plan: plan(), artifacts: [] };
    const named = member("CORE-BE-11-FINAL", HEAD);
    const resolution = resolveSupersession([old11, named]);
    expect(resolution.superseded).toEqual([]);
    expect(resolution.effective).toHaveLength(2);
  });

  it("ignores a replacement that is not part of the epic being judged", () => {
    // The epic as selected does not contain the work that replaced it, so claiming the member is
    // handled would report a system nobody assembled.
    const old05 = { task: task("CORE-BE-05", "IMPLEMENTING"), plan: plan(), artifacts: [] };
    const outsider = supersedes(member("OUT-OF-EPIC", HEAD), old05);
    const resolution = resolveSupersession([old05]);
    expect(resolution.superseded).toEqual([]);
    expect(outsider.task.relationships).toHaveLength(1);
  });

  it("blocks when an effective member's verified work is not reachable from the head", () => {
    const detached = { ...member("CORE-BE-09", "a".repeat(40)), verifiedCommitContainedInHead: false };
    const report = buildEpicVerification({ epicKey: "E", headSha: HEAD, members: [detached, member("CORE-BE-10", HEAD)], headEvidence: [], generatedAt: NOW });
    const blocker = report.blockers.find((b) => b.code === "EPIC_MEMBER_NOT_IN_HEAD")!;
    expect(blocker.reason).toContain("CORE-BE-09");
    expect(blocker.reason).toContain("not reachable");
  });
});

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
      headEvidence: required.map((d) => ci(d, HEAD, true, `${d} suite green at head`)),
      generatedAt: NOW,
    });
    expect(report.result).toBe("PASS");
    expect(report.blockers).toEqual([]);
    // Members are still stale in their own right; the epic is green because the epic ran, not
    // because the members did.
    expect(report.members.every((value) => value.evidenceIsAtHead)).toBe(false);
    expect(dimension(report, "CONTRACTS").evidence.map((e) => e.artifactId)).toEqual(["art-CONTRACTS"]);
    expect(report.trust).toBe("CI_VERIFIED");
    expect(report.repository).toBe(REPO);
  });

  it("rejects evidence produced at any other commit, however recent", () => {
    const members = [member("CORE-BE-01", "a".repeat(40)), member("CORE-BE-02", "b".repeat(40))];
    const report = buildEpicVerification({
      epicKey: "CORE-BE",
      headSha: HEAD,
      members,
      headEvidence: [ci("CONTRACTS", "c".repeat(40), true, "green, but not at head")],
      generatedAt: NOW,
    });
    expect(dimension(report, "CONTRACTS").status).toBe("BLOCKED");
    expect(report.result).toBe("BLOCKED");
    // Never counted, but never hidden either: an operator has to see that a check did run.
    expect(report.staleEvidence).toHaveLength(1);
    expect(report.staleEvidence[0]!.commitSha).toBe("c".repeat(40));
  });

  it("reports a failed epic run as the failure it was, not as missing evidence", () => {
    const members = [member("CORE-BE-01", HEAD), member("CORE-BE-02", HEAD)];
    const report = buildEpicVerification({
      epicKey: "CORE-BE",
      headSha: HEAD,
      members,
      headEvidence: [ci("CONSUMERS", HEAD, false, "diary module no longer resolves the timeline contract")],
      generatedAt: NOW,
    });
    const consumers = dimension(report, "CONSUMERS");
    expect(consumers.status).toBe("BLOCKED");
    expect(consumers.reasons.join(" ")).toContain("no longer resolves the timeline contract");
    expect(consumers.evidence.map((e) => e.artifactId)).toEqual(["art-CONSUMERS"]);
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

  it("does not report an unasked question as a finding of not-applicable", () => {
    // Found by running the gate against the real CORE-BE-01..21 set: those plans all predate
    // verification profiles, so INVARIANTS came back NOT_APPLICABLE -- which reads as "no member
    // declared an invariant" when the truth is "no member was ever asked". That is the silent skip
    // this gate exists to prevent, in a subtler form.
    const legacy = [
      member("CORE-BE-01", "a".repeat(40), { plan: legacyPlan() }),
      member("CORE-BE-02", "b".repeat(40), { plan: legacyPlan() }),
    ];
    const report = buildEpicVerification({ epicKey: "CORE-BE", headSha: HEAD, members: legacy, headEvidence: [], generatedAt: NOW });
    const invariants = dimension(report, "INVARIANTS");
    expect(invariants.status).toBe("BLOCKED");
    expect(invariants.reasons.join(" ")).toContain("never assessed");
    expect(invariants.remediation).toContain("Re-plan");
  });

  it("counts a check that actually ran even when the members were never asked for it", () => {
    // Found on the first fully green epic run: every dimension passed, INVARIANTS included -- 14
    // properties, 8600 generated cases, trusted CI -- and the epic was still BLOCKED on INVARIANTS
    // because the members predated verification profiles. Refusing evidence that exists is the
    // mirror image of the silent skip, and just as wrong.
    const legacy = [
      member("CORE-BE-01", "a".repeat(40), { plan: legacyPlan() }),
      member("CORE-BE-02", "b".repeat(40), { plan: legacyPlan() }),
    ];
    const report = buildEpicVerification({
      epicKey: "CORE-BE", headSha: HEAD, members: legacy,
      headEvidence: [ci("INVARIANTS", HEAD, true, "14 properties generated 8600 cases")],
      generatedAt: NOW,
    });
    const invariants = dimension(report, "INVARIANTS");
    expect(invariants.status).toBe("PASS");
    expect(report.missingDimensions).not.toContain("INVARIANTS");
  });

  it("still reports a genuine not-applicable once every member has been asked", () => {
    const members = [member("A", HEAD), member("B", HEAD)];
    const report = buildEpicVerification({ epicKey: "ASKED", headSha: HEAD, members, headEvidence: [], generatedAt: NOW });
    expect(dimension(report, "INVARIANTS").status).toBe("NOT_APPLICABLE");
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

  it("says whether a pass came from CI or from a person asserting it", () => {
    // Manual evidence is permitted -- an operator may have run the suites elsewhere and be
    // recording a real result. What is not permitted is for that to be indistinguishable from a
    // CI run, which is all a free-text source="github" ever gave you.
    const members = [member("A", HEAD), member("B", HEAD)];
    const required = ["CONTRACTS", "CONSUMERS", "INTEGRATION_DEPENDENCIES", "SECURITY_PRIVACY", "JOURNEYS"] as const;
    const asserted = buildEpicVerification({
      epicKey: "E", headSha: HEAD, members, headEvidence: required.map((d) => operator(d, HEAD)), generatedAt: NOW,
    });
    expect(asserted.result).toBe("PASS");
    expect(asserted.trust).toBe("OPERATOR_ASSERTED");
    expect(dimension(asserted, "CONTRACTS").reasons[0]).toContain("OPERATOR");

    const mixed = buildEpicVerification({
      epicKey: "E", headSha: HEAD, members,
      headEvidence: [ci("CONTRACTS", HEAD), ...required.slice(1).map((d) => operator(d, HEAD))],
      generatedAt: NOW,
    });
    expect(mixed.trust).toBe("MIXED");
  });

  it("lists which required dimensions have no evidence at all, separately from failed ones", () => {
    const members = [member("A", HEAD), member("B", HEAD)];
    const report = buildEpicVerification({
      epicKey: "E", headSha: HEAD, members,
      headEvidence: [ci("CONTRACTS", HEAD, false, "contract suite failed")],
      generatedAt: NOW,
    });
    // CONTRACTS ran and failed; the rest never ran. Both block, but they are not the same problem.
    expect(report.missingDimensions).not.toContain("CONTRACTS");
    expect(report.missingDimensions).toContain("CONSUMERS");
    expect(report.missingDimensions).toContain("JOURNEYS");
  });

  it("names exactly which dimensions an epic run still has to cover", () => {
    const members = [member("CORE-BE-01", "a".repeat(40)), member("CORE-BE-02", "b".repeat(40))];
    const report = buildEpicVerification({
      epicKey: "CORE-BE",
      headSha: HEAD,
      members,
      headEvidence: [ci("SECURITY_PRIVACY", HEAD)],
      generatedAt: NOW,
    });
    const outstanding = outstandingDimensions(report);
    expect(outstanding).not.toContain("SECURITY_PRIVACY");
    expect(outstanding).toContain("CONTRACTS");
    expect(outstanding).toContain("CONSUMERS");
    expect(outstanding).toContain("JOURNEYS");
  });
});
