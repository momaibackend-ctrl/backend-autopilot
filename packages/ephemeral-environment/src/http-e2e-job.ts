// The durable HTTP_E2E job: enqueue, prepare and record (ADR 018, stage 2c).
//
// A task asks for full HTTP verification of one repository commit. The control plane pins the
// exact SHA, authorizes the repository and dispatches the three-job workflow; the prepare job
// re-authorizes and claims the job; the environment job (no secrets) builds, starts and verifies
// the project; the record job accepts evidence only from the run that holds the job's lease and
// binds it to the commit. Any missing, oversized or malformed evidence is recorded as an honest
// NOT_PROVEN, never as a pass and never as silence.
//
// Web-only (zod plus core/store ports), so the Edge MCP can enqueue and read jobs with it.
import { z } from "zod";
import { AuditLog } from "../../audit/src/index.js";
import { Conflict, ExecutionFailed, InvalidState, NotFound, PolicyViolation, UnsupportedOperation } from "../../core/src/errors.js";
import type { ExecutionJobDispatcher } from "../../core/src/async-execution.js";
import type { Clock, IdGenerator, StateStore } from "../../core/src/ports.js";
import { requireProjectGithubRepository } from "../../core/src/repository-guard.js";
import type { GitRepositoryProvider } from "../../canonical-repository/src/ports.js";
import { collectionScenarios, type ImportedScenario } from "../../http-runner/src/collection.js";
import { restoreScenarioDefinition, type ArtifactWriter } from "../../http-runner/src/index.js";
import { PolicyEngine } from "../../policy-engine/src/index.js";
import type { ExecutionJob, Project, Resource } from "../../schemas/src/index.js";
import { diagnoseHttpE2e } from "./diagnosis.js";
import { ENVIRONMENT_EVIDENCE_VERSION, environmentEvidenceSchema, type EnvironmentEvidence, type FailureClass } from "./evidence.js";

export const HTTP_E2E_WORKFLOW = "autopilot-http-e2e.yml";
export const HTTP_E2E_LEASE_MINUTES = 75;
/** Evidence carries per-scenario reports; anything larger than this is refused, not truncated. */
export const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const commitSha = z.string().regex(/^[0-9a-f]{40}$/);
const root = z.string().regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]{0,200}$/);
const pathPrefix = z.string().regex(/^\/[A-Za-z0-9._~/-]{0,200}$/);

export const httpE2eScenarioSourceSchema = z.discriminatedUnion("kind", [
  // The Postman collections committed in the repository, found by discovery at the same commit.
  z.object({ kind: z.literal("REPOSITORY") }),
  // Scenarios saved in the control plane for one HTTP_API resource (imported or written there).
  z.object({ kind: z.literal("SAVED"), resourceId: z.string().uuid() }),
]);
const label = z.string().regex(/^[A-Za-z0-9 ._-]{1,40}$/);
/** Parity (stage 3): the reference implementation the subject is compared against. */
export const httpE2eCounterpartSchema = z.object({
  repositoryResourceId: z.string().uuid(),
  commitSha,
  requestedRef: z.string().min(1).max(255).optional(),
  root: root.optional(),
  label,
});
export const httpE2ePayloadSchema = z.object({
  commitSha,
  requestedRef: z.string().min(1).max(255).optional(),
  root: root.optional(),
  stripPathPrefix: pathPrefix.optional(),
  scenarioSource: httpE2eScenarioSourceSchema,
  counterpart: httpE2eCounterpartSchema.optional(),
});
export type HttpE2ePayload = z.infer<typeof httpE2ePayloadSchema>;

export interface HttpE2eDependencies {
  store: StateStore;
  clock: Clock;
  ids: IdGenerator;
}

const activeStatuses = ["QUEUED", "DISPATCHING", "DISPATCHED", "CLAIMED", "RUNNING"];

async function authorizedTarget(store: StateStore, projectId: string, resourceId: string, actor: string): Promise<{ project: Project; resource: Resource }> {
  const project = await store.getProject(projectId);
  if (!project) throw new NotFound("Project not found", { projectId });
  if (project.environment === "PRODUCTION" || project.autonomyMode === "AUTONOMOUS_PRODUCTION")
    throw new UnsupportedOperation("Production verification environments are NOT_SUPPORTED");
  const resource = await requireProjectGithubRepository(store, projectId, resourceId);
  if (resource.environment === "PRODUCTION") throw new UnsupportedOperation("Production resource access is not supported");
  // Provisioning a throwaway environment is PROVISION; reading the repository needs READ.
  await new PolicyEngine(store).authorize({ project, action: "PROVISION", resourceId: resource.resourceId, requiredPermission: "READ", actor });
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(resource.externalReference))
    throw new PolicyViolation("Registered GitHub repository reference is not owner/name", { resourceId });
  return { project, resource };
}

