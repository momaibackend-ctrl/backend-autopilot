import { AuditLog } from "../../audit/src/index.js";
import type { ExecutionJob } from "../../schemas/src/index.js";
import { WorkflowEngine } from "../../workflow-engine/src/index.js";
import type { ExecutionJobDispatcher } from "./async-execution.js";
import { activeJobStatuses, classifyExecutionJob, type ReconcileDecision, type WorkflowRunView } from "./execution-reconciliation.js";
import type { Clock, IdGenerator, StateStore } from "./ports.js";

// Stalled work resumes; it is not parked (ADR 028).
//
// The scheduled reconciler used to end a stalled job -- never started, runner gone, workflow ended
// without its callback -- and move its task to BLOCKED. Nothing ever picked it up again: the work
// stood still until a person or an agent noticed, and an agent that had lost its context never
// did. A stall is almost always the environment (a runner that never came, a lease that lapsed),
// not the work, so the honest answer is to run the same work again and say why.
//
// The stalled job still ends, with its cause recorded. A new job carries the same work as the next
// attempt. When the same cause keeps repeating, the next attempt waits longer -- immediately, then
// 15 minutes, doubling to a six-hour ceiling -- so a broken environment is retried for as long as it
// takes without spending a runner every quarter of an hour. Only a run a person cancelled in
// GitHub stays stopped: that is a decision, not a stall.

/** The kinds whose work is fully described by the job, so running it again is the same work. */
const resumableKinds = new Set<ExecutionJob["kind"]>(["IMPLEMENTATION", "REPAIR", "REBASE", "HTTP_E2E"]);
export const RESUME_BACKOFF_BASE_MINUTES = 15;
export const RESUME_BACKOFF_CEILING_MINUTES = 360;

/** Minutes to wait before the next attempt, given how many times in a row this cause stalled. */
export function resumeDelayMinutes(consecutiveSameCause: number): number {
  if (consecutiveSameCause <= 1) return 0;
  return Math.min(RESUME_BACKOFF_BASE_MINUTES * 2 ** (consecutiveSameCause - 2), RESUME_BACKOFF_CEILING_MINUTES);
}

export function isResumable(job: ExecutionJob, decision: Extract<ReconcileDecision, { action: "TERMINALIZE" }>): boolean {
  return resumableKinds.has(job.kind) && decision.code !== "GITHUB_ACTIONS_CANCELLED";
}

/** The next attempt of a stalled job: the same work, a new identity, and when it may start. */
export function resumeJob(job: ExecutionJob, cause: string, now: string, id: string): ExecutionJob {
  const consecutiveSameCause = job.resume?.cause === cause ? job.resume.consecutiveSameCause + 1 : 1;
  const attempt = (job.resume?.attempt ?? 0) + 1;
  const root = job.resume?.root ?? job.id;
  const notBefore = new Date(Date.parse(now) + resumeDelayMinutes(consecutiveSameCause) * 60_000).toISOString();
  // The stalled job's lifecycle fields stay behind; the published commit, if any, is kept because
  // origin really carries it and the next attempt continues from there.
  const work: Partial<ExecutionJob> = { ...job };
  for (const field of ["workflowRunId", "workflowRunUrl", "leaseOwner", "leaseExpiresAt", "startedAt", "finishedAt", "attemptedCommitSha", "error", "result", "resume"] as const) delete work[field];
  return {
    ...(work as ExecutionJob),
    id,
    operationId: `${job.operationId.split("#resume-")[0]}#resume-${attempt}`,
    status: "QUEUED",
    attempt: job.attempt + 1,
    queuedAt: now,
    updatedAt: now,
    resume: { of: job.id, root, attempt, cause, consecutiveSameCause, notBefore },
  };
}

export interface StallRecoveryDependencies {
  store: StateStore;
  clock: Clock;
  ids: IdGenerator;
  /** HTTP_E2E jobs start their own workflow; every other kind starts the execution workflow. */
  dispatchers: { execution: ExecutionJobDispatcher; httpE2e: ExecutionJobDispatcher };
  /** The job's GitHub run, when it recorded one: a view, or "UNAVAILABLE" when GitHub would not say. */
  workflowRun(job: ExecutionJob): Promise<(WorkflowRunView & { htmlUrl?: string }) | "UNAVAILABLE" | undefined>;
}

export type StallRecoveryResult =
  | { jobId: string; action: "WAIT" | "IGNORE"; reason: string; workflowQuery?: "FAILED" }
  | { jobId: string; action: "DISPATCHED"; attempt: number }
  | { jobId: string; action: "DISPATCH_DEFERRED"; reason: string; notBefore: string }
  | { jobId: string; action: "RESUMED"; code: string; reason: string; resumedAs: string; attempt: number; notBefore: string }
  | { jobId: string; action: "TERMINALIZE"; status: ExecutionJob["status"]; code: string; reason: string };

