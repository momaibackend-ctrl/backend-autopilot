import { describe, expect, it } from "vitest";
import type { ImplementationPlan } from "../../packages/schemas/src/index.js";
import { changeProof } from "../../packages/superadmin/src/proof.js";
import { testService } from "../helpers/service.js";

const commit = "a".repeat(40);
const older = "b".repeat(40);

// A task that went through every gate, recorded the way the execution runner records it.
async function verifiedTask(tests: { passed: boolean; failedTests?: Array<{ test: string; message?: string }> } = { passed: true }) {
  const { store, service } = testService();
  const project = await service.projectCreate({ name: "Proof", slug: `proof-${crypto.randomUUID()}`, sourceType: "LOCAL", environment: "SANDBOX", autonomyMode: "GUARDED" });
  const resource = await service.resourceRegister({ projectId: project.id, type: "GITHUB_REPOSITORY", provider: "github", externalReference: "acme/backend", environment: "SANDBOX", permissions: ["READ", "WRITE"], secretRefs: [] });
  const task = await service.taskCreate({ projectId: project.id, externalKey: "PROOF-1", title: "Full end-to-end verification of the service", description: "Verify the service end to end", requirements: ["full end-to-end verification of the service"], relationships: [] });
  await service.taskAnalyze(project.id, task.id);
  await service.taskPlan(project.id, task.id);
  const plan = (await store.listArtifacts(project.id, task.id)).find((artifact) => artifact.kind === "IMPLEMENTATION_PLAN")?.content as ImplementationPlan;
  await store.updateTask({ ...(await store.getTask(project.id, task.id))!, state: "REVIEWING" });
  const now = new Date().toISOString();
  const save = (kind: string, content: unknown) =>
    store.saveArtifact({ id: crypto.randomUUID(), projectId: project.id, taskId: task.id, kind, schemaVersion: "1", content, contentHash: "hash", status: "AVAILABLE", createdAt: new Date(Date.now() + Math.random()).toISOString() } as never);
  await save("CODE_DIFF", { diff: 'diff --git a/src/x.ts b/src/x.ts\n+ log.info("x.handled")', changedFiles: ["src/x.ts"] });
  await save("TEST_REPORT", { passed: tests.passed, suites: plan.testsRequired.map((type) => ({ type, command: ["gradlew", "test"], passed: tests.passed, exitCode: tests.passed ? 0 : 1 })), testTotals: { tests: 476, failures: tests.passed ? 0 : 1, skipped: 9 }, ...(tests.failedTests ? { failedTests: tests.failedTests } : {}), finishedAt: now });
  await save("SECURITY_REPORT", { passed: true });
  await save("CI_REPORT", { expectedSha: commit, ci: { success: true, headSha: commit } });
  await store.saveRun({ id: crypto.randomUUID(), projectId: project.id, taskId: task.id, operationId: `run-${crypto.randomUUID()}`, status: "SUCCEEDED", commitSha: commit, branch: "autopilot/proof-1", platformVersion: "1", workflowVersion: "1", policyVersion: "1", startedAt: now, finishedAt: now } as never);
  const e2e = (commitSha: string) =>
    save("VALIDATION_REPORT", { suite: "HTTP_E2E", commitSha, verdict: "PROVEN", result: "PASS", workflowRunUrl: "https://github.com/acme/autopilot/actions/runs/1", evidence: { collection: { summary: { passedScenarios: 5, scenarios: 5, passedRequests: 46, requests: 46 }, coverage: { coveredOperations: 44, totalOperations: 44 } } } });
  return { store, service, project, task, resource, e2e };
}

describe("change proof", () => {
  it("is PROVEN only when the records show every piece at the latest commit, with the numbers and links", async () => {
    const { store, service, project, task, e2e } = await verifiedTask();
    await e2e(commit);
    expect((await service.taskReview(project.id, task.id)).task.state).toBe("READY");
    const proof = await changeProof({ store, service }, project, (await store.getTask(project.id, task.id))!);
    expect(proof).toMatchObject({
      verdict: "PROVEN",
      missing: [],
      commit,
      branch: "autopilot/proof-1",
      tests: { passed: true, executed: { tests: 476, failures: 0, skipped: 9 } },
      review: { result: expect.stringMatching(/^PASS/) },
      httpE2e: { verdict: "PROVEN", atLatestCommit: true, coverage: { covered: 44, total: 44 }, requests: { passed: 46, total: 46 }, runUrl: "https://github.com/acme/autopilot/actions/runs/1" },
    });
  });

  it("says NOT_PROVEN, and why, when E2E ran at an older commit", async () => {
    const { store, service, project, task, e2e } = await verifiedTask();
    await e2e(older);
    await service.taskReview(project.id, task.id);
    const proof = await changeProof({ store, service }, project, (await store.getTask(project.id, task.id))!);
    expect(proof.verdict).toBe("NOT_PROVEN");
    expect(proof.httpE2e).toMatchObject({ atLatestCommit: false });
    expect(proof.missing.join(" ")).toContain(`HTTP E2E ran at ${older.slice(0, 12)}, not at the latest commit ${commit.slice(0, 12)}`);
  });

  it("names the failing tests instead of reporting success", async () => {
    const { store, service, project, task } = await verifiedTask({ passed: false, failedTests: [{ test: "ArchTest > http imports only contracts()", message: "API bypasses public contract" }] });
    const proof = await changeProof({ store, service }, project, (await store.getTask(project.id, task.id))!);
    expect(proof.verdict).toBe("NOT_PROVEN");
    expect(proof.tests).toMatchObject({ passed: false, executed: { tests: 476, failures: 1 }, failedTests: [{ test: "ArchTest > http imports only contracts()" }] });
    expect(proof.missing[0]).toBe("tests failed: ArchTest > http imports only contracts()");
  });
});