/**
 * Creates and dispatches one HTTP_E2E job. The caller names a task, a registered repository and
 * optionally a ref; the commit is resolved here, once, so the job verifies exactly that SHA even
 * if the branch moves while it runs.
 */
export async function enqueueHttpE2eJob(
  deps: HttpE2eDependencies & { dispatcher: ExecutionJobDispatcher; repositories: GitRepositoryProvider | undefined },
  input: {
    projectId: string;
    taskId: string;
    repositoryResourceId: string;
    ref?: string;
    root?: string;
    stripPathPrefix?: string;
    scenarioSource: HttpE2ePayload["scenarioSource"];
    counterpart?: { repositoryResourceId: string; ref?: string; root?: string; label?: string };
    operationId: string;
    actor: string;
  },
): Promise<ExecutionJob> {
  const { project, resource } = await authorizedTarget(deps.store, input.projectId, input.repositoryResourceId, input.actor);
  const task = await deps.store.getTask(project.id, input.taskId);
  if (!task) throw new NotFound("Task not found", { taskId: input.taskId });
  if (input.scenarioSource.kind === "SAVED") {
    const target = await deps.store.getResource(input.scenarioSource.resourceId);
    if (!target || target.projectId !== project.id || target.type !== "HTTP_API")
      throw new PolicyViolation("Saved scenarios must belong to an HTTP_API resource of this project", { resourceId: input.scenarioSource.resourceId });
  }
  const existing = await deps.store.findExecutionJobByOperation(project.id, input.operationId);
  if (existing) return existing;
  const active = await deps.store.listExecutionJobSummaries(project.id, task.id, activeStatuses);
  if (active.length) throw new Conflict("The task already has an active execution job; wait for it or cancel it first", { jobIds: active.map((job) => job.id) });
  const repositories = deps.repositories;
  if (!repositories) throw new UnsupportedOperation("Repository reads are not configured for this runtime");
  const pin = async (repository: string, ref: string | undefined) => {
    const pinned =
      ref && /^[0-9a-f]{40}$/.test(ref)
        ? (await repositories.commitExists(repository, ref))
          ? ref
          : undefined
        : await repositories.resolveRef(repository, ref ?? (await repositories.describe(repository)).defaultBranch);
    if (!pinned) throw new NotFound("Ref not found in the registered repository", { repository, ...(ref ? { ref } : {}) });
    return pinned;
  };
  const sha = await pin(resource.externalReference, input.ref);
  let counterpart: HttpE2ePayload["counterpart"];
  if (input.counterpart) {
    // The reference implementation is authorized exactly like the subject: a project-owned,
    // non-production GitHub repository the project may PROVISION against with READ.
    const reference = (await authorizedTarget(deps.store, project.id, input.counterpart.repositoryResourceId, input.actor)).resource;
    counterpart = httpE2eCounterpartSchema.parse({
      repositoryResourceId: reference.resourceId,
      commitSha: await pin(reference.externalReference, input.counterpart.ref),
      ...(input.counterpart.ref ? { requestedRef: input.counterpart.ref } : {}),
      ...(input.counterpart.root === undefined ? {} : { root: input.counterpart.root }),
      label: input.counterpart.label ?? "reference",
    });
  }
  const payload = httpE2ePayloadSchema.parse({
    commitSha: sha,
    ...(input.ref ? { requestedRef: input.ref } : {}),
    ...(input.root === undefined ? {} : { root: input.root }),
    ...(input.stripPathPrefix ? { stripPathPrefix: input.stripPathPrefix } : {}),
    scenarioSource: input.scenarioSource,
    ...(counterpart ? { counterpart } : {}),
  });
  const now = deps.clock.now();
  let job = await deps.store.createExecutionJob({
    id: deps.ids.next(),
    projectId: project.id,
    taskId: task.id,
    resourceId: resource.resourceId,
    operationId: input.operationId,
    kind: "HTTP_E2E",
    status: "QUEUED",
    payload,
    baseCommitSha: sha,
    attempt: 0,
    queuedAt: now,
    updatedAt: now,
  });
  const audit = new AuditLog(deps.store, deps.ids, deps.clock);
  try {
    job = await deps.store.updateExecutionJob({ ...job, status: "DISPATCHING", updatedAt: deps.clock.now() });
    const dispatched = await deps.dispatcher.dispatch(job);
    job = await deps.store.updateExecutionJob({ ...job, status: "DISPATCHED", ...dispatched, updatedAt: deps.clock.now() });
    await audit.record({ actor: input.actor, action: "http_e2e.job.dispatched", projectId: project.id, taskId: task.id, resourceId: resource.resourceId, input: { jobId: job.id, commitSha: sha, ...(counterpart ? { counterpartCommitSha: counterpart.commitSha } : {}) }, result: { workflowRunId: job.workflowRunId ?? "pending" }, reason: "HTTP E2E workflow accepted the job identifier", correlationId: input.operationId });
    return job;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown dispatch error";
    await deps.store.updateExecutionJob({ ...job, status: "FAILED", finishedAt: deps.clock.now(), updatedAt: deps.clock.now(), error: { code: "DISPATCH_FAILED", message: reason } });
    throw new ExecutionFailed("HTTP E2E dispatch failed; no verification is running", { jobId: job.id, remediation: `Check that ${HTTP_E2E_WORKFLOW} exists on the dispatch ref, then retry with a new operationId.` });
  }
}

