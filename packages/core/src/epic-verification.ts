import type { Artifact, EpicDimension, EpicDimensionResult, EpicEvidenceProvenance, EpicEvidenceRef, EpicVerificationReport, ImplementationPlan, Task } from "../../schemas/src/index.js";
import { requiresLayer } from "./verification-profile.js";

// Whether a set of individually-green tasks composes into a green system.
//
// Every gate in this control plane is per-task, and a per-task gate cannot answer the question that
// matters at the end of an epic. CORE-BE-01..21 each passed implementation, ArchitectureGuard, all
// required suites, exact-SHA CI and IndependentReview, and each of those verdicts was true -- about
// the commit that task ran on. Task 07's CI proves nothing about `main` after 08..21 landed on top
// of it. Twenty-one green tasks therefore never meant "the epic is green"; it meant "twenty-one
// commits were green, one at a time, at twenty-one different SHAs".
//
// So the rule this module exists to enforce is staleness. Evidence counts for the epic only when it
// was produced at the epic's single head SHA. Member evidence at an older SHA is not a partial pass
// and not a warning: it is BLOCKED, with the reason naming which members it came from. That is the
// difference between a release gate and a summary of past results.
//
// The second rule is that nothing may be silently skipped. Every dimension resolves to PASS,
// NOT_APPLICABLE with a stated reason, or BLOCKED with a remediation -- there is no fourth state
// where a dimension quietly does not appear.

/** What has to hold about the assembled system, not about any one task. */
export const epicDimensions: EpicDimension[] = [
  "CONTRACTS",
  "CONSUMERS",
  "INVARIANTS",
  "INTEGRATION_DEPENDENCIES",
  "SECURITY_PRIVACY",
  "MIGRATIONS",
  "JOURNEYS",
];

export interface EpicMemberInput {
  task: Task;
  /** The member's approved plan, when it has one. A member without a plan cannot be assessed. */
  plan?: Pick<ImplementationPlan, "testsRequired" | "databaseChanges" | "apiChanges" | "verification"> | undefined;
  artifacts: Artifact[];
  /**
   * Whether this member's verified commit is reachable from the epic head. Supplied by a caller
   * that has a checkout (the runner asks git); undefined means nobody checked, which is not the
   * same as false and does not block.
   */
  verifiedCommitContainedInHead?: boolean | undefined;
}

/**
 * Which members actually compose the released system.
 *
 * A task that was replaced is still history, and history has to stay true: forcing CORE-BE-05 to
 * READY because CORE-BE-05-FINAL exists would falsify the record of what actually happened to it.
 * So the old member keeps its real state and stops being counted, and the replacement is judged in
 * its place.
 *
 * Resolution is by explicit SUPERSEDES relationship only. Nothing here reads names: a "-FINAL"
 * suffix is a convention someone happens to follow, and inferring supersession from it would let a
 * rename silently drop a member out of an epic's readiness verdict.
 */
export interface SupersessionResolution {
  effective: EpicMemberInput[];
  superseded: { externalKey: string; state: string; supersededBy: string }[];
  conflicts: { code: string; reason: string; remediation: string }[];
}

