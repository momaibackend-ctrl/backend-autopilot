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
  /**
   * Set once the task's pull request is recorded as merged. The formal path is then over, and
   * `nextAction` is null: continuing to advertise "open a pull request" for work already in the
   * default branch reads as unfinished business and invites a duplicate PR.
   */
  completion: { state: "MERGED"; pullRequestUrl?: string; reason: string } | null;
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
  /** Overrides merge detection for callers that also resolve delivery from the audit trail. */
  merged?: boolean;
}): TaskReadiness {
  const artifacts = input.artifacts.filter((value) => value.taskId === input.task.id && value.status === "AVAILABLE");
  const runs = input.runs.filter((value) => value.taskId === input.task.id);
  const latestCommit = runs.at(-1)?.commitSha;

  // The durable merge record. `merged` is passed explicitly by callers that resolve delivery from
  // audit as well (older tasks predate PULL_REQUEST_REPORT); otherwise the artifact is the source.
  const mergedReport = [...artifacts]
    .reverse()
    .find((artifact) => artifact.kind === "PULL_REQUEST_REPORT" && (artifact.content as { merged?: boolean }).merged === true);
  const merged = input.merged ?? Boolean(mergedReport);
  const pullRequestUrl = (mergedReport?.content as { pullRequest?: { url?: string } } | undefined)?.pullRequest?.url;

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
    nextAction: merged || input.executionInFlight ? null : (nextByState[input.task.state] ?? null),
    blockers,
    gateArtifacts: { required, present, missing },
    verification: input.plan?.verification ?? null,
    completion: merged
      ? {
          state: "MERGED",
          ...(pullRequestUrl ? { pullRequestUrl } : {}),
          reason: "The pull request for this task is recorded as merged into the default branch; nothing in the formal path remains.",
        }
      : null,
    gateArtifactsComplete: blockers.length === 0,
  };
}

// The project-wide companion to taskReadiness. taskReadiness answers "what does THIS task still
// need"; this answers "which tasks are waiting on me at all" -- the question nobody could ask
// before, because a task handed back by a finished execution appeared in no view. CORE-BE-25's job
// ended FAILED, the lifecycle returned the task to IMPLEMENTING for a repair attempt, and it sat
// there for eight hours: not in activeJobs, since its job had finished, and not in failedGates,
// which only covers tasks whose own state is FAILED or BLOCKED.
//
// It lives here rather than in a module of its own so it travels with taskReadiness through the
// Edge bundle -- and because it is the same question at a different scope.

/** Nothing further happens to a task in one of these states unless someone asks for it. */
const terminalTaskStates = new Set(['READY', 'FAILED']);
/** A job in one of these is still the platform's turn; anything else has handed the task back. */
const liveJobStatuses = new Set(['QUEUED', 'DISPATCHING', 'DISPATCHED', 'CLAIMED', 'RUNNING']);

export interface AwaitingTask {
  taskId: string;
  externalKey: string;
  title: string;
  state: string;
  /** How the last execution ended, or NONE when the task has never been executed. */
  lastJobStatus: string;
  repairAttempts: number;
  updatedAt: string;
  /** Whole hours since the task last changed, so a long-forgotten one is obvious at a glance. */
  idleHours: number;
  why: string;
}

export function awaitingCaller(input: {
  tasks: Array<{ id: string; externalKey: string; title: string; state: string; repairAttempts?: number; updatedAt: string }>;
  jobs: Array<{ taskId: string; status: string; updatedAt: string }>;
  now: string;
}): AwaitingTask[] {
  const latestJob = new Map<string, { status: string; updatedAt: string }>();
  for (const job of input.jobs) {
    const seen = latestJob.get(job.taskId);
    if (!seen || seen.updatedAt < job.updatedAt) latestJob.set(job.taskId, { status: job.status, updatedAt: job.updatedAt });
  }
  const nowMs = Date.parse(input.now);
  return input.tasks
    .filter((task) => !terminalTaskStates.has(task.state))
    .filter((task) => !input.jobs.some((job) => job.taskId === task.id && liveJobStatuses.has(job.status)))
    .map((task) => {
      const last = latestJob.get(task.id);
      const lastJobStatus = last?.status ?? 'NONE';
      return {
        taskId: task.id,
        externalKey: task.externalKey,
        title: task.title,
        state: task.state,
        lastJobStatus,
        repairAttempts: task.repairAttempts ?? 0,
        updatedAt: task.updatedAt,
        idleHours: Math.max(0, Math.floor((nowMs - Date.parse(task.updatedAt)) / 3_600_000)),
        why: reasonFor(task.state, lastJobStatus),
      };
    })
    .sort((a, b) => b.idleHours - a.idleHours);
}

function reasonFor(state: string, lastJobStatus: string): string {
  if (state === 'BLOCKED') return 'BLOCKED by an unmet dependency or a policy gate. Read task_status.readiness.blockers for which one.';
  if (lastJobStatus === 'NONE') return `In ${state} and never executed. It is waiting for its first execution.`;
  if (['FAILED', 'TIMED_OUT'].includes(lastJobStatus))
    return `Its last execution ended ${lastJobStatus} and the lifecycle returned it to ${state} for a repair attempt. Read the failing log with artifact_read(tail:true), then send the repair through task_status.readiness.nextAction.`;
  if (lastJobStatus === 'CANCELLED') return `Its last execution was CANCELLED, so ${state} is where it was left. Re-execute it or close it out.`;
  return `In ${state} with its last execution ${lastJobStatus}. Nothing is running, so it is waiting on the next call from you.`;
}