/**
 * Starts verification of a commit as soon as its task rests in VERIFYING, so READY does not wait
 * for anyone to remember to ask. One job per task and commit: the operationId is derived from both,
 * so a repeated call (a retried runner, a reconciler) is a replay, never a second run.
 */
export async function enqueueVerificationOfReviewedCommit(
  deps: HttpE2eDependencies & { dispatcher: ExecutionJobDispatcher; repositories: GitRepositoryProvider | undefined },
  input: { projectId: string; taskId: string; repositoryResourceId: string; commitSha: string; actor: string },
): Promise<ExecutionJob | undefined> {
  const task = await deps.store.getTask(input.projectId, input.taskId);
  if (task?.state !== "VERIFYING" || !/^[0-9a-f]{40}$/.test(input.commitSha)) return undefined;
  return enqueueHttpE2eJob(deps, {
    projectId: input.projectId,
    taskId: input.taskId,
    repositoryResourceId: input.repositoryResourceId,
    ref: input.commitSha,
    scenarioSource: { kind: "REPOSITORY" },
    operationId: `auto-http-e2e:${input.taskId}:${input.commitSha}`,
    actor: input.actor,
  });
}

export interface PreparedHttpE2e {
  job: ExecutionJob;
  repository: string;
  commitSha: string;
  root?: string;
  stripPathPrefix?: string;
  /** Present for SAVED scenarios; REPOSITORY scenarios are discovered in the checkout itself. */
  scenarios?: ImportedScenario[];
  counterpart?: { repository: string; commitSha: string; root?: string; label: string };
}

