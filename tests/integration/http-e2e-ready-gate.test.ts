import { describe, expect, it, vi } from "vitest";
import { AsyncExecutionCoordinator } from "../../packages/core/src/async-execution.js";
import { buildVerificationProfile, requiresLayer } from "../../packages/core/src/verification-profile.js";
import type { ImplementationPlan } from "../../packages/schemas/src/index.js";
import { testService } from "../helpers/service.js";

const commit = "a".repeat(40);
const olderCommit = "b".repeat(40);

// A task that asks for full end-to-end verification in so many words, so its v2 plan owes the
// HTTP_E2E layer without also owing API_CONTRACT evidence (it adds no public surface of its own).
async function reviewedTask(options: { profile?: "v1" } = {}) {
  const { store, service } = testService();
  const project = await service.projectCreate({ name: "Ready gate", slug: `ready-gate-${crypto.randomUUID()}`, sourceType: "LOCAL", environment: "SANDBOX", autonomyMode: "GUARDED" });
  const resource = await service.resourceRegister({ projectId: project.id, type: "GITHUB_REPOSITORY", provider: "github", externalReference: "sandbox-owner/backend", environment: "SANDBOX", permissions: ["READ", "WRITE"], secretRefs: [] });
  const task = await service.taskCreate({ projectId: project.id, externalKey: "MIG-1", title: "Полная интеграционная проверка миграции", description: "Verify the migrated service end to end", requirements: ["full end-to-end verification of the migrated service"], relationships: [] });
  await service.taskAnalyze(project.id, task.id);
  await service.taskPlan(project.id, task.id);
  const planArtifact = (await store.listArtifacts(project.id, task.id)).find((artifact) => artifact.kind === "IMPLEMENTATION_PLAN");
  let plan = planArtifact?.content as ImplementationPlan;
  if (options.profile === "v1" && planArtifact) {
    // A plan made before v2: the same profile without the HTTP_E2E decision.
    plan = { ...plan, verification: { profileVersion: "1", decisions: (plan.verification?.decisions ?? []).filter((decision) => decision.layer !== "HTTP_E2E") } };
    await store.updateArtifact({ ...planArtifact, content: plan });
  }
  await store.updateTask({ ...(await store.getTask(project.id, task.id))!, state: "REVIEWING" });
  const now = new Date().toISOString();
  const save = (kind: string, content: unknown) =>
    store.saveArtifact({ id: crypto.randomUUID(), projectId: project.id, taskId: task.id, kind, schemaVersion: "1", content, contentHash: "hash", status: "AVAILABLE", createdAt: now } as never);
  await save("CODE_DIFF", { diff: 'diff --git a/src/x.ts b/src/x.ts\n+ log.info("x.handled")', changedFiles: ["src/x.ts"] });
  await save("TEST_REPORT", { passed: true, suites: plan.testsRequired.map((type) => ({ type, command: ["pnpm", "test"], passed: true, exitCode: 0 })), finishedAt: now });
  await save("SECURITY_REPORT", { passed: true });
  await save("CI_REPORT", { expectedSha: commit, ci: { success: true, headSha: commit } });
  await store.saveRun({ id: crypto.randomUUID(), projectId: project.id, taskId: task.id, operationId: `run-${crypto.randomUUID()}`, status: "SUCCEEDED", commitSha: commit, platformVersion: "1", workflowVersion: "1", policyVersion: "1", startedAt: now, finishedAt: now } as never);
  const evidence = (commitSha: string, verdict: "PROVEN" | "NOT_PROVEN") =>
    save("VALIDATION_REPORT", { suite: "HTTP_E2E", commitSha, verdict, result: verdict === "PROVEN" ? "PASS" : "FAIL", ...(verdict === "NOT_PROVEN" ? { failure: { class: "SCENARIO_FAILED", step: "collection", message: "1 of 3 scenario(s) did not pass" } } : {}) });
  return { store, service, project, resource, task, plan, evidence };
}