export function resolveSupersession(members: EpicMemberInput[]): SupersessionResolution {
  const byId = new Map(members.map((member) => [member.task.id, member]));
  // successor -> predecessor, as the relationship is actually written: the replacement declares
  // what it supersedes.
  const supersedersOf = new Map<string, EpicMemberInput[]>();
  for (const member of members) {
    for (const relationship of member.task.relationships) {
      if (relationship.type !== "SUPERSEDES") continue;
      // Only a replacement inside this epic can stand in for a member of it. One outside means the
      // epic as selected does not contain the work that replaced it, and saying otherwise would
      // report a system nobody assembled.
      if (!byId.has(relationship.targetTaskId)) continue;
      const existing = supersedersOf.get(relationship.targetTaskId) ?? [];
      existing.push(member);
      supersedersOf.set(relationship.targetTaskId, existing);
    }
  }

  const conflicts: SupersessionResolution["conflicts"] = [];
  const supersededBy = new Map<string, EpicMemberInput>();

  for (const member of members) {
    const seen = new Set<string>([member.task.id]);
    let current = member;
    let terminal: EpicMemberInput | undefined;
    for (;;) {
      const candidates = (supersedersOf.get(current.task.id) ?? []).filter(
        // A superseder that was itself superseded is not competing for this slot; it is a link in
        // the same chain.
        (candidate) => !(supersedersOf.get(candidate.task.id) ?? []).length || candidate.task.id !== current.task.id,
      );
      if (!candidates.length) break;
      const active = candidates.filter((candidate) => !isSupersededSomewhere(candidate, supersedersOf));
      const chosen = active.length ? active : candidates;
      if (chosen.length > 1) {
        conflicts.push({
          code: "EPIC_SUPERSESSION_AMBIGUOUS",
          reason: `${current.task.externalKey} is superseded by more than one active member (${chosen.map((c) => c.task.externalKey).join(", ")}), so which one composes the epic is undecidable`,
          remediation: "Remove the SUPERSEDES relationship from every replacement except the one that actually stands, then re-run this gate.",
        });
        terminal = undefined;
        break;
      }
      const next = chosen[0]!;
      if (seen.has(next.task.id)) {
        conflicts.push({
          code: "EPIC_SUPERSESSION_CYCLE",
          reason: `SUPERSEDES relationships form a cycle through ${[...seen].map((id) => byId.get(id)?.task.externalKey ?? id).join(" -> ")}, so no member is the canonical one`,
          remediation: "Break the cycle so the chain ends at exactly one replacement, then re-run this gate.",
        });
        terminal = undefined;
        break;
      }
      seen.add(next.task.id);
      current = next;
      terminal = next;
    }
    if (terminal && terminal.task.id !== member.task.id) supersededBy.set(member.task.id, terminal);
  }

  return {
    effective: members.filter((member) => !supersededBy.has(member.task.id)),
    superseded: members
      .filter((member) => supersededBy.has(member.task.id))
      .map((member) => ({
        externalKey: member.task.externalKey,
        state: member.task.state,
        supersededBy: supersededBy.get(member.task.id)!.task.externalKey,
      })),
    conflicts,
  };
}

function isSupersededSomewhere(member: EpicMemberInput, supersedersOf: Map<string, EpicMemberInput[]>) {
  return (supersedersOf.get(member.task.id) ?? []).length > 0;
}

/** One aggregate check performed for this epic, whatever produced it and whenever. */
export interface EpicHeadEvidence {
  dimension: EpicDimension;
  artifactId: string;
  /** The commit the check actually ran against; anything but the head SHA is stale by definition. */
  commitSha: string;
  passed: boolean;
  /** What ran, in the target project's own terms -- suite names, service containers, journey ids. */
  detail?: string;
  provenance: EpicEvidenceProvenance;
}

export interface EpicVerificationInput {
  epicKey: string;
  /** The single commit the whole epic is being judged at, normally the integration branch head. */
  headSha: string;
  members: EpicMemberInput[];
  /** Every evidence row recorded for this epic, at any commit. Staleness is decided here, not by the caller. */
  headEvidence: EpicHeadEvidence[];
  /**
   * Restricts the verdict to evidence that actually ran against this repository.
   *
   * This is a FILTER, never a label. It used to be neither: it was written straight onto the
   * report, so a caller could stamp any repository name onto a verdict, and a rename made that
   * visible -- asking about the new name returned a PASS built entirely from evidence recorded
   * against the old one. The reported repository is now always read back out of the evidence that
   * was actually counted.
   */
  repository?: string | undefined;
  generatedAt: string;
}

function ref(evidence: EpicHeadEvidence): EpicEvidenceRef {
  return { artifactId: evidence.artifactId, provenance: evidence.provenance, ...(evidence.detail ? { detail: evidence.detail } : {}) };
}