/** Claims the job for this workflow run and resolves everything the environment job needs. */
export async function prepareHttpE2eJob(
  deps: HttpE2eDependencies & { artifacts: ArtifactWriter },
  input: { jobId: string; owner: string; workflowRunId?: string; workflowRunUrl?: string },
): Promise<PreparedHttpE2e> {
  const initial = await deps.store.getExecutionJobById(input.jobId);
  if (!initial) throw new NotFound("Execution job not found", { jobId: input.jobId });
  // Refused before claiming: a job of another kind must stay claimable by its own workflow.
  if (initial.kind !== "HTTP_E2E") throw new PolicyViolation("This workflow only runs HTTP_E2E jobs", { kind: initial.kind });
  const leaseExpiresAt = new Date(Date.parse(deps.clock.now()) + HTTP_E2E_LEASE_MINUTES * 60_000).toISOString();
  const claimed = await deps.store.claimExecutionJob(initial.projectId, initial.id, input.owner, leaseExpiresAt, deps.clock.now());
  if (!claimed) throw new Conflict("HTTP E2E job is already claimed or no longer claimable", { jobId: input.jobId });
  const job = await deps.store.updateExecutionJob({
    ...claimed,
    status: "RUNNING",
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    ...(input.workflowRunUrl ? { workflowRunUrl: input.workflowRunUrl } : {}),
    startedAt: claimed.startedAt ?? deps.clock.now(),
    updatedAt: deps.clock.now(),
  });
  try {
    const payload = httpE2ePayloadSchema.parse(job.payload);
    const { resource } = await authorizedTarget(deps.store, job.projectId, job.resourceId, input.owner);
    const counterpart = payload.counterpart
      ? {
          repository: (await authorizedTarget(deps.store, job.projectId, payload.counterpart.repositoryResourceId, input.owner)).resource.externalReference,
          commitSha: payload.counterpart.commitSha,
          ...(payload.counterpart.root === undefined ? {} : { root: payload.counterpart.root }),
          label: payload.counterpart.label,
        }
      : undefined;
    let scenarios: ImportedScenario[] | undefined;
    if (payload.scenarioSource.kind === "SAVED") {
      const saved = collectionScenarios(await deps.store.listArtifacts(job.projectId), payload.scenarioSource.resourceId);
      scenarios = saved.map((artifact) => {
        const definition = restoreScenarioDefinition(artifact.content);
        return { name: definition.name, description: definition.description, steps: definition.steps };
      });
    }
    return {
      job,
      repository: resource.externalReference,
      commitSha: payload.commitSha,
      ...(payload.root === undefined ? {} : { root: payload.root }),
      ...(payload.stripPathPrefix ? { stripPathPrefix: payload.stripPathPrefix } : {}),
      ...(scenarios ? { scenarios } : {}),
      ...(counterpart ? { counterpart } : {}),
    };
  } catch (error) {
    // The record job only sees runs that reached the environment job, so a prepare failure is
    // recorded here: NOT_PROVEN evidence for the task, and a FAILED job with the reason.
    const message = `prepare failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000);
    await persistEvidence(deps, job, syntheticEvidence("INFRASTRUCTURE_UNAVAILABLE", "prepare", message, deps.clock.now()));
    await failRunningJob(deps, job, input.owner, "INFRASTRUCTURE_UNAVAILABLE", message);
    throw error;
  }
}

function syntheticEvidence(failureClass: FailureClass, step: string, message: string, now: string): EnvironmentEvidence {
  return environmentEvidenceSchema.parse({
    evidenceVersion: ENVIRONMENT_EVIDENCE_VERSION,
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    plan: null,
    outcome: { verdict: "NOT_PROVEN", failure: { class: failureClass, step, message }, reasons: [`${failureClass} at ${step}: ${message}`] },
    steps: [],
    scenarioReports: [],
  });
}

async function persistEvidence(
  deps: HttpE2eDependencies & { artifacts: ArtifactWriter },
  job: ExecutionJob,
  evidence: EnvironmentEvidence,
): Promise<string> {
  const payload = httpE2ePayloadSchema.safeParse(job.payload);
  const resource = await deps.store.getResource(job.resourceId);
  const diagnosis = diagnoseHttpE2e(evidence);
  const artifact = await deps.artifacts.write(
    job.projectId,
    "VALIDATION_REPORT",
    {
      suite: "HTTP_E2E",
      operationId: `${job.operationId}#evidence`,
      jobId: job.id,
      taskId: job.taskId,
      projectId: job.projectId,
      repository: resource?.externalReference,
      commitSha: payload.success ? payload.data.commitSha : job.baseCommitSha,
      ...(job.workflowRunUrl ? { workflowRunUrl: job.workflowRunUrl } : {}),
      // `result` keeps the VALIDATION_REPORT shape the Console reads; PASS only for PROVEN.
      result: evidence.outcome.verdict === "PROVEN" ? "PASS" : "FAIL",
      verdict: evidence.outcome.verdict,
      ...(evidence.outcome.failure ? { failure: evidence.outcome.failure } : {}),
      reasons: evidence.outcome.reasons,
      ...(diagnosis ? { diagnosis } : {}),
      evidence,
    },
    job.taskId,
  );
  return artifact.id;
}

async function failRunningJob(deps: HttpE2eDependencies, job: ExecutionJob, owner: string, failureClass: FailureClass, message: string): Promise<ExecutionJob> {
  const updated = await deps.store.updateExecutionJob({
    ...job,
    status: "FAILED",
    leaseOwner: owner,
    leaseExpiresAt: deps.clock.now(),
    finishedAt: deps.clock.now(),
    updatedAt: deps.clock.now(),
    error: { code: failureClass, message: message.slice(0, 2000) },
  });
  await new AuditLog(deps.store, deps.ids, deps.clock).record({ actor: owner, action: "http_e2e.job.failed", projectId: job.projectId, taskId: job.taskId, resourceId: job.resourceId, input: { jobId: job.id }, result: { failureClass }, reason: message.slice(0, 500), correlationId: job.operationId });
  return updated;
}

