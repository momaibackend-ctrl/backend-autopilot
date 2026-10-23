import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../../packages/artifact-store/src/index.js";
import { systemClock, uuidGenerator, type ArtifactBlobStore } from "../../packages/core/src/ports.js";
import { createService } from "../../packages/core/src/runtime.js";
import { latestHttpE2eEvidence } from "../../packages/core/src/task-readiness.js";
import { ENVIRONMENT_EVIDENCE_VERSION } from "../../packages/ephemeral-environment/src/evidence.js";
import { prepareHttpE2eJob, readHttpE2eJob, recordHttpE2eEvidence } from "../../packages/ephemeral-environment/src/http-e2e-job.js";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";
import type { Resource } from "../../packages/schemas/src/index.js";
import { SuperadminService } from "../../packages/superadmin/src/index.js";
import { FakeRepositoryProvider } from "../helpers/repository-provider.js";

const principal = { actor: "superadmin-test", role: "SUPERADMIN" as const };
const head = "1".repeat(40);
const owner = "github-actions:5151:1";

class MemoryBlobs implements ArtifactBlobStore {
  readonly bodies = new Map<string, string>();
  async put(input: { projectId: string; artifactId: string; body: string; contentType: string }) {
    const path = `${input.projectId}/${input.artifactId}.json`;
    this.bodies.set(path, input.body);
    return { provider: "memory", bucket: "test", path, contentType: input.contentType, size: input.body.length };
  }
  async get(reference: { path: string }) {
    return this.bodies.get(reference.path)!;
  }
}

// A real run: 45 operations, scenario reports and logs well past the 64 kB externalization line.
function largeEvidence(verdict: "PROVEN" | "NOT_PROVEN") {
  const log = "x".repeat(20_000);
  return JSON.stringify({
    evidenceVersion: ENVIRONMENT_EVIDENCE_VERSION,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 90_000,
    plan: { stack: { language: "JAVA" } },
    outcome: verdict === "PROVEN" ? { verdict, reasons: [] } : { verdict, failure: { class: "SCENARIO_FAILED", step: "collection", message: "3 of 45 scenario(s) did not pass" }, reasons: ["SCENARIO_FAILED at collection"] },
    steps: [{ phase: "build", name: "sh ./gradlew build", status: "PASSED", durationMs: 60_000, logTail: log }],
    applicationLogTail: log,
    collection: { summary: { scenarios: 45 }, coverage: { status: "COMPLETE", coveredOperations: 45, totalOperations: 45 } },
    scenarioReports: Array.from({ length: 45 }, (_, index) => ({ scenario: `S${index}`, body: "y".repeat(2_000) })),
  });
}

async function setup() {
  const store = new MemoryStateStore();
  const service = createService({ store });
  const system = await service.projectCreate({ name: "System", slug: "system", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const project = await service.projectCreate({ name: "Product", slug: "product", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const repository = await store.createResource({ resourceId: crypto.randomUUID(), type: "GITHUB_REPOSITORY", provider: "github", externalReference: "acme/backend", projectId: project.id, environment: "SANDBOX", permissions: ["READ"], status: "ACTIVE", secretRefs: [], createdAt: new Date().toISOString() } as Resource);
  const blobs = new MemoryBlobs();
  const admin = new SuperadminService({ store, service, systemProjectId: system.id, artifactBlobs: blobs, repositories: new FakeRepositoryProvider({ "acme/backend": { head, commits: [head] } }), httpE2eDispatcher: { dispatch: async () => ({}) } });
  const task = await service.taskCreate({ projectId: project.id, externalKey: "BIG-1", title: "Verify", description: "d", requirements: ["full HTTP verification"], relationships: [] });
  const artifacts = new ArtifactStore(store, uuidGenerator, systemClock, blobs);
  const job = ((await admin.httpE2eRun(principal, project.id, { taskId: task.id, repositoryResourceId: repository.resourceId, scenarioSource: { kind: "REPOSITORY" }, operationId: `big-${crypto.randomUUID()}` })) as { value: { id: string } }).value;
  await prepareHttpE2eJob({ store, clock: systemClock, ids: uuidGenerator, artifacts }, { jobId: job.id, owner });
  return { store, admin, project, task, job, artifacts, blobs };
}

describe("an HTTP E2E report larger than the externalization threshold", () => {
  it("keeps verdict, cause, diagnosis and coverage inline, and the complete evidence one read away", async () => {
    const { store, admin, project, task, job, artifacts, blobs } = await setup();
    const recorded = await recordHttpE2eEvidence({ store, clock: systemClock, ids: uuidGenerator, artifacts }, { jobId: job.id, owner, evidenceText: largeEvidence("NOT_PROVEN") });
    expect(recorded).toMatchObject({ verdict: "NOT_PROVEN", accepted: true });

    const report = await store.getArtifact(project.id, recorded.artifactId);
    expect(report?.storage).toBeUndefined();
    expect(JSON.stringify(report?.content).length).toBeLessThan(64 * 1024);
    expect(report?.content).toMatchObject({ suite: "HTTP_E2E", jobId: job.id, commitSha: head, verdict: "NOT_PROVEN", failure: { class: "SCENARIO_FAILED" }, diagnosis: { fingerprint: expect.any(String) } });

    const fullId = (report?.content as { fullEvidenceArtifactId: string }).fullEvidenceArtifactId;
    const full = await store.getArtifact(project.id, fullId);
    expect(full).toMatchObject({ kind: "ENVIRONMENT_EVIDENCE", storage: expect.any(Object) });
    expect(blobs.bodies.size).toBe(1);
    expect(((await artifacts.read(project.id, fullId)).content as { evidence: { scenarioReports: unknown[] } }).evidence.scenarioReports).toHaveLength(45);

    // What the agent reads: the verdict, its cause, the coverage and the diagnosis.
    const read = await admin.httpE2eGet(principal, project.id, job.id);
    expect(read.evidence).toMatchObject({ verdict: "NOT_PROVEN", failure: { class: "SCENARIO_FAILED" }, coverage: { coveredOperations: 45, totalOperations: 45 }, diagnosis: expect.any(Object) });
    expect((read.evidence?.steps as Array<{ logTail: string }>)[0]!.logTail.length).toBeLessThanOrEqual(2_001);

    // What the READY gate reads.
    expect(latestHttpE2eEvidence(await store.listArtifacts(project.id, task.id), head)).toMatchObject({ verdict: "NOT_PROVEN", failureClass: "SCENARIO_FAILED" });
  });

  it("still reads an older report that was externalized whole, and never invents a verdict without it", async () => {
    const { store, admin, project, job, artifacts } = await setup();
    // A report written before the digest existed: the whole content went to blob storage.
    const legacy = await artifacts.write(project.id, "VALIDATION_REPORT", { suite: "HTTP_E2E", jobId: job.id, commitSha: head, verdict: "PROVEN", evidence: JSON.parse(largeEvidence("PROVEN")) }, (await store.getExecutionJob(project.id, job.id))!.taskId);
    expect(legacy.content).toEqual({ externalized: true });
    const running = (await store.getExecutionJob(project.id, job.id))!;
    await store.updateExecutionJob({ ...running, status: "SUCCEEDED", result: { verdict: "PROVEN", evidenceArtifactId: legacy.id } });

    expect((await readHttpE2eJob(store, project.id, job.id)).evidence?.verdict).toBeUndefined();
    expect((await admin.httpE2eGet(principal, project.id, job.id)).evidence).toMatchObject({ verdict: "PROVEN", coverage: { totalOperations: 45 } });
  });
});
