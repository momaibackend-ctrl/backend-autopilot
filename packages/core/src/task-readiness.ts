import type { Artifact, ArtifactKind, ImplementationPlan, Run, Task, VerificationProfile } from "../../schemas/src/index.js";
import { requiresLayer } from "./verification-profile.js";

// What a task still needs before it can reach READY, and what to call next to get there.
//
// This exists because every stall in the CORE-BE-07..11 series cost a blind repair loop for the
// same reason: the gate knew exactly what was missing, but only said so after the work had already
// run, in a message too terse to act on ("READY gate artifacts missing", "Independent review
// failed"). An agent could not ask beforehand and could not tell from the failure what to do.
//
// `taskReview` computes its verdict from the same functions exported here, so the preflight answer
// and the real gate cannot drift apart -- a readiness report that disagreed with the gate would be
// worse than none at all.

export interface TaskBlocker {
  code: string;
  reason: string;
  /** The concrete next call or edit that clears this blocker. */
  remediation: string;
}

export interface GateArtifactView {
  required: string[];
  present: string[];
  missing: string[];
}

export interface TaskReadiness {
  taskId: string;
  externalKey: string;
  state: Task["state"];
  /** The single call an agent should make next, or null when it should wait for a running job. */
  nextAction: { tool: string; why: string } | null;
  /** Everything that will fail a later gate if left alone, each with its own remediation. */
  blockers: TaskBlocker[];
  gateArtifacts: GateArtifactView;
  /**
   * Which verification layers this task owes and which it does not, straight from the approved
   * plan -- so an agent can read the matrix before implementing rather than discovering a missing
   * layer at the gate. Null until the task is planned.
   */
  verification: VerificationProfile | null;
  /** True only when every formal gate artifact exists; merge tools additionally require READY. */
  gateArtifactsComplete: boolean;
}

/** The plan fields the gate reads. Kept narrow so callers can pass a partial persisted plan. */
export type GatePlan = Pick<ImplementationPlan, "apiChanges" | "databaseChanges"> &
  Partial<Pick<ImplementationPlan, "verification">>;

/** Artifact kinds the READY gate demands, given the approved plan and whether CI is external. */
export function requiredGateArtifacts(
  plan: GatePlan | undefined,
  requiresExternalCi: boolean,
): ArtifactKind[] {
  const required: ArtifactKind[] = [
    "REQUIREMENTS_SNAPSHOT",
    "IMPLEMENTATION_PLAN",
    "ARCHITECTURE_REVIEW",
    "CODE_DIFF",
    "TEST_REPORT",
    "SECURITY_REPORT",
    "REVIEW_REPORT",
  ];
  if (requiresExternalCi) required.push("CI_REPORT");
  if (plan?.databaseChanges.length) required.push("MIGRATION_MANIFEST");
  if (plan?.apiChanges.length) required.push("API_CONTRACT");
  // A task whose plan declared an algorithmic invariant cannot reach READY on a green build alone.
  // Plans written before verification profiles existed carry no profile and are unaffected.
  if (requiresLayer(plan?.verification, "PROPERTY")) required.push("PROPERTY_BASED_REPORT");
  return required;
}

/**
 * A CI report only counts when it was produced for the exact commit under review; an older green
 * report from a previous attempt must never satisfy the gate for newer code.
 */
export function hasExactCiReport(artifacts: Artifact[], latestCommit: string | undefined) {
  if (!latestCommit) return false;
  return artifacts.some((artifact) => {
    if (artifact.kind !== "CI_REPORT") return false;
    const content = artifact.content as {
      expectedSha?: string;
      ci?: { success?: boolean; headSha?: string };
    };
    return (
      content.expectedSha === latestCommit &&
      content.ci?.success === true &&
      content.ci?.headSha === latestCommit
    );
  });
}