/** One reconciler pass over every active job of every project. Reads only what is in flight. */
export async function recoverStalledWork(deps: StallRecoveryDependencies): Promise<StallRecoveryResult[]> {
  const audit = new AuditLog(deps.store, deps.ids, deps.clock);
  const projects = await deps.store.listProjects();
  const active = (await Promise.all(projects.map((project) => deps.store.listExecutionJobSummaries(project.id, undefined, activeJobStatuses)))).flat();
  const results: StallRecoveryResult[] = [];
  for (const summary of active) {
    let job = await deps.store.getExecutionJob(summary.projectId, summary.id);
    if (!job) continue;
    const now = deps.clock.now();

    // A resumed attempt waits for its back-off, then is dispatched here: nobody else will.
    if (job.status === "QUEUED" && job.resume) {
      if (job.resume.notBefore > now) {
        results.push({ jobId: job.id, action: "WAIT", reason: `Attempt ${job.resume.attempt} after ${job.resume.cause} starts at ${job.resume.notBefore}` });
        continue;
      }
      results.push(await dispatch(deps, audit, job));
      continue;
    }

    const run = job.workflowRunId ? await deps.workflowRun(job) : undefined;
    if (run && run !== "UNAVAILABLE" && run.htmlUrl && run.htmlUrl !== job.workflowRunUrl)
      job = await deps.store.updateExecutionJob({ ...job, workflowRunUrl: run.htmlUrl, updatedAt: now });
    const decision = classifyExecutionJob({ job, now, workflowRun: run && run !== "UNAVAILABLE" ? run : undefined });
    if (decision.action !== "TERMINALIZE") {
      results.push({ jobId: job.id, action: decision.action, reason: decision.reason, ...(run === "UNAVAILABLE" ? { workflowQuery: "FAILED" as const } : {}) });
      continue;
    }

    const resumable = isResumable(job, decision);
    const ended: ExecutionJob = { ...job, status: decision.status, leaseExpiresAt: now, finishedAt: now, updatedAt: now, error: { code: decision.code, message: decision.reason, remediation: resumable ? "Resumed automatically as a new attempt of the same work." : decision.remediation } };
    await deps.store.updateExecutionJob(ended);
    if (!resumable) {
      if (job.runId) {
        const storedRun = await deps.store.getRun(job.projectId, job.runId);
        if (storedRun?.status === "RUNNING") await deps.store.updateRun({ ...storedRun, status: decision.status === "BLOCKED" ? "BLOCKED" : "FAILED", finishedAt: now });
      }
      const task = await deps.store.getTask(job.projectId, job.taskId);
      if (task && task.state === "IMPLEMENTING") await new WorkflowEngine(deps.store, deps.ids, deps.clock).transition(task, "BLOCKED", `${decision.code}: ${decision.reason}`, "serverless-reconciler");
      results.push({ jobId: job.id, action: "TERMINALIZE", status: decision.status, code: decision.code, reason: decision.reason });
      continue;
    }

    // The task keeps its state and the run stays open: the work is still under way.
    const next = await deps.store.createExecutionJob(resumeJob(job, decision.code, now, deps.ids.next()));
    await audit.record({
      actor: "serverless-reconciler",
      action: "execution.job.resumed",
      projectId: job.projectId,
      taskId: job.taskId,
      resourceId: job.resourceId,
      input: { stalledJobId: job.id, kind: job.kind },
      result: { resumedAs: next.id, attempt: next.resume!.attempt, cause: decision.code, consecutiveSameCause: next.resume!.consecutiveSameCause, notBefore: next.resume!.notBefore },
      reason: `${decision.code}: ${decision.reason}`,
      correlationId: next.operationId,
    });
    results.push({ jobId: job.id, action: "RESUMED", code: decision.code, reason: decision.reason, resumedAs: next.id, attempt: next.resume!.attempt, notBefore: next.resume!.notBefore });
    if (next.resume!.notBefore <= now) results.push(await dispatch(deps, audit, next));
  }
  return results;
}

async function dispatch(deps: StallRecoveryDependencies, audit: AuditLog, job: ExecutionJob): Promise<StallRecoveryResult> {
  const resume = job.resume!;
  const dispatcher = job.kind === "HTTP_E2E" ? deps.dispatchers.httpE2e : deps.dispatchers.execution;
  try {
    const dispatching = await deps.store.updateExecutionJob({ ...job, status: "DISPATCHING", updatedAt: deps.clock.now() });
    const started = await dispatcher.dispatch(dispatching);
    await deps.store.updateExecutionJob({ ...dispatching, status: "DISPATCHED", ...started, updatedAt: deps.clock.now() });
    await audit.record({ actor: "serverless-reconciler", action: "execution.job.dispatched", projectId: job.projectId, taskId: job.taskId, resourceId: job.resourceId, input: { jobId: job.id, kind: job.kind, resumeOf: resume.of }, result: { workflowRunId: started.workflowRunId ?? "pending", attempt: resume.attempt }, reason: `Resumed attempt ${resume.attempt} after ${resume.cause}`, correlationId: job.operationId });
    return { jobId: job.id, action: "DISPATCHED", attempt: resume.attempt };
  } catch (error) {
    // GitHub refusing the dispatch is one more stall; the attempt stays queued and tries again.
    const message = error instanceof Error ? error.message.slice(0, 300) : "dispatch failed";
    const notBefore = new Date(Date.parse(deps.clock.now()) + RESUME_BACKOFF_BASE_MINUTES * 60_000).toISOString();
    await deps.store.updateExecutionJob({ ...job, status: "QUEUED", updatedAt: deps.clock.now(), resume: { ...resume, notBefore, lastDispatchError: message } });
    return { jobId: job.id, action: "DISPATCH_DEFERRED", reason: message, notBefore };
  }
}