const dimensionRemediation: Record<EpicDimension, string> = {
  CONTRACTS:
    "Run the target project's contract suites against the epic head SHA and record the result as epic evidence. Per-task contract runs do not carry over: a later task can break an earlier task's contract without either task's gate noticing.",
  CONSUMERS:
    "Verify every registered consumer still resolves the contract it depends on at the head SHA. This is the failure a per-task gate structurally cannot see, because the task that breaks a consumer is not the task that owns it.",
  INVARIANTS:
    "Run the generative suites at the head SHA. A property that held on one member's commit says nothing about the assembled system, and the counts and replay seed have to come from that run.",
  INTEGRATION_DEPENDENCIES:
    "Run the integration suites against real disposable PostgreSQL/Redis/object-storage instances at the head SHA and record which ones were actually exercised. A suite that skipped because its service was absent is not evidence.",
  SECURITY_PRIVACY:
    "Run the security and privacy suites at the head SHA. Ownership and consent enforcement are properties of the composed system, not of any single member.",
  MIGRATIONS:
    "Apply the full migration sequence from empty against a disposable database at the head SHA. Members that each migrated cleanly in isolation can still conflict in order.",
  JOURNEYS:
    "Run the cross-module journeys at the head SHA. These exist precisely to exercise paths that cross member boundaries, so no member's own suite covers them.",
};

/** Why a dimension does not apply to this epic at all, given what its members actually did. */
function notApplicableReason(dimension: EpicDimension, memberCount: number): string {
  switch (dimension) {
    case "CONTRACTS":
      return "no member's plan required contract coverage, so the epic exposes no contract surface to re-verify";
    case "MIGRATIONS":
      return "no member declared a schema change, so there is no migration sequence to replay";
    case "INVARIANTS":
      return "no member's verification profile marked PROPERTY as REQUIRED, so the epic carries no declared algorithmic invariant";
    case "INTEGRATION_DEPENDENCIES":
      return "no member required integration coverage, so no external dependency participates in this epic";
    case "CONSUMERS":
    case "JOURNEYS":
      return memberCount < 2
        ? `a single-member epic composes nothing, so there is no cross-member ${dimension === "CONSUMERS" ? "contract" : "journey"} to verify`
        : "no signal in the members argued for this dimension";
    case "SECURITY_PRIVACY":
      return "security and privacy verification is required on every epic";
  }
}

/**
 * True when the epic predates verification profiles, so nobody ever asked whether it carries an
 * algorithmic invariant. Reporting NOT_APPLICABLE here would be an assumption dressed as a finding:
 * the difference between "no member declared an invariant" and "no member was ever asked" is the
 * whole distinction this gate exists to keep. Found by running the gate against the real
 * CORE-BE-01..21 set, whose plans all predate the classifier.
 */
function invariantsUnassessed(members: EpicMemberInput[]): EpicMemberInput[] {
  return members.filter((member) => member.plan && !member.plan.verification);
}

function requirementFor(dimension: EpicDimension, members: EpicMemberInput[]): boolean {
  const plans = members.map((member) => member.plan).filter((plan): plan is NonNullable<typeof plan> => Boolean(plan));
  switch (dimension) {
    case "CONTRACTS":
      return plans.some((plan) => plan.testsRequired.includes("CONTRACT"));
    case "MIGRATIONS":
      return plans.some((plan) => plan.databaseChanges.length > 0 || plan.testsRequired.includes("MIGRATION"));
    case "INVARIANTS":
      return plans.some((plan) => requiresLayer(plan.verification, "PROPERTY"));
    case "INTEGRATION_DEPENDENCIES":
      return plans.some((plan) => plan.testsRequired.includes("INTEGRATION"));
    case "SECURITY_PRIVACY":
      return true;
    case "CONSUMERS":
    case "JOURNEYS":
      return members.length >= 2;
  }
}

/** The commit a member's own evidence was verified at, from its final manifest. */
export function memberVerifiedSha(member: EpicMemberInput): string | undefined {
  const manifest = [...member.artifacts]
    .reverse()
    .find((artifact) => artifact.kind === "FINAL_CHANGE_MANIFEST" && artifact.status === "AVAILABLE");
  return (manifest?.content as { verifiedCommitSha?: string } | undefined)?.verifiedCommitSha;
}