/**
 * Accepts the environment job's evidence for a job this workflow run holds, validates it, binds it
 * to the commit and closes the job. A run that does not hold the lease cannot record anything.
 */
export async function recordHttpE2eEvidence(
  deps: HttpE2eDependencies & { artifacts: ArtifactWriter },
  input: { jobId: string; owner: string; evidenceText?: string; evidenceOversized?: boolean },
): Promise<{ job: ExecutionJob; artifactId: string; verdict: "PROVEN" | "NOT_PROVEN"; accepted: boolean }> {
  const job = await deps.store.getExecutionJobById(input.jobId);
  if (!job) throw new NotFound("Execution job not found", { jobId: input.jobId });
  if (job.kind !== "HTTP_E2E") throw new PolicyViolation("Only HTTP_E2E evidence is recorded here", { kind: job.kind });
  if (job.status !== "RUNNING") throw new InvalidState("HTTP E2E job is not running; nothing to record", { status: job.status });
  if (job.leaseOwner !== input.owner) throw new PolicyViolation("This workflow run does not hold the job's lease", { jobId: job.id });

  let evidence: EnvironmentEvidence;
  let accepted = false;
  if (input.evidenceOversized || (input.evidenceText !== undefined && input.evidenceText.length > MAX_EVIDENCE_BYTES))
    evidence = syntheticEvidence("INFRASTRUCTURE_UNAVAILABLE", "environment", `the evidence file exceeds ${MAX_EVIDENCE_BYTES} bytes and was refused`, deps.clock.now());
  else if (input.evidenceText === undefined) evidence = syntheticEvidence("INFRASTRUCTURE_UNAVAILABLE", "environment", "the environment job produced no evidence file", deps.clock.now());
  else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.evidenceText);
    } catch {
      parsed = undefined;
    }
    const validated = environmentEvidenceSchema.safeParse(parsed);
    if (validated.success) {
      evidence = validated.data;
      accepted = true;
    } else
      evidence = syntheticEvidence(
        "INFRASTRUCTURE_UNAVAILABLE",
        "environment",
        `the evidence file is not valid environment evidence: ${validated.error?.issues[0]?.path.join(".") ?? "unparseable JSON"}`,
        deps.clock.now(),
      );
  }
  const artifactId = await persistEvidence(deps, job, evidence);
  const verdict = evidence.outcome.verdict;
  const finished = await deps.store.updateExecutionJob({
    ...job,
    // SUCCEEDED means the verification ran to a verdict; the verdict itself is in `result`.
    status: accepted ? "SUCCEEDED" : "FAILED",
    leaseExpiresAt: deps.clock.now(),
    finishedAt: deps.clock.now(),
    updatedAt: deps.clock.now(),
    result: { verdict, ...(evidence.outcome.failure ? { failureClass: evidence.outcome.failure.class } : {}), evidenceArtifactId: artifactId },
    ...(accepted ? {} : { error: { code: "INFRASTRUCTURE_UNAVAILABLE", message: evidence.outcome.failure?.message ?? "invalid evidence" } }),
  });
  await new AuditLog(deps.store, deps.ids, deps.clock).record({
    actor: input.owner,
    action: "http_e2e.evidence.recorded",
    projectId: job.projectId,
    taskId: job.taskId,
    resourceId: job.resourceId,
    input: { jobId: job.id },
    result: { verdict, accepted, artifactId, ...(evidence.outcome.failure ? { failureClass: evidence.outcome.failure.class } : {}) },
    reason: "Environment evidence recorded against the verified commit",
    correlationId: job.operationId,
  });
  return { job: finished, artifactId, verdict, accepted };
}