// Why each artifact exists and what produces it. Keyed by artifact kind so a missing-artifact
// error can name the call that creates it instead of leaving the agent to guess.
const artifactSource: Record<string, string> = {
  REQUIREMENTS_SNAPSHOT:
    "Created only by superadmin_task_analyze. Moving a task into ANALYZING with superadmin_task_transition skips it, and the gap only surfaces much later at the READY gate.",
  IMPLEMENTATION_PLAN: "Created by superadmin_task_plan.",
  ARCHITECTURE_REVIEW: "Created by superadmin_task_plan alongside the plan.",
  CODE_DIFF: "Written by the execution runner once superadmin_task_execute commits a change set.",
  TEST_REPORT: "Written by the execution runner when the required suites run.",
  SECURITY_REPORT: "Written by the execution runner alongside the test report.",
  REVIEW_REPORT: "Written by the independent review gate at the end of an execution.",
  CI_REPORT: "Written by the execution runner from the GitHub Actions result for the exact commit.",
  MIGRATION_MANIFEST:
    "Written by the execution runner when the change set touches a migrations path. The plan lists databaseChanges, so the gate requires one.",
  API_CONTRACT:
    "Written by the execution runner when the change set touches an openapi file. The plan lists apiChanges, so the gate requires one. If this task adds no public HTTP surface, say so plainly in its requirements (\"do not add public HTTP APIs\", or INTERNAL_ONLY) and re-plan -- the planner reads the refusal and stops demanding contract evidence.",
  PROPERTY_BASED_REPORT:
    "Written by the execution runner from the generative framework's own output. The plan's verification profile marks PROPERTY as REQUIRED, so the gate wants generated-case counts and a replay seed, not a green build. Add jqwik or fast-check properties for the named invariant, or emit reports/property-based-report.json. If the task carries no invariant, name its CRUD/DTO/adapter/static-registry shape in the requirements and re-plan.",
};

const nextByState: Record<string, { tool: string; why: string } | null> = {
  INGESTED: { tool: "superadmin_task_analyze", why: "Records the requirements snapshot the READY gate later requires." },
  ANALYZING: { tool: "superadmin_task_plan", why: "Produces the approved plan and architecture review." },
  PLANNED: { tool: "superadmin_task_execute", why: "Dispatches the implementation with a fresh operationId." },
  IMPLEMENTING: { tool: "superadmin_task_execute", why: "Send the repair change set with a NEW operationId; reusing one is status-only." },
  TESTING: null,
  REVIEWING: null,
  READY: { tool: "superadmin_sandbox_pull_request_open", why: "All gates passed; open the pull request, then superadmin_sandbox_pull_request_merge." },
  BLOCKED: { tool: "superadmin_task_analyze", why: "Re-enters the formal path from BLOCKED and regenerates the requirements snapshot." },
  FAILED: { tool: "superadmin_task_analyze", why: "Re-enters the formal path from FAILED and regenerates the requirements snapshot." },
};

export function taskReadiness(input: {
  task: Task;
  artifacts: Artifact[];
  runs: Run[];
  plan?: GatePlan | undefined;
  requiresExternalCi: boolean;
  /** True when a job for this task is still queued or running. */
  executionInFlight?: boolean;
}): TaskReadiness {
  const artifacts = input.artifacts.filter((value) => value.taskId === input.task.id && value.status === "AVAILABLE");
  const runs = input.runs.filter((value) => value.taskId === input.task.id);
  const latestCommit = runs.at(-1)?.commitSha;

  const required = requiredGateArtifacts(input.plan, input.requiresExternalCi);
  const present = required.filter((kind) => artifacts.some((a) => a.kind === kind));
  const missing = required.filter((kind) => !present.includes(kind));

  const blockers: TaskBlocker[] = missing.map((kind) => ({
    code: `MISSING_${kind}`,
    reason: `The READY gate requires a ${kind} artifact and this task has none.`,
    remediation: artifactSource[kind] ?? `Produce a ${kind} artifact before requesting review.`,
  }));

  // An outdated-but-green CI report is the subtler half of the same gate and reads as a pass
  // everywhere else, so it is called out separately from a missing one.
  if (input.requiresExternalCi && present.includes("CI_REPORT") && !hasExactCiReport(artifacts, latestCommit)) {
    blockers.push({
      code: "CI_REPORT_EXACT_LATEST_COMMIT",
      reason: `No successful CI report matches the latest run commit ${latestCommit ?? "(none recorded)"}.`,
      remediation:
        "Re-run the execution so CI is evaluated against the current commit. A green report from an earlier attempt never satisfies this gate.",
    });
  }

  return {
    taskId: input.task.id,
    externalKey: input.task.externalKey,
    state: input.task.state,
    nextAction: input.executionInFlight ? null : (nextByState[input.task.state] ?? null),
    blockers,
    gateArtifacts: { required, present, missing },
    verification: input.plan?.verification ?? null,
    gateArtifactsComplete: blockers.length === 0,
  };
}
