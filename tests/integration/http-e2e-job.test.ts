import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../../packages/artifact-store/src/index.js";
import type { ExecutionJobDispatcher } from "../../packages/core/src/async-execution.js";
import { systemClock, uuidGenerator } from "../../packages/core/src/ports.js";
import { createService } from "../../packages/core/src/runtime.js";
import { ENVIRONMENT_EVIDENCE_VERSION } from "../../packages/ephemeral-environment/src/evidence.js";
import { enqueueVerificationOfReviewedCommit, prepareHttpE2eJob, recordHttpE2eEvidence } from "../../packages/ephemeral-environment/src/http-e2e-job.js";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";
import type { ExecutionJob, Resource } from "../../packages/schemas/src/index.js";
import { SuperadminService } from "../../packages/superadmin/src/index.js";
import { FakeRepositoryProvider } from "../helpers/repository-provider.js";

const principal = { actor: "superadmin-test", role: "SUPERADMIN" as const };
const head = "1".repeat(40);
const javaPort = "2".repeat(40);
const owner = "github-actions:4242:1";
const kotlinHead = "3".repeat(40);

let counter = 0;
const operationId = () => `http-e2e-${++counter}-${Date.now()}`;

async function setup(options: { autonomy?: "AUTONOMOUS_STAGING" | "GUARDED"; dispatcher?: ExecutionJobDispatcher | null } = {}) {
  const store = new MemoryStateStore();
  const service = createService({ store });
  const system = await service.projectCreate({ name: "System", slug: "system", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const project = await service.projectCreate({ name: "Product", slug: "product", sourceType: "TEST", environment: "SANDBOX", autonomyMode: options.autonomy ?? "AUTONOMOUS_STAGING", workspacePath: "" });
  const other = await service.projectCreate({ name: "Other", slug: "other", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  // GITHUB_REPOSITORY resources come from the verified provider registration flow; seeded here.
  const register = (projectId: string, reference: string, overrides: Partial<Resource> = {}) =>
    store.createResource({ resourceId: crypto.randomUUID(), type: "GITHUB_REPOSITORY", provider: "github", externalReference: reference, projectId, environment: "SANDBOX", permissions: ["READ"], status: "ACTIVE", secretRefs: [], createdAt: new Date().toISOString(), ...overrides });
  const repository = await register(project.id, "acme/backend");
  const foreign = await register(other.id, "acme/foreign");
  const kotlin = await register(project.id, "acme/backend-kotlin");
  const writeOnly = await register(project.id, "acme/write-only", { permissions: ["WRITE"] });
  const repositories = new FakeRepositoryProvider({
    "acme/backend": { defaultBranch: "main", head, commits: [head, javaPort], branches: [{ name: "java-port", sha: javaPort }] },
    "acme/foreign": { defaultBranch: "main", head, commits: [head] },
    "acme/backend-kotlin": { defaultBranch: "main", head: kotlinHead, commits: [kotlinHead] },
    "acme/write-only": { defaultBranch: "main", head, commits: [head] },
  });
  const dispatched: ExecutionJob[] = [];
  const dispatcher: ExecutionJobDispatcher = options.dispatcher === null ? (undefined as never) : options.dispatcher ?? { dispatch: async (job) => (dispatched.push(job), {}) };
  const admin = new SuperadminService({ store, service, systemProjectId: system.id, repositories, ...(options.dispatcher === null ? {} : { httpE2eDispatcher: dispatcher }) });
  const task = await service.taskCreate({ projectId: project.id, externalKey: "VERIFY-1", title: "Verify the Java port end to end", description: "Run the full collection", requirements: ["full HTTP verification"], relationships: [] });
  const http = await service.resourceRegister({ projectId: project.id, type: "HTTP_API", provider: "http-e2e", externalReference: "http://127.0.0.1:18080", environment: "LOCAL", permissions: ["READ"], secretRefs: [] });
  const artifacts = new ArtifactStore(store, uuidGenerator, systemClock);
  return { store, service, admin, project, other, repository, foreign, kotlin, writeOnly, task, http, dispatched, artifacts };
}

async function run(context: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown> = {}) {
  return (await context.admin.httpE2eRun(principal, context.project.id, {
    taskId: context.task.id,
    repositoryResourceId: context.repository.resourceId,
    scenarioSource: { kind: "REPOSITORY" },
    operationId: operationId(),
    ...extra,
  })) as { value: ExecutionJob; idempotentReplay: boolean };
}

function evidence(verdict: "PROVEN" | "NOT_PROVEN") {
  return JSON.stringify({
    evidenceVersion: ENVIRONMENT_EVIDENCE_VERSION,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 1234,
    plan: { stack: { language: "JAVA" } },
    outcome: verdict === "PROVEN" ? { verdict, reasons: [] } : { verdict, failure: { class: "BUILD_FAILED", step: "build: ./gradlew assemble", message: "exited with 1" }, reasons: ["BUILD_FAILED at build"] },
    steps: [{ phase: "build", name: "./gradlew assemble", status: verdict === "PROVEN" ? "PASSED" : "FAILED", durationMs: 1000 }],
    collection: { summary: { scenarios: 2 }, coverage: { coveredOperations: 5, totalOperations: 5 } },
    scenarioReports: [],
  });
}

describe("HTTP_E2E job enqueue", () => {
  it("pins the default branch commit, dispatches the job and replays by operationId", async () => {
    const context = await setup();
    const replayId = operationId();
    const first = await run(context, { operationId: replayId });
    expect(first.value).toMatchObject({ kind: "HTTP_E2E", status: "DISPATCHED", baseCommitSha: head, resourceId: context.repository.resourceId, payload: { commitSha: head, scenarioSource: { kind: "REPOSITORY" } } });
    expect(context.dispatched.map((job) => job.id)).toEqual([first.value.id]);
    const again = await run(context, { operationId: replayId });
    expect(again.idempotentReplay).toBe(true);
    expect(context.dispatched).toHaveLength(1);
    const audit = (await context.store.listAudit(context.project.id)).map((event) => event.action);
    expect(audit).toEqual(expect.arrayContaining(["http_e2e.job.dispatched", "mcp.http_e2e_run"]));
  });

  it("pins a named branch or exact SHA, and refuses an unknown ref and a second active job", async () => {
    const context = await setup();
    const branch = await run(context, { ref: "java-port" });
    expect(branch.value.baseCommitSha).toBe(javaPort);
    await expect(run(context, { ref: head })).rejects.toMatchObject({ code: "CONFLICT" });
    const fresh = await setup();
    await expect(run(fresh, { ref: "no-such-branch" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(run(fresh, { ref: "9".repeat(40) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await run(fresh, { ref: head })).value.baseCommitSha).toBe(head);
  });

  it("refuses without AUTONOMOUS_STAGING, for a foreign or non-repository resource, and foreign saved scenarios", async () => {
    await expect(run(await setup({ autonomy: "GUARDED" }))).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    const context = await setup();
    await expect(run(context, { repositoryResourceId: context.foreign.resourceId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(run(context, { repositoryResourceId: context.http.resourceId })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await expect(run(context, { scenarioSource: { kind: "SAVED", resourceId: context.repository.resourceId } })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await expect(context.admin.httpE2eRun({ actor: "operator", role: "PROJECT_OPERATOR" }, context.project.id, { taskId: context.task.id, repositoryResourceId: context.repository.resourceId, scenarioSource: { kind: "REPOSITORY" }, operationId: operationId() })).rejects.toThrow();
    expect(context.dispatched).toEqual([]);
  });

  it("reports a missing or failing dispatcher instead of a job that never runs", async () => {
    await expect(run(await setup({ dispatcher: null }))).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    const failing = await setup({ dispatcher: { dispatch: async () => Promise.reject(new Error("workflow not found")) } });
    await expect(run(failing)).rejects.toMatchObject({ code: "EXECUTION_FAILED" });
    const [job] = await failing.store.listExecutionJobs(failing.project.id);
    expect(job).toMatchObject({ status: "FAILED", error: { code: "DISPATCH_FAILED" } });
  });
});

describe("HTTP_E2E prepare and record", () => {
  it("claims the job for one run and hands over repository, commit and saved scenarios", async () => {
    const context = await setup();
    await context.admin.scenarioCreate(principal, context.project.id, { resourceId: context.http.resourceId, name: "Smoke", description: "", steps: [{ name: "health", method: "GET", path: "/health", expectedStatus: 200 }], operationId: operationId() }, operationId());
    const { value: job } = await run(context, { scenarioSource: { kind: "SAVED", resourceId: context.http.resourceId }, root: "java" });
    const prepared = await prepareHttpE2eJob({ store: context.store, clock: systemClock, ids: uuidGenerator, artifacts: context.artifacts }, { jobId: job.id, owner, workflowRunId: "4242" });
    expect(prepared).toMatchObject({ repository: "acme/backend", commitSha: head, root: "java" });
    expect(prepared.scenarios?.map((value) => value.name)).toEqual(["Smoke"]);
    expect(prepared.job).toMatchObject({ status: "RUNNING", leaseOwner: owner, workflowRunId: "4242" });
    await expect(prepareHttpE2eJob({ store: context.store, clock: systemClock, ids: uuidGenerator, artifacts: context.artifacts }, { jobId: job.id, owner: "github-actions:9999:1" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses to claim a job of another kind", async () => {
    const context = await setup();
    const now = systemClock.now();
    const other = await context.store.createExecutionJob({ id: crypto.randomUUID(), projectId: context.project.id, taskId: context.task.id, resourceId: context.repository.resourceId, operationId: operationId(), kind: "IMPLEMENTATION", status: "DISPATCHED", payload: {}, attempt: 0, queuedAt: now, updatedAt: now });
    await expect(prepareHttpE2eJob({ store: context.store, clock: systemClock, ids: uuidGenerator, artifacts: context.artifacts }, { jobId: other.id, owner })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect((await context.store.getExecutionJobById(other.id))?.status).toBe("DISPATCHED");
  });

  it("records a prepare failure as NOT_PROVEN evidence and a FAILED job", async () => {
    const context = await setup();
    const { value: job } = await run(context);
    await context.store.updateResource({ ...context.repository, status: "DISABLED" });
    await expect(prepareHttpE2eJob({ store: context.store, clock: systemClock, ids: uuidGenerator, artifacts: context.artifacts }, { jobId: job.id, owner })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    const read = await context.admin.httpE2eGet(principal, context.project.id, job.id);
    expect(read.job.status).toBe("FAILED");
    expect(read.evidence).toMatchObject({ verdict: "NOT_PROVEN", failure: { class: "INFRASTRUCTURE_UNAVAILABLE", step: "prepare" } });
  });

  it("records valid evidence against the commit, and only from the run holding the lease", async () => {
    const context = await setup();
    const { value: job } = await run(context);
    await prepareHttpE2eJob({ store: context.store, clock: systemClock, ids: uuidGenerator, artifacts: context.artifacts }, { jobId: job.id, owner });
    const deps = { store: context.store, clock: systemClock, ids: uuidGenerator, artifacts: context.artifacts };
    await expect(recordHttpE2eEvidence(deps, { jobId: job.id, owner: "github-actions:1:1", evidenceText: evidence("PROVEN") })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    const recorded = await recordHttpE2eEvidence(deps, { jobId: job.id, owner, evidenceText: evidence("PROVEN") });
    expect(recorded).toMatchObject({ verdict: "PROVEN", accepted: true, job: { status: "SUCCEEDED", result: { verdict: "PROVEN" } } });
    const report = (await context.store.listArtifacts(context.project.id, context.task.id)).find((artifact) => artifact.id === recorded.artifactId);
    expect(report?.content).toMatchObject({ suite: "HTTP_E2E", result: "PASS", verdict: "PROVEN", commitSha: head, repository: "acme/backend", jobId: job.id });
    const read = await context.admin.httpE2eGet(principal, context.project.id, job.id);
    expect(read.evidence).toMatchObject({ verdict: "PROVEN", commitSha: head, coverage: { coveredOperations: 5, totalOperations: 5 } });
    await expect(recordHttpE2eEvidence(deps, { jobId: job.id, owner, evidenceText: evidence("PROVEN") })).rejects.toMatchObject({ code: "INVALID_STATE" });
    const audit = (await context.store.listAudit(context.project.id)).map((event) => event.action);
    expect(audit).toContain("http_e2e.evidence.recorded");
  });

  it("keeps a classified project failure as NOT_PROVEN with the job SUCCEEDED", async () => {
    const context = await setup();
    const { value: job } = await run(context);
    await prepareHttpE2eJob({ store: context.store, clock: systemClock, ids: uuidGenerator, artifacts: context.artifacts }, { jobId: job.id, owner });
    const recorded = await recordHttpE2eEvidence({ store: context.store, clock: systemClock, ids: uuidGenerator, artifacts: context.artifacts }, { jobId: job.id, owner, evidenceText: evidence("NOT_PROVEN") });
    expect(recorded).toMatchObject({ verdict: "NOT_PROVEN", accepted: true, job: { status: "SUCCEEDED", result: { failureClass: "BUILD_FAILED" } } });
  });

  it("turns missing, malformed, forged or oversized evidence into NOT_PROVEN, never a pass", async () => {
    const forged = JSON.stringify({ outcome: { verdict: "PROVEN" } });
    for (const input of [{}, { evidenceText: "{not json" }, { evidenceText: forged }, { evidenceOversized: true }]) {
      const context = await setup();
      const { value: job } = await run(context);
      await prepareHttpE2eJob({ store: context.store, clock: systemClock, ids: uuidGenerator, artifacts: context.artifacts }, { jobId: job.id, owner });
      const recorded = await recordHttpE2eEvidence({ store: context.store, clock: systemClock, ids: uuidGenerator, artifacts: context.artifacts }, { jobId: job.id, owner, ...input });
      expect(recorded, JSON.stringify(input)).toMatchObject({ verdict: "NOT_PROVEN", accepted: false, job: { status: "FAILED", result: { failureClass: "INFRASTRUCTURE_UNAVAILABLE" } } });
      const report = (await context.store.listArtifacts(context.project.id, context.task.id)).find((artifact) => artifact.id === recorded.artifactId);
      expect(report?.content).toMatchObject({ result: "FAIL", verdict: "NOT_PROVEN" });
    }
  });

  it("does not expose another project's job", async () => {
    const context = await setup();
    const { value: job } = await run(context);
    await expect(context.admin.httpE2eGet(principal, context.other.id, job.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("HTTP_E2E parity jobs", () => {
  it("pins and authorizes the reference implementation and hands it to the environment", async () => {
    const context = await setup();
    const { value: job } = await run(context, { ref: "java-port", counterpart: { repositoryResourceId: context.kotlin.resourceId, label: "kotlin" } });
    expect(job.payload).toMatchObject({ commitSha: javaPort, counterpart: { repositoryResourceId: context.kotlin.resourceId, commitSha: kotlinHead, label: "kotlin" } });
    const prepared = await prepareHttpE2eJob({ store: context.store, clock: systemClock, ids: uuidGenerator, artifacts: context.artifacts }, { jobId: job.id, owner });
    expect(prepared.counterpart).toEqual({ repository: "acme/backend-kotlin", commitSha: kotlinHead, label: "kotlin" });
  });

  it("refuses a reference that is foreign, unreadable or at an unknown ref", async () => {
    const context = await setup();
    await expect(run(context, { counterpart: { repositoryResourceId: context.foreign.resourceId } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(run(context, { counterpart: { repositoryResourceId: context.writeOnly.resourceId } })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await expect(run(context, { counterpart: { repositoryResourceId: context.kotlin.resourceId, ref: "missing" } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(context.dispatched).toEqual([]);
  });
});

describe("HTTP_E2E diagnosis and automatic verification", () => {
  it("records a diagnosis with every NOT_PROVEN verdict and returns it", async () => {
    const context = await setup();
    const { value: job } = await run(context);
    await prepareHttpE2eJob({ store: context.store, clock: systemClock, ids: uuidGenerator, artifacts: context.artifacts }, { jobId: job.id, owner });
    await recordHttpE2eEvidence({ store: context.store, clock: systemClock, ids: uuidGenerator, artifacts: context.artifacts }, { jobId: job.id, owner, evidenceText: evidence("NOT_PROVEN") });
    const read = await context.admin.httpE2eGet(principal, context.project.id, job.id);
    expect(read.evidence?.diagnosis).toMatchObject({ failureClass: "BUILD_FAILED", area: "IMPLEMENTATION" });
  });

  it("starts verification only for a task resting in VERIFYING, once per commit", async () => {
    const context = await setup();
    const deps = { store: context.store, clock: systemClock, ids: uuidGenerator, dispatcher: { dispatch: async (job: ExecutionJob) => (context.dispatched.push(job), {}) }, repositories: new FakeRepositoryProvider({ "acme/backend": { defaultBranch: "main", head, commits: [head] } }) };
    const input = { projectId: context.project.id, taskId: context.task.id, repositoryResourceId: context.repository.resourceId, commitSha: head, actor: owner };
    expect(await enqueueVerificationOfReviewedCommit(deps, input)).toBeUndefined();
    await context.store.updateTask({ ...(await context.store.getTask(context.project.id, context.task.id))!, state: "VERIFYING" });
    const first = await enqueueVerificationOfReviewedCommit(deps, input);
    expect(first).toMatchObject({ kind: "HTTP_E2E", baseCommitSha: head, operationId: `auto-http-e2e:${context.task.id}:${head}` });
    const again = await enqueueVerificationOfReviewedCommit(deps, input);
    expect(again?.id).toBe(first?.id);
    expect(context.dispatched).toHaveLength(1);
    expect(await enqueueVerificationOfReviewedCommit(deps, { ...input, commitSha: "not-a-sha" })).toBeUndefined();
  });
});