/** The job plus its recorded evidence summary, for the read tool. */
export async function readHttpE2eJob(store: StateStore, projectId: string, jobId: string) {
  const job = await store.getExecutionJob(projectId, jobId);
  if (!job || job.kind !== "HTTP_E2E") throw new NotFound("HTTP E2E job not found", { jobId });
  const report = (await store.listArtifacts(projectId, job.taskId)).find(
    (artifact) => artifact.kind === "VALIDATION_REPORT" && (artifact.content as { jobId?: string } | undefined)?.jobId === job.id,
  );
  const content = report?.content as
    | {
        verdict?: string;
        failure?: unknown;
        reasons?: string[];
        diagnosis?: unknown;
        commitSha?: string;
        evidence?: {
          collection?: { coverage?: unknown; summary?: unknown };
          steps?: unknown;
          counterpart?: { label?: string; outcome?: unknown; steps?: unknown };
          parity?: { verdict?: string; comparedSteps?: number; matchedSteps?: number; uncomparedSteps?: number; differenceCount?: number; differences?: unknown[] };
        };
      }
    | undefined;
  return {
    job: { id: job.id, status: job.status, commitSha: job.baseCommitSha, workflowRunUrl: job.workflowRunUrl, queuedAt: job.queuedAt, finishedAt: job.finishedAt, result: job.result, error: job.error },
    ...(report
      ? {
          evidence: {
            artifactId: report.id,
            verdict: content?.verdict,
            failure: content?.failure,
            reasons: content?.reasons,
            ...(content?.diagnosis ? { diagnosis: content.diagnosis } : {}),
            commitSha: content?.commitSha,
            steps: content?.evidence?.steps,
            summary: content?.evidence?.collection?.summary,
            coverage: content?.evidence?.collection?.coverage,
            ...(content?.evidence?.counterpart ? { counterpart: { label: content.evidence.counterpart.label, outcome: content.evidence.counterpart.outcome, steps: content.evidence.counterpart.steps } } : {}),
            ...(content?.evidence?.parity
              ? { parity: { ...content.evidence.parity, differences: (content.evidence.parity.differences ?? []).slice(0, 100) } }
              : {}),
          },
        }
      : {}),
  };
}

export const httpE2eRunToolName = "superadmin_http_e2e_run";
export const httpE2eRunToolDescription =
  "Run full HTTP end-to-end verification of a registered GitHub repository at one exact commit in a throwaway environment: the autopilot builds the project, starts its dependencies (PostgreSQL, MySQL, Redis, MongoDB) and the application in GitHub Actions containers, runs the whole collection (the repository's Postman collections, or scenarios saved for an HTTP_API resource) against every contract in the repository, records classified evidence bound to the commit, and destroys the environment. No test server or URL is needed. With counterpart, a reference implementation (for example the original service a port replaces) runs the same scenarios and every response is compared step by step; PROVEN then also requires zero differences. Returns the job; read the verdict with superadmin_http_e2e_get.";
export const httpE2eRunToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
export const httpE2eRunToolInputSchema = {
  operationId: z.string().min(8).max(200),
  projectId: z.string().uuid(),
  taskId: z.string().uuid(),
  repositoryResourceId: z.string().uuid(),
  ref: z.string().min(1).max(255).optional().describe("Branch, tag or exact commit SHA; the default branch when omitted"),
  root: root.optional().describe("The application directory, for a repository that holds several"),
  stripPathPrefix: pathPrefix.optional().describe("Path prefix to remove from collection request paths"),
  scenarioSource: httpE2eScenarioSourceSchema.default({ kind: "REPOSITORY" }),
  counterpart: z
    .object({
      repositoryResourceId: z.string().uuid(),
      ref: z.string().min(1).max(255).optional(),
      root: root.optional(),
      label: label.optional(),
    })
    .optional()
    .describe("Parity: a reference implementation (e.g. the original Kotlin service) run on the same scenarios in its own fresh environment; every response is compared and any difference keeps the verdict NOT_PROVEN"),
};
export const httpE2eGetToolName = "superadmin_http_e2e_get";
export const httpE2eGetToolDescription =
  "Read-only: the status of an HTTP_E2E verification job and, once recorded, its verdict (PROVEN or NOT_PROVEN), the classified failure (BUILD_FAILED, DEPENDENCY_UNAVAILABLE, ENVIRONMENT_BOOT_FAILED, HEALTH_CHECK_FAILED, SCENARIO_FAILED, COVERAGE_INCOMPLETE, ...), the steps, the coverage against every contract, and a diagnosis: the area to change (IMPLEMENTATION, SCENARIOS, ENVIRONMENT_MANIFEST, CONTRACT, INFRASTRUCTURE, REFERENCE), the findings from the logs and scenarios that point there, and the next steps.";
export const httpE2eGetToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
export const httpE2eGetToolInputSchema = { projectId: z.string().uuid(), jobId: z.string().uuid() };