export function buildEpicVerification(input: EpicVerificationInput): EpicVerificationReport {
  // Resolved first: everything downstream -- which dimensions are required, which members must be
  // settled -- is a statement about the members that actually compose the system, not about the
  // ones history recorded on the way there.
  const supersession = resolveSupersession(input.members);
  const supersededKeys = new Set(supersession.superseded.map((value) => value.externalKey));
  const effective = supersession.effective;

  const members = input.members.map((member) => {
    const verifiedCommitSha = memberVerifiedSha(member);
    return {
      taskId: member.task.id,
      externalKey: member.task.externalKey,
      state: member.task.state,
      ...(verifiedCommitSha ? { verifiedCommitSha } : {}),
      // A member is only "settled" for epic purposes when its own formal path finished. Anything
      // else is an open edit to the system being judged.
      settled: member.task.state === "READY",
      planned: Boolean(member.plan),
      evidenceIsAtHead: verifiedCommitSha === input.headSha,
      ...(supersession.superseded.find((value) => value.externalKey === member.task.externalKey)
        ? { supersededBy: supersession.superseded.find((value) => value.externalKey === member.task.externalKey)!.supersededBy }
        : {}),
      ...(member.verifiedCommitContainedInHead === undefined ? {} : { verifiedCommitContainedInHead: member.verifiedCommitContainedInHead }),
    };
  });

  // A superseded member keeps its true state in the report and stops counting anywhere else.
  const active = members.filter((member) => !supersededKeys.has(member.externalKey));
  const unsettled = active.filter((member) => !member.settled);
  const unplanned = active.filter((member) => !member.planned);
  const staleMembers = active.filter((member) => member.settled && !member.evidenceIsAtHead);
  const notInHead = members.filter((member) => !supersededKeys.has(member.externalKey) && member.verifiedCommitContainedInHead === false);

  const unassessed = invariantsUnassessed(effective);

  // Evidence is bound to a commit AND to the repository it ran against. Matching on the commit
  // alone would let a verdict be assembled from runs against something else that happens to share
  // a SHA -- and, after a repository is renamed, would quietly answer a question about the new
  // name with evidence from the old one.
  const headEvidence = input.repository
    ? input.headEvidence.filter((evidence) => evidence.provenance.repository === input.repository)
    : input.headEvidence;

  const dimensions: EpicDimensionResult[] = epicDimensions.map((dimension): EpicDimensionResult => {
    const required = requirementFor(dimension, effective);
    const passingAtHead = headEvidence.filter(
      (evidence) => evidence.dimension === dimension && evidence.commitSha === input.headSha && evidence.passed,
    );
    // "Nobody was asked" only blocks while nobody has answered either. Once a run at the head
    // commit has actually exercised the generative layer and passed, the question of whether the
    // members declared it is moot -- it was performed. Blocking anyway would be the mirror of the
    // silent skip: refusing to count evidence that exists.
    if (dimension === "INVARIANTS" && !required && unassessed.length && !passingAtHead.length) {
      return {
        dimension,
        requirement: "REQUIRED",
        status: "BLOCKED",
        reasons: [
          `${unassessed.length} member(s) were planned before verification profiles existed (${unassessed
            .slice(0, 3)
            .map((member) => member.task.externalKey)
            .join(", ")}${unassessed.length > 3 ? ", ..." : ""}), so whether this epic carries an algorithmic invariant was never assessed. Reporting it as not applicable would state a finding nobody made.`,
        ],
        remediation:
          "Re-plan those members so each records a verification profile, then re-run this gate. A member that genuinely carries no invariant will say so with its reason, which is a different claim from silence.",
        evidence: [],
      };
    }
    if (!required && !passingAtHead.length) {
      return {
        dimension,
        requirement: "NOT_APPLICABLE" as const,
        status: "NOT_APPLICABLE" as const,
        reasons: [notApplicableReason(dimension, effective.length)],
        evidence: [],
      };
    }
    const atHead = headEvidence.filter(
      (evidence) => evidence.dimension === dimension && evidence.commitSha === input.headSha,
    );
    const passing = passingAtHead;
    if (passing.length) {
      return {
        dimension,
        requirement: "REQUIRED" as const,
        status: "PASS" as const,
        reasons: passing.map(
          (evidence) => `${evidence.provenance.sourceType}: ${evidence.detail ?? `verified at ${input.headSha}`}`,
        ),
        evidence: passing.map(ref),
      };
    }
    const failed = atHead.filter((evidence) => !evidence.passed);
    const reasons = failed.length
      ? failed.map((evidence) => `the epic run failed this dimension at ${input.headSha}: ${evidence.detail ?? "no detail recorded"}`)
      : [
          staleMembers.length
            ? `no check ran at ${input.headSha}; the only evidence comes from ${staleMembers.length} member(s) verified at earlier commits (${staleMembers
                .slice(0, 3)
                .map((member) => `${member.externalKey}@${member.verifiedCommitSha?.slice(0, 7) ?? "unknown"}`)
                .join(", ")}${staleMembers.length > 3 ? ", ..." : ""}), which says nothing about the assembled system`
            : `no check ran at ${input.headSha}`,
        ];
    return {
      dimension,
      requirement: "REQUIRED" as const,
      status: "BLOCKED" as const,
      reasons,
      remediation: dimensionRemediation[dimension],
      evidence: failed.map(ref),
    };
  });

  const blockers: EpicVerificationReport["blockers"] = [...supersession.conflicts];
  if (notInHead.length)
    blockers.push({
      code: "EPIC_MEMBER_NOT_IN_HEAD",
      reason: `These members were verified at a commit that is not reachable from ${input.headSha}, so the work they proved is not in what is being released: ${notInHead.map((m) => `${m.externalKey}@${m.verifiedCommitSha?.slice(0, 7) ?? "unknown"}`).join(", ")}`,
      remediation: "Rebase or re-land the missing work, then re-run the epic verification against the new head.",
    });
  if (unplanned.length)
    blockers.push({
      code: "EPIC_MEMBER_UNPLANNED",
      reason: `These members carry no approved plan, so nothing can be derived about what the epic owes: ${unplanned.map((m) => m.externalKey).join(", ")}`,
      remediation: "Run superadmin_task_analyze and superadmin_task_plan for each, or remove them from the epic set.",
    });
  if (unsettled.length)
    blockers.push({
      code: "EPIC_MEMBER_NOT_READY",
      reason: `The system being judged is still being edited: ${unsettled.map((m) => `${m.externalKey} (${m.state})`).join(", ")}`,
      remediation: "Finish or drop each member before the epic is verified; a member mid-flight can change the head SHA under the run.",
    });
  for (const dimension of dimensions) {
    if (dimension.status !== "BLOCKED") continue;
    blockers.push({
      code: `EPIC_${dimension.dimension}_UNVERIFIED_AT_HEAD`,
      reason: dimension.reasons.join(" "),
      remediation: dimension.remediation ?? dimensionRemediation[dimension.dimension],
    });
  }

  // Evidence recorded for this epic at any OTHER commit. Never counted, always listed: an operator
  // looking at a blocked epic needs to see that a check did run, just not on the commit in question.
  const staleEvidence = headEvidence
    .filter((evidence) => evidence.commitSha !== input.headSha)
    .map((evidence) => ({ ...ref(evidence), dimension: evidence.dimension, commitSha: evidence.commitSha }));

  const passingSources = new Set(
    dimensions.flatMap((dimension) =>
      dimension.status === "PASS" ? dimension.evidence.map((value) => value.provenance.sourceType) : [],
    ),
  );
  const trust: EpicVerificationReport["trust"] = passingSources.size === 0
    ? "NONE"
    : passingSources.size > 1
      ? "MIXED"
      : passingSources.has("TRUSTED_CI")
        ? "CI_VERIFIED"
        : "OPERATOR_ASSERTED";

  // Read back out of the evidence, never echoed from the input. `findLast` so a repository that has
  // been re-verified reports under the identity of its most recent run rather than its first.
  const repository = headEvidence
    .filter((evidence) => evidence.commitSha === input.headSha)
    .at(-1)?.provenance.repository;

  return {
    epicKey: input.epicKey,
    ...(repository ? { repository } : {}),
    headSha: input.headSha,
    result: blockers.length ? "BLOCKED" : "PASS",
    trust,
    members,
    dimensions,
    staleEvidence,
    missingDimensions: dimensions
      .filter((dimension) => dimension.status === "BLOCKED" && dimension.evidence.length === 0)
      .map((dimension) => dimension.dimension),
    effectiveMembers: effective.length,
    supersededMembers: supersession.superseded,
    blockers,
    generatedAt: input.generatedAt,
  };
}

/** The dimensions an epic run still has to cover, so a runner can be told exactly what to execute. */
export function outstandingDimensions(report: EpicVerificationReport): EpicDimension[] {
  return report.dimensions.filter((dimension) => dimension.status === "BLOCKED").map((dimension) => dimension.dimension);
}
