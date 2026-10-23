import type { Mission, Resource, Task } from "../../schemas/src/index.js";
import type { RepairProgress } from "./repair-progress.js";

// A mission's progress, derived from evidence on every read (ADR 026).
//
// An agent session ends -- its context overflows, a new chat starts -- and everything it knew about
// "where we are" goes with it. The next session then explores from scratch and drifts to whatever
// it finds first. Nothing that matters lives in the session: the goal, its repositories, its tasks
// and every verdict are already in the control plane. This module turns them into one answer --
// what is done, what is running, what failed and why, and the single call that comes next -- so
// any session resumes the work from one read. Nothing here is stored or asserted by a caller, so a
// mission can never read as further along than its evidence.

export type MissionStepStatus = "DONE" | "RUNNING" | "REMAINING" | "FAILING";
export interface NextCall {
  tool: string;
  arguments?: Record<string, unknown>;
  why: string;
}
export interface MissionStep {
  id: "REPOSITORIES" | "TASKS" | "PARITY";
  status: MissionStepStatus;
  detail: string;
  next?: NextCall;
}

export interface MissionTaskView {
  task: Pick<Task, "id" | "externalKey" | "title" | "state">;
  /** From task readiness; null while a job for the task is running. */
  nextAction: { tool: string; why: string } | null;
  repair?: Pick<RepairProgress, "consecutiveSameCause" | "stagnating" | "guidance">;
}

/** The newest HTTP E2E run of the target against the reference, as recorded. */
export interface ParityRunView {
  jobId: string;
  status: string;
  commitSha: string;
  workflowRunUrl?: string;
  verdict?: "PROVEN" | "NOT_PROVEN";
  failureClass?: string;
  failureMessage?: string;
  diagnosis?: { area?: string; summary?: string; nextSteps?: string[] };
  coverage?: { covered?: number; total?: number };
}

/**
 * Where a reference that fails on its own gets fixed. Work on a WORKING repository is assembled in
 * the product's SANDBOX and released from there, so a single SANDBOX of the product is named;
 * otherwise the reference's own repository.
 */
export interface ReferenceFix {
  projectId: string;
  resourceId: string;
  repository: string;
  via: "SANDBOX" | "REFERENCE";
}

export interface MissionEvidence {
  target?: Resource;
  reference?: Resource;
  referenceFix?: ReferenceFix;
  tasks: MissionTaskView[];
  /** Attached task ids that no longer resolve to a task. */
  missingTaskIds: string[];
  parity?: ParityRunView;
  /** The target's default-branch head now, when the provider could say. */
  targetHead?: string;
}

export interface MissionProgress {
  complete: boolean;
  steps: MissionStep[];
  /** The first call that moves the mission forward; for a RUNNING step, the call that reads it. */
  nextAction: NextCall | null;
}

const runningJob = new Set(["QUEUED", "DISPATCHING", "DISPATCHED", "CLAIMED", "RUNNING"]);
const short = (sha: string) => sha.slice(0, 12);

function repositoriesStep(mission: Mission, evidence: MissionEvidence): MissionStep {
  const { target, reference } = evidence;
  const projectId = mission.projectId;
  if (!target || target.status === "DELETED")
    return { id: "REPOSITORIES", status: "FAILING", detail: "The target repository is no longer registered in this project.", next: { tool: "superadmin_mission_update", arguments: { projectId, missionId: mission.id, status: "CANCELLED" }, why: "Register the target again with superadmin_repository_register and create a new mission for it, or cancel this one." } };
  if (target.status !== "ACTIVE")
    return { id: "REPOSITORIES", status: "FAILING", detail: `The target ${target.externalReference} is ${target.status}.`, next: { tool: "superadmin_resource_update", arguments: { projectId, resourceId: target.resourceId, status: "ACTIVE" }, why: "A disabled repository refuses every read, execution and verification." } };
  if (!target.permissions.includes("WRITE"))
    return { id: "REPOSITORIES", status: "FAILING", detail: `The target ${target.externalReference} is registered without WRITE, so no change can be made in it.`, next: { tool: "superadmin_repository_register", arguments: { projectId, repository: target.externalReference, access: "FULL" }, why: "Re-registering with FULL access updates the existing registration in place." } };
  if (mission.goal.kind === "PARITY") {
    if (!reference || reference.status === "DELETED")
      return { id: "REPOSITORIES", status: "FAILING", detail: "The reference repository is no longer registered in this project.", next: { tool: "superadmin_repository_register", arguments: { projectId, access: "READ" }, why: "Register the reference implementation again (name it as owner/name), then point a new mission at it." } };
    if (reference.status !== "ACTIVE")
      return { id: "REPOSITORIES", status: "FAILING", detail: `The reference ${reference.externalReference} is ${reference.status}; it cannot be started for comparison.`, next: { tool: "superadmin_resource_update", arguments: { projectId, resourceId: reference.resourceId, status: "ACTIVE" }, why: "Parity runs the reference in its own environment." } };
    return { id: "REPOSITORIES", status: "DONE", detail: `Target ${target.externalReference}, reference ${reference.externalReference}.` };
  }
  return { id: "REPOSITORIES", status: "DONE", detail: `Target ${target.externalReference}.` };
}

