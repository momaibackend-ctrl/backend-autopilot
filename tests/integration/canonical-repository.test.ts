import { describe, expect, it } from "vitest";
import { SuperadminService } from "../../packages/superadmin/src/index.js";
import type { CanonicalDevelopmentRepository, Resource } from "../../packages/schemas/src/index.js";
import { testService } from "../helpers/service.js";
import { commitSha, FakeRepositoryProvider } from "../helpers/repository-provider.js";

const superadmin = { actor: "test-superadmin", role: "SUPERADMIN" as const };
const head = commitSha("aaaa1111");
const movedHead = commitSha("bbbb2222");
const otherHead = commitSha("cccc3333");

async function fixture() {
  const { store, service } = testService();
  const system = await service.projectCreate({ name: "System", slug: "system", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", workspacePath: "" });
  const project = await service.projectCreate({ name: "App", slug: "app", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "GUARDED", workspacePath: "" });
  const other = await service.projectCreate({ name: "Other", slug: "other", sourceType: "TEST", environment: "SANDBOX", autonomyMode: "GUARDED", workspacePath: "" });
  // GITHUB_REPOSITORY resources come from the verified provider registration flow, never from
  // superadmin_resource_create; seeded directly here to mirror that path.
  const register = (projectId: string, reference: string, overrides: Partial<Resource> = {}) =>
    store.createResource({ resourceId: crypto.randomUUID(), type: "GITHUB_REPOSITORY", provider: "github", externalReference: reference, projectId, environment: "SANDBOX", permissions: ["READ", "WRITE", "ADMIN"], status: "ACTIVE", secretRefs: [], createdAt: new Date().toISOString(), ...overrides });
  const sandbox = await register(project.id, "momai/kotlin-sandbox");
  const successor = await register(project.id, "momai/successor");
  const foreign = await register(other.id, "momai/foreign");
  const repositories = new FakeRepositoryProvider({
    "momai/kotlin-sandbox": { defaultBranch: "main", head, commits: [head, movedHead] },
    "momai/successor": { defaultBranch: "main", head: otherHead, commits: [otherHead] },
    "momai/foreign": { defaultBranch: "main", head, commits: [head] },
  });
  const admin = new SuperadminService({ store, service, systemProjectId: system.id, repositories });
  return { store, service, admin, project, other, sandbox, successor, foreign, repositories };
}

const promoteInput = (projectId: string, resourceId: string, operationId: string, expectedHeadSha: string, version: number) => ({
  projectId, resourceId, operationId, expectedHeadSha,
  expectedCurrentCanonicalVersion: version,
  confirmation: "PROMOTE_CANONICAL_DEVELOPMENT_REPOSITORY" as const,
  reason: "Adopt this repository as the project's development target",
});

describe("canonical development repository", () => {
  it("plans a first promotion read-only, then records it durably", async () => {
    const { store, admin, project, sandbox } = await fixture();

    const plan = await admin.canonicalRepositoryPlan(superadmin, project.id, sandbox.resourceId);
    expect(plan.result).toBe("READY_TO_PROMOTE");
    expect(plan.candidateHeadSha).toBe(head);
    expect(plan.candidateDefaultBranch).toBe("main");
    expect(plan.expectedCurrentCanonicalVersion).toBe(0);
    expect(plan.currentCanonical).toBeUndefined();
    expect(plan.changesThatWouldOccur.join(" ")).toContain("first ACTIVE canonical development repository");
    // A dry run leaves nothing behind: no binding, no artifact, no audit event.
    expect(await store.getActiveCanonicalRepository(project.id)).toBeUndefined();
    expect(await store.listArtifacts(project.id)).toEqual([]);

    const promoted = await admin.canonicalRepositoryPromote(superadmin, promoteInput(project.id, sandbox.resourceId, "canonical-promote-1", head, 0));
    const value = promoted.value as { canonical: CanonicalDevelopmentRepository; reportArtifactId: string };
    expect(value.canonical.status).toBe("ACTIVE");
    expect(value.canonical.version).toBe(1);
    expect(value.canonical.canonicalSinceSha).toBe(head);
    expect(value.canonical.repositoryIdentity.externalReference).toBe("momai/kotlin-sandbox");

    // "Promotion succeeded" means the durable row was written AND read back.
    expect((await store.getActiveCanonicalRepository(project.id))?.id).toBe(value.canonical.id);
    const artifacts = await store.listArtifacts(project.id);
    expect(artifacts.map((artifact) => artifact.kind)).toContain("CANONICAL_REPOSITORY_REPORT");
    const audit = await store.listAudit(project.id);
    expect(audit.some((event) => event.action === "mcp.canonical_repository_promote")).toBe(true);
    expect(audit.some((event) => event.action === "canonical_repository.promote")).toBe(true);
  });

  it("replays the same logical promotion without creating a second binding or moving canonicalSinceAt", async () => {
    const { store, admin, project, sandbox } = await fixture();
    const first = await admin.canonicalRepositoryPromote(superadmin, promoteInput(project.id, sandbox.resourceId, "canonical-promote-replay", head, 0));
    const replay = await admin.canonicalRepositoryPromote(superadmin, promoteInput(project.id, sandbox.resourceId, "canonical-promote-replay", head, 0));

    expect(replay.idempotentReplay).toBe(true);
    const original = (first.value as { canonical: CanonicalDevelopmentRepository }).canonical;
    const replayed = (replay.value as { canonical: CanonicalDevelopmentRepository }).canonical;
    expect(replayed.id).toBe(original.id);
    expect(replayed.canonicalSinceAt).toBe(original.canonicalSinceAt);
    expect(await store.listCanonicalRepositories(project.id)).toHaveLength(1);
  });

  it("lets only one of two concurrent promotions win", async () => {
    const { store, admin, project, sandbox, successor } = await fixture();
    const results = await Promise.allSettled([
      admin.canonicalRepositoryPromote(superadmin, promoteInput(project.id, sandbox.resourceId, "canonical-race-a", head, 0)),
      admin.canonicalRepositoryPromote(superadmin, promoteInput(project.id, successor.resourceId, "canonical-race-b", otherHead, 0)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    // The invariant is about durable state, not about which caller lost.
    const bindings = await store.listCanonicalRepositories(project.id);
    expect(bindings.filter((binding) => binding.status === "ACTIVE")).toHaveLength(1);
  });

  it("supersedes rather than deletes when the canonical repository is replaced", async () => {
    const { store, admin, project, sandbox, successor } = await fixture();
    await admin.canonicalRepositoryPromote(superadmin, promoteInput(project.id, sandbox.resourceId, "canonical-first", head, 0));

    const plan = await admin.canonicalRepositoryPlan(superadmin, project.id, successor.resourceId);
    expect(plan.result).toBe("READY_TO_PROMOTE");
    expect(plan.expectedCurrentCanonicalVersion).toBe(1);
    expect(plan.changesThatWouldOccur.join(" ")).toContain("would become SUPERSEDED");

    await admin.canonicalRepositoryPromote(superadmin, promoteInput(project.id, successor.resourceId, "canonical-second", otherHead, 1));
    const bindings = await store.listCanonicalRepositories(project.id);
    expect(bindings).toHaveLength(2);
    expect(bindings[0]?.status).toBe("SUPERSEDED");
    expect(bindings[0]?.supersededBy).toBe(bindings[1]?.id);
    expect(bindings[1]?.status).toBe("ACTIVE");
    expect(bindings[1]?.version).toBe(2);
    expect(bindings[1]?.supersedes).toBe(bindings[0]?.id);
  });

  it("rolls the binding back to the previous repository without touching Git", async () => {
    const { store, admin, project, sandbox, successor } = await fixture();
    await admin.canonicalRepositoryPromote(superadmin, promoteInput(project.id, sandbox.resourceId, "canonical-roll-1", head, 0));
    await admin.canonicalRepositoryPromote(superadmin, promoteInput(project.id, successor.resourceId, "canonical-roll-2", otherHead, 1));

    const rolledBack = await admin.canonicalRepositoryRollback(superadmin, { projectId: project.id, operationId: "canonical-roll-back-1", expectedCurrentCanonicalVersion: 2, confirmation: "ROLLBACK_CANONICAL_DEVELOPMENT_REPOSITORY", reason: "Restore the previous development target" });
    const restored = (rolledBack.value as { canonical: CanonicalDevelopmentRepository }).canonical;
    expect(restored.resourceId).toBe(sandbox.resourceId);
    expect(restored.version).toBe(3);

    const bindings = await store.listCanonicalRepositories(project.id);
    expect(bindings).toHaveLength(3);
    expect(bindings.map((binding) => binding.status)).toEqual(["SUPERSEDED", "ROLLED_BACK", "ACTIVE"]);
    // History is never deleted, and the rollback is metadata only.
    const report = (await store.listArtifacts(project.id)).filter((artifact) => artifact.kind === "CANONICAL_REPOSITORY_REPORT").at(-1);
    expect((report?.content as { operation: string; gitHistoryTouched: boolean }).operation).toBe("ROLLBACK");
    expect((report?.content as { gitHistoryTouched: boolean }).gitHistoryTouched).toBe(false);
  });

  it("replays a rollback idempotently", async () => {
    const { store, admin, project, sandbox, successor } = await fixture();
    await admin.canonicalRepositoryPromote(superadmin, promoteInput(project.id, sandbox.resourceId, "canonical-idem-1", head, 0));
    await admin.canonicalRepositoryPromote(superadmin, promoteInput(project.id, successor.resourceId, "canonical-idem-2", otherHead, 1));
    const rollback = { projectId: project.id, operationId: "canonical-idem-rollback", expectedCurrentCanonicalVersion: 2, confirmation: "ROLLBACK_CANONICAL_DEVELOPMENT_REPOSITORY" as const, reason: "Restore the previous development target" };
    await admin.canonicalRepositoryRollback(superadmin, rollback);
    const replay = await admin.canonicalRepositoryRollback(superadmin, rollback);
    expect(replay.idempotentReplay).toBe(true);
    expect(await store.listCanonicalRepositories(project.id)).toHaveLength(3);
  });

  it("refuses a rollback whose restored repository is no longer usable", async () => {
    const { store, admin, project, sandbox, successor } = await fixture();
    await admin.canonicalRepositoryPromote(superadmin, promoteInput(project.id, sandbox.resourceId, "canonical-dead-1", head, 0));
    await admin.canonicalRepositoryPromote(superadmin, promoteInput(project.id, successor.resourceId, "canonical-dead-2", otherHead, 1));
    await store.updateResource({ ...sandbox, status: "DISABLED" });

    await expect(
      admin.canonicalRepositoryRollback(superadmin, { projectId: project.id, operationId: "canonical-dead-rollback", expectedCurrentCanonicalVersion: 2, confirmation: "ROLLBACK_CANONICAL_DEVELOPMENT_REPOSITORY", reason: "Restore the previous development target" }),
    ).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  });

  it("blocks a promotion whose plan went stale, instead of silently adopting the new head", async () => {
    const { admin, project, sandbox, repositories } = await fixture();
    const plan = await admin.canonicalRepositoryPlan(superadmin, project.id, sandbox.resourceId);
    expect(plan.expectedHeadSha).toBe(head);

    // The branch moves between the dry run and the mutation.
    repositories.set("momai/kotlin-sandbox", { defaultBranch: "main", head: movedHead, commits: [head, movedHead] });

    await expect(
      admin.canonicalRepositoryPromote(superadmin, promoteInput(project.id, sandbox.resourceId, "canonical-stale-1", head, 0)),
    ).rejects.toMatchObject({ code: "CONFLICT", details: expect.objectContaining({ blockingReport: expect.objectContaining({ code: "STALE_PROMOTION_PLAN" }) }) });

    // A fresh plan carries the new head, and only then does the promotion go through.
    const refreshed = await admin.canonicalRepositoryPlan(superadmin, project.id, sandbox.resourceId);
    expect(refreshed.expectedHeadSha).toBe(movedHead);
    const promoted = await admin.canonicalRepositoryPromote(superadmin, promoteInput(project.id, sandbox.resourceId, "canonical-stale-2", movedHead, 0));
    expect((promoted.value as { canonical: CanonicalDevelopmentRepository }).canonical.canonicalSinceSha).toBe(movedHead);
  });

  it("blocks a promotion whose canonical version moved under it", async () => {
    const { admin, project, sandbox, successor } = await fixture();
    await admin.canonicalRepositoryPromote(superadmin, promoteInput(project.id, sandbox.resourceId, "canonical-version-1", head, 0));
    // A caller still holding the pre-promotion plan (version 0) must lose.
    await expect(
      admin.canonicalRepositoryPromote(superadmin, promoteInput(project.id, successor.resourceId, "canonical-version-2", otherHead, 0)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("reports verification state honestly instead of fabricating one", async () => {
    const { store, admin, project, sandbox } = await fixture();
    const bare = await admin.canonicalRepositoryPlan(superadmin, project.id, sandbox.resourceId);
    expect(bare.verificationState).toMatchObject({ source: "NONE", status: "UNKNOWN", atCandidateHead: false });
    expect(bare.warnings.join(" ")).toContain("No epic verification or CI evidence");

    // Evidence produced at another commit is stale, not a pass.
    await store.saveArtifact({ id: crypto.randomUUID(), projectId: project.id, kind: "EPIC_VERIFICATION_REPORT", schemaVersion: "5", content: { epicKey: "CORE-BE", headSha: movedHead, result: "PASS", repository: "momai/kotlin-sandbox" }, contentHash: "hash", status: "AVAILABLE", createdAt: new Date().toISOString() });
    const stale = await admin.canonicalRepositoryPlan(superadmin, project.id, sandbox.resourceId);
    expect(stale.verificationState).toMatchObject({ source: "EPIC_VERIFICATION_REPORT", status: "PASS", atCandidateHead: false });
    expect(stale.warnings.join(" ")).toContain("not at the candidate head");
    // An unverified head is a warning an operator weighs, never an automatic blocker.
    expect(stale.result).toBe("READY_TO_PROMOTE");
  });

  it("exposes the append-only history through the read model", async () => {
    const { admin, project, sandbox, successor } = await fixture();
    expect(await admin.canonicalRepositoryGet(superadmin, project.id)).toMatchObject({ hasCanonicalRepository: false, history: [] });
    await admin.canonicalRepositoryPromote(superadmin, promoteInput(project.id, sandbox.resourceId, "canonical-hist-1", head, 0));
    await admin.canonicalRepositoryPromote(superadmin, promoteInput(project.id, successor.resourceId, "canonical-hist-2", otherHead, 1));
    const view = await admin.canonicalRepositoryGet(superadmin, project.id);
    expect(view.hasCanonicalRepository).toBe(true);
    expect(view.active?.repositoryIdentity.externalReference).toBe("momai/successor");
    expect(view.history).toHaveLength(2);
  });
});