describe("verification profile v2", () => {
  it("owes HTTP_E2E for a public HTTP surface or an explicit end-to-end request, and says why otherwise", () => {
    expect(buildVerificationProfile("Add a REST endpoint GET /notes that lists notes").profileVersion).toBe("2");
    expect(requiresLayer(buildVerificationProfile("Add a REST endpoint GET /notes that lists notes"), "HTTP_E2E")).toBe(true);
    expect(requiresLayer(buildVerificationProfile("Полная интеграционная проверка Java-миграции"), "HTTP_E2E")).toBe(true);
    expect(requiresLayer(buildVerificationProfile("Run the parity check between both implementations"), "HTTP_E2E")).toBe(true);
    const internal = buildVerificationProfile("Refactor the internal retry helper; do not add public HTTP APIs");
    expect(requiresLayer(internal, "HTTP_E2E")).toBe(false);
    expect(internal.decisions.find((decision) => decision.layer === "HTTP_E2E")?.reasons[0]).toMatch(/rules a public HTTP surface out/);
  });
});

describe("READY gate with full HTTP verification", () => {
  it("rests in VERIFYING instead of failing review, and spends no repair attempt", async () => {
    const { service, project, task } = await reviewedTask();
    const reviewed = await service.taskReview(project.id, task.id);
    expect(reviewed.task.state).toBe("VERIFYING");
    const readiness = await service.taskReadiness(project.id, task.id);
    expect(readiness.blockers.map((blocker) => blocker.code)).toEqual(["HTTP_E2E_EVIDENCE"]);
    expect(readiness.blockers[0]?.remediation).toContain(commit);
    expect(readiness.nextAction?.tool).toBe("superadmin_http_e2e_run");
    expect((await service.taskGet(project.id, task.id)).repairAttempts).toBe(0);
  });

  it("stays blocked on NOT_PROVEN or on PROVEN evidence for another commit, and becomes READY on PROVEN for the latest", async () => {
    const { store, service, project, task, evidence } = await reviewedTask();
    await service.taskReview(project.id, task.id);
    await evidence(commit, "NOT_PROVEN");
    await expect(service.taskCompleteVerification(project.id, task.id)).rejects.toMatchObject({ code: "REVIEW_FAILED" });
    expect((await service.taskReadiness(project.id, task.id)).blockers[0]?.reason).toContain("NOT_PROVEN (SCENARIO_FAILED");
    await evidence(olderCommit, "PROVEN");
    await expect(service.taskCompleteVerification(project.id, task.id)).rejects.toMatchObject({ code: "REVIEW_FAILED" });
    await evidence(commit, "PROVEN");
    const completed = await service.taskCompleteVerification(project.id, task.id);
    expect(completed.task.state).toBe("READY");
    const manifest = (await store.listArtifacts(project.id, task.id)).find((artifact) => artifact.kind === "FINAL_CHANGE_MANIFEST");
    expect(manifest?.content).toMatchObject({ verifiedCommitSha: commit, gates: { httpE2e: true } });
  });

  it("goes straight to READY when PROVEN evidence for the commit already exists at review", async () => {
    const { service, project, task, evidence } = await reviewedTask();
    await evidence(commit, "PROVEN");
    expect((await service.taskReview(project.id, task.id)).task.state).toBe("READY");
  });

  it("never applies the new requirement to a plan made before v2", async () => {
    const { service, project, task } = await reviewedTask({ profile: "v1" });
    expect((await service.taskReview(project.id, task.id)).task.state).toBe("READY");
  });

  it("refuses to complete a task that is not VERIFYING", async () => {
    const { service, project, task } = await reviewedTask();
    await expect(service.taskCompleteVerification(project.id, task.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("repairs from VERIFYING through the full gate chain", async () => {
    const { store, service, project, resource, task } = await reviewedTask();
    await service.taskReview(project.id, task.id);
    const coordinator = new AsyncExecutionCoordinator(store, { dispatch: vi.fn(async () => ({ workflowRunId: "wf-repair" })) });
    await coordinator.enqueueImplementation({ projectId: project.id, taskId: task.id, operationId: `repair-${crypto.randomUUID()}`, changes: [{ path: "src/fix.ts", content: "export const fixed = true;\n" }] }, resource.resourceId);
    expect((await service.taskGet(project.id, task.id)).state).toBe("IMPLEMENTING");
    const transitions = (await service.taskStatus(project.id, task.id)).transitions.map((value) => `${value.from}->${value.to}`);
    expect(transitions).toContain("VERIFYING->IMPLEMENTING");
  });
});