function tasksStep(mission: Mission, evidence: MissionEvidence): MissionStep {
  const projectId = mission.projectId;
  if (evidence.missingTaskIds.length)
    return { id: "TASKS", status: "FAILING", detail: `${evidence.missingTaskIds.length} attached task(s) no longer exist.`, next: { tool: "superadmin_mission_update", arguments: { projectId, missionId: mission.id, removeTaskIds: evidence.missingTaskIds }, why: "Detach tasks that were deleted so the mission measures what still exists." } };
  if (!evidence.tasks.length)
    return {
      id: "TASKS",
      status: "REMAINING",
      detail: "No task is attached. Work and verification are recorded against a task.",
      next: { tool: "superadmin_task_create", arguments: { projectId }, why: `Create the task that carries this mission's work in ${evidence.target?.externalReference ?? "the target"}, then attach it with superadmin_mission_update addTaskIds.` },
    };
  const open = evidence.tasks.filter((view) => view.task.state !== "READY");
  if (!open.length) return { id: "TASKS", status: "DONE", detail: `All ${evidence.tasks.length} task(s) are READY.` };
  const first = open[0]!;
  const key = first.task.externalKey;
  const others = open.length > 1 ? ` ${open.length - 1} more open: ${open.slice(1, 6).map((view) => `${view.task.externalKey} (${view.task.state})`).join(", ")}.` : "";
  const stagnation = first.repair?.stagnating ? ` ${first.repair.guidance ?? ""}` : "";
  if (!first.nextAction)
    return { id: "TASKS", status: "RUNNING", detail: `${key} is ${first.task.state} with a job running.${others}`, next: { tool: "superadmin_task_readiness", arguments: { projectId, taskId: first.task.id }, why: `Read ${key} again when its job finishes; nothing needs to be sent meanwhile.` } };
  const failing = first.task.state === "BLOCKED" || first.task.state === "FAILED";
  return {
    id: "TASKS",
    status: failing ? "FAILING" : "REMAINING",
    detail: `${key} is ${first.task.state}.${others}${stagnation}`,
    next: { tool: first.nextAction.tool, arguments: { projectId, taskId: first.task.id }, why: `${key}: ${first.nextAction.why}` },
  };
}

function parityStep(mission: Mission, evidence: MissionEvidence): MissionStep {
  if (mission.goal.kind !== "PARITY") throw new Error("parityStep requires a PARITY goal");
  const projectId = mission.projectId;
  const taskId = evidence.tasks[0]?.task.id;
  const run: NextCall = {
    tool: "superadmin_http_e2e_run",
    arguments: {
      projectId,
      ...(taskId ? { taskId } : {}),
      repositoryResourceId: mission.goal.targetResourceId,
      scenarioSource: { kind: "REPOSITORY" },
      counterpart: { repositoryResourceId: mission.goal.referenceResourceId, ...(mission.goal.referenceRef ? { ref: mission.goal.referenceRef } : {}), label: "reference" },
    },
    why: "Builds and starts both implementations in throwaway environments, runs every scenario against every contract, and compares each response.",
  };
  const parity = evidence.parity;
  const pinned = mission.goal.referenceRef ? ` at ${mission.goal.referenceRef}` : "";
  if (!parity) return { id: "PARITY", status: "REMAINING", detail: `The target has never been compared with the reference${pinned}.`, next: run };
  const read: NextCall = { tool: "superadmin_http_e2e_get", arguments: { projectId, jobId: parity.jobId }, why: "" };
  if (runningJob.has(parity.status))
    return { id: "PARITY", status: "RUNNING", detail: `Comparison at ${short(parity.commitSha)} is ${parity.status}.`, next: { ...read, why: "Read the verdict when the run finishes; nothing needs to be sent meanwhile." } };
  const coverage = parity.coverage?.total ? ` Coverage ${parity.coverage.covered ?? 0}/${parity.coverage.total} operations.` : "";
  if (parity.verdict === "PROVEN") {
    if (evidence.targetHead && evidence.targetHead !== parity.commitSha)
      return { id: "PARITY", status: "REMAINING", detail: `Proven at ${short(parity.commitSha)}, but the target has moved to ${short(evidence.targetHead)}; the proof does not cover the new commits.${coverage}`, next: { ...run, why: "Re-prove parity at the current head." } };
    return { id: "PARITY", status: "DONE", detail: `PROVEN at ${short(parity.commitSha)}: the target answers every scenario as the reference does.${coverage}` };
  }
  // The reference failed by itself (it would not build, start or pass the scenarios). No change in
  // the target can fix that, and an agent told to "fix the cause" in the target only goes round in
  // circles -- so the step says where the fix belongs.
  if (parity.failureClass === "REFERENCE_NOT_PROVEN" || parity.diagnosis?.area === "REFERENCE") {
    const reference = evidence.reference?.externalReference ?? "the reference";
    const fix = evidence.referenceFix;
    const where = !fix
      ? `in ${reference}`
      : fix.via === "SANDBOX"
        ? `in ${fix.repository} (the product's SANDBOX), then release it to ${reference}`
        : `in ${fix.repository}`;
    const repin = mission.goal.referenceRef ? ` The mission pins the reference at ${mission.goal.referenceRef}: once the fix is in ${reference}, move referenceRef to the fixed commit (superadmin_mission_update).` : "";
    return {
      id: "PARITY",
      status: "FAILING",
      detail: `The reference itself does not pass at this comparison (${short(parity.commitSha)} of the target): ${parity.failureMessage ?? "it was not proven"}. Nothing in the target can change this.`,
      next: {
        tool: "superadmin_task_create",
        arguments: { projectId: fix?.projectId ?? mission.projectId },
        why: `Fix the reference ${where}: ${parity.failureMessage ?? "it was not proven"}. Read the reference's own steps and application log in superadmin_http_e2e_get (jobId ${parity.jobId}, counterpart).${repin} Then compare again with superadmin_http_e2e_run.`,
      },
    };
  }
  const cause = parity.failureClass ? `${parity.failureClass}${parity.failureMessage ? `: ${parity.failureMessage}` : ""}` : "the run produced no verdict";
  const diagnosis = parity.diagnosis?.summary ? ` Diagnosis (${parity.diagnosis.area ?? "unknown area"}): ${parity.diagnosis.summary}` : "";
  const steps = parity.diagnosis?.nextSteps?.length ? ` Next: ${parity.diagnosis.nextSteps.slice(0, 3).join(" ")}` : "";
  return {
    id: "PARITY",
    status: "FAILING",
    detail: `NOT_PROVEN at ${short(parity.commitSha)} -- ${cause}.${coverage}${diagnosis}${steps}`,
    next: { ...read, why: "Read the full diagnosis, steps and logs, fix that cause (superadmin_task_execute in the target, or the scenarios/contract it names), then run the comparison again." },
  };
}

export function missionProgress(mission: Mission, evidence: MissionEvidence): MissionProgress {
  // A parity run is recorded against a task, so TASKS precedes PARITY even when the work is small.
  const steps: MissionStep[] = [repositoriesStep(mission, evidence), tasksStep(mission, evidence)];
  if (mission.goal.kind === "PARITY") steps.push(parityStep(mission, evidence));
  const complete = steps.every((step) => step.status === "DONE");
  // A known failure outranks remaining work, and both outrank waiting: a task resting on a running
  // job must not hide a comparison that already says what is wrong.
  //
  // In a PARITY mission the comparison is the measurement that says what to change, so a comparison
  // still to run comes before remaining task work -- as long as there is a task to record it
  // against and that task has no job of its own in flight.
  const parity = steps.find((step) => step.id === "PARITY");
  const tasks = steps.find((step) => step.id === "TASKS");
  const measureFirst = parity?.status === "REMAINING" && tasks?.status === "REMAINING" && Boolean(parity.next?.arguments?.["taskId"]);
  // A comparison is recorded against the same task, which accepts one job at a time: while the
  // task's own job runs, the next call is to wait for it.
  const waitForTask = tasks?.status === "RUNNING" ? tasks : undefined;
  const actionable = steps.find((step) => step.status === "FAILING") ?? waitForTask ?? (measureFirst ? parity : undefined) ?? (["REMAINING", "RUNNING"] as const).map((status) => steps.find((step) => step.status === status)).find(Boolean);
  const nextAction = complete
    ? { tool: "superadmin_mission_update", arguments: { projectId: mission.projectId, missionId: mission.id, status: "ACHIEVED" }, why: "Every step is proven by evidence; record the mission as achieved." }
    : (actionable?.next ?? null);
  return { complete, steps, nextAction };
}
