// Missions, repository roles and the project brief (ADR 026).
//
// The brief is the first read of any agent session: which repository is what, which goals are
// open, what is done, what failed and why, and the single call that comes next. It is assembled
// from state the control plane already holds and never from a session's memory, so a session that
// starts from nothing resumes exactly where the last one stopped instead of rediscovering the
// project by name and drifting to whatever it finds first.
import { z } from "zod";
import type { AutopilotService } from "../../core/src/application.js";
import { missionProgress, type MissionEvidence, type MissionProgress, type NextCall, type ParityRunView } from "../../core/src/mission.js";
import type { StateStore } from "../../core/src/ports.js";
import type { GitRepositoryProvider } from "../../canonical-repository/src/ports.js";
import { readHttpE2eJob } from "../../ephemeral-environment/src/http-e2e-job.js";
import { missionGoalSchema, missionKeySchema, repositoryRoleSchema, type Mission, type Project, type Resource, type Task } from "../../schemas/src/index.js";

const uuid = z.string().uuid();
const operationId = z.string().min(8).max(200);
const reason = z.string().min(1).max(500);

export const repositoryRoleSetInputSchema = {
  operationId,
  projectId: uuid,
  resourceId: uuid.describe("A registered GITHUB_REPOSITORY resource of this project"),
  role: repositoryRoleSchema.describe("WORKING: deployed and relied on. SANDBOX: where work is assembled before it reaches WORKING. CANDIDATE: the next version of WORKING (e.g. a reimplementation on another stack), built until it is proven to match a reference and then moved into WORKING in its place. ARCHIVE: kept for recovery; nothing is developed there"),
  purpose: z.string().min(1).max(500).optional().describe("One line on why the repository exists, shown to every later session"),
};
export const missionCreateInputSchema = {
  operationId,
  projectId: uuid,
  key: missionKeySchema.describe("Short stable name, unique in the project, e.g. JAVA-PARITY"),
  title: z.string().min(1).max(200),
  goal: missionGoalSchema.describe("PARITY: the target answers every scenario of every contract as the reference does, proven by a comparison run; the reference may be a repository of another project of the same product (superadmin_project_product_set), and referenceRef pins it to a branch, tag or commit. DELIVERY: the attached tasks reach READY in the target"),
  taskIds: z.array(uuid).max(200).default([]).describe("Tasks that carry the work; verification is recorded against them"),
};
export const missionUpdateInputSchema = {
  operationId,
  projectId: uuid,
  missionId: uuid,
  title: z.string().min(1).max(200).optional(),
  addTaskIds: z.array(uuid).max(200).optional(),
  removeTaskIds: z.array(uuid).max(200).optional(),
  referenceRef: z.string().min(1).max(255).nullable().optional().describe("PARITY only: pin the reference to this branch, tag or commit; null unpins it"),
  status: z.enum(["ACTIVE", "ACHIEVED", "CANCELLED"]).optional().describe("ACHIEVED is accepted only when the brief shows every step DONE from evidence"),
  reason: reason.optional(),
};
export const projectBriefInputSchema = { projectId: uuid };
export const projectProductSetInputSchema = {
  operationId,
  projectId: uuid,
  product: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64).nullable().describe("Lower-case product name shared by every project of one product, e.g. momna; null unlinks the project"),
};

export const projectBriefToolDescription =
  "Read-only. START EVERY SESSION HERE. Where the project stands, from the control plane's own records rather than any session's memory: each registered repository with its role (WORKING, SANDBOX, CANDIDATE, ARCHIVE), purpose and the missions it serves, plus the repositories of the other projects of the same product; every mission with its steps derived from evidence (DONE, RUNNING, REMAINING, FAILING), the latest failure with its diagnosis, and the exact next call with arguments; open tasks outside missions; jobs in flight; and one overall nextAction. Continue with nextAction instead of re-exploring the project, its deployments or databases.";

const runningJob = new Set(["QUEUED", "DISPATCHING", "DISPATCHED", "CLAIMED", "RUNNING"]);
/** How many of the target's newest HTTP E2E jobs are opened to find the latest comparison. */
const PARITY_LOOKBACK = 20;

export interface BriefDependencies {
  store: StateStore;
  service: AutopilotService;
  repositories?: GitRepositoryProvider;
}

/**
 * A repository a mission may use as its reference: one of the project's own, or one of another
 * project linked into the same product (ADR 027). Anything else reads as absent.
 */
export async function productRepository(store: StateStore, project: Pick<Project, "id" | "product">, resourceId: string): Promise<Resource | undefined> {
  const resource = await store.getResource(resourceId);
  if (!resource || resource.type !== "GITHUB_REPOSITORY") return undefined;
  if (resource.projectId === project.id) return resource;
  if (!project.product) return undefined;
  return (await store.getProject(resource.projectId))?.product === project.product ? resource : undefined;
}

async function latestParityRun(deps: BriefDependencies, projectId: string, targetId: string, referenceId: string, referenceRef: string | undefined): Promise<ParityRunView | undefined> {
  const summaries = (await deps.store.listExecutionJobSummaries(projectId))
    .filter((job) => job.kind === "HTTP_E2E" && job.resourceId === targetId)
    .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt))
    .slice(0, PARITY_LOOKBACK);
  for (const summary of summaries) {
    const job = await deps.store.getExecutionJob(projectId, summary.id);
    const counterpart = (job?.payload as { counterpart?: { repositoryResourceId?: string; requestedRef?: string } } | undefined)?.counterpart;
    if (!job || counterpart?.repositoryResourceId !== referenceId) continue;
    // A pinned reference counts only runs against exactly that pin.
    if (referenceRef !== undefined && counterpart.requestedRef !== referenceRef) continue;
    const read = await readHttpE2eJob(deps.store, projectId, job.id);
    const evidence = read.evidence;
    const coverage = evidence?.coverage as { coveredOperations?: number; totalOperations?: number } | undefined;
    const failure = evidence?.failure as { class?: string; message?: string } | undefined;
    const diagnosis = evidence?.diagnosis as { area?: string; summary?: string; nextSteps?: string[] } | undefined;
    // A job that ended without recording evidence still says why, in its own error.
    const jobError = runningJob.has(job.status) ? undefined : (job.error as { code?: string; message?: string } | undefined);
    return {
      jobId: job.id,
      status: job.status,
      commitSha: job.baseCommitSha ?? "unknown",
      ...(job.workflowRunUrl ? { workflowRunUrl: job.workflowRunUrl } : {}),
      ...(evidence?.verdict === "PROVEN" || evidence?.verdict === "NOT_PROVEN" ? { verdict: evidence.verdict } : {}),
      ...(failure?.class ? { failureClass: failure.class } : jobError?.code ? { failureClass: jobError.code } : {}),
      ...(failure?.message ? { failureMessage: failure.message } : jobError?.message ? { failureMessage: jobError.message } : {}),
      ...(diagnosis ? { diagnosis: { ...(diagnosis.area ? { area: diagnosis.area } : {}), ...(diagnosis.summary ? { summary: diagnosis.summary } : {}), ...(diagnosis.nextSteps ? { nextSteps: diagnosis.nextSteps } : {}) } } : {}),
      ...(coverage?.totalOperations ? { coverage: { covered: coverage.coveredOperations ?? 0, total: coverage.totalOperations } } : {}),
    };
  }
  return undefined;
}

async function defaultHead(deps: BriefDependencies, resource: Resource | undefined) {
  if (!deps.repositories || !resource || resource.status !== "ACTIVE") return undefined;
  try {
    const description = await deps.repositories.describe(resource.externalReference);
    return await deps.repositories.resolveRef(resource.externalReference, description.defaultBranch);
  } catch {
    // An unreachable provider leaves the head unknown; the proof is then reported at its own commit.
    return undefined;
  }
}

export async function missionEvidence(deps: BriefDependencies, project: Pick<Project, "id" | "product">, mission: Mission, resources: Resource[], tasks: Task[]): Promise<MissionEvidence> {
  const byId = new Map(resources.map((resource) => [resource.resourceId, resource]));
  const target = byId.get(mission.goal.targetResourceId);
  const reference = mission.goal.kind === "PARITY" ? (byId.get(mission.goal.referenceResourceId) ?? (await productRepository(deps.store, project, mission.goal.referenceResourceId))) : undefined;
  const taskById = new Map(tasks.filter((task) => !task.deletedAt).map((task) => [task.id, task]));
  const attached = mission.taskIds.map((id) => taskById.get(id)).filter((task): task is Task => Boolean(task));
  const views = await Promise.all(
    attached.map(async (task) => {
      const readiness = await deps.service.taskReadiness(mission.projectId, task.id);
      return {
        task: { id: task.id, externalKey: task.externalKey, title: task.title, state: task.state },
        nextAction: readiness.nextAction,
        repair: { consecutiveSameCause: readiness.repair.consecutiveSameCause, stagnating: readiness.repair.stagnating, ...(readiness.repair.guidance ? { guidance: readiness.repair.guidance } : {}) },
      };
    }),
  );
  const parity = mission.goal.kind === "PARITY" ? await latestParityRun(deps, mission.projectId, mission.goal.targetResourceId, mission.goal.referenceResourceId, mission.goal.referenceRef) : undefined;
  // The head matters only to tell whether a PROVEN comparison still covers the target.
  const targetHead = parity?.verdict === "PROVEN" ? await defaultHead(deps, target) : undefined;
  return {
    ...(target ? { target } : {}),
    ...(reference ? { reference } : {}),
    tasks: views,
    missingTaskIds: mission.taskIds.filter((id) => !taskById.has(id)),
    ...(parity ? { parity } : {}),
    ...(targetHead ? { targetHead } : {}),
  };
}

export interface ProjectBrief {
  project: Pick<Project, "id" | "name" | "slug" | "environment" | "autonomyMode" | "product">;
  /**
   * The repositories of the other projects of the same product, read-only from here: usable as a
   * mission's comparison reference, developed only from their own project.
   */
  productRepositories: Array<{ projectId: string; projectName: string; resourceId: string; repository: string; role?: Resource["role"]; purpose?: string; status: Resource["status"]; missions: Array<{ missionKey: string; as: "TARGET" | "REFERENCE" }> }>;
  repositories: Array<{
    resourceId: string;
    repository: string;
    role?: Resource["role"];
    purpose?: string;
    status: Resource["status"];
    permissions: Resource["permissions"];
    canonical: boolean;
    missions: Array<{ missionKey: string; as: "TARGET" | "REFERENCE" }>;
  }>;
  missions: Array<{
    id: string;
    key: string;
    title: string;
    status: Mission["status"];
    goal: { kind: Mission["goal"]["kind"]; target?: string; reference?: string };
    tasks: string[];
    statusReason?: string;
    achievedAt?: string;
    progress?: MissionProgress;
  }>;
  otherOpenTasks: Array<{ taskId: string; externalKey: string; title: string; state: Task["state"]; updatedAt: string }>;
  jobsInFlight: Array<{ jobId: string; kind: string; status: string; taskId: string; resourceId: string; queuedAt: string }>;
  setup: NextCall[];
  nextAction: NextCall | null;
  rules: string[];
}

const OTHER_TASKS_SHOWN = 15;

export async function projectBrief(deps: BriefDependencies, project: Project): Promise<ProjectBrief> {
  const projectId = project.id;
  const [resources, tasks, missions, canonical, inFlight] = await Promise.all([
    deps.store.listResources(projectId),
    deps.store.listTasks(projectId),
    deps.store.listMissions(projectId),
    deps.store.getActiveCanonicalRepository(projectId),
    deps.store.listExecutionJobSummaries(projectId, undefined, [...runningJob]),
  ]);
  const repositories = resources.filter((resource) => resource.type === "GITHUB_REPOSITORY" && resource.status !== "DELETED");
  const siblings = project.product ? (await deps.store.listProjects()).filter((other) => other.id !== projectId && other.product === project.product && !other.deletedAt) : [];
  const siblingRepositories = (
    await Promise.all(siblings.map(async (other) => (await deps.store.listResources(other.id)).filter((resource) => resource.type === "GITHUB_REPOSITORY" && resource.status !== "DELETED").map((resource) => ({ project: other, resource }))))
  ).flat();
  const name = new Map([...resources, ...siblingRepositories.map((value) => value.resource)].map((resource) => [resource.resourceId, resource.externalReference]));
  const taskKey = new Map(tasks.map((task) => [task.id, task.externalKey]));
  const active = missions.filter((mission) => mission.status === "ACTIVE");

  const missionViews = await Promise.all(
    missions.map(async (mission) => ({
      id: mission.id,
      key: mission.key,
      title: mission.title,
      status: mission.status,
      goal: {
        kind: mission.goal.kind,
        ...(name.get(mission.goal.targetResourceId) ? { target: name.get(mission.goal.targetResourceId)! } : {}),
        ...(mission.goal.kind === "PARITY" && name.get(mission.goal.referenceResourceId) ? { reference: name.get(mission.goal.referenceResourceId)! } : {}),
      },
      tasks: mission.taskIds.map((id) => taskKey.get(id) ?? id),
      ...(mission.statusReason ? { statusReason: mission.statusReason } : {}),
      ...(mission.achievedAt ? { achievedAt: mission.achievedAt } : {}),
      // Progress is derived for open missions only; a closed one keeps the verdict it closed with.
      ...(mission.status === "ACTIVE" ? { progress: missionProgress(mission, await missionEvidence(deps, project, mission, resources, tasks)) } : {}),
    })),
  );

  const servedBy = (resourceId: string) =>
    active.flatMap((mission) => [
      ...(mission.goal.targetResourceId === resourceId ? [{ missionKey: mission.key, as: "TARGET" as const }] : []),
      ...(mission.goal.kind === "PARITY" && mission.goal.referenceResourceId === resourceId ? [{ missionKey: mission.key, as: "REFERENCE" as const }] : []),
    ]);
  const inMission = new Set(active.flatMap((mission) => mission.taskIds));
  const otherOpenTasks = tasks
    .filter((task) => !task.deletedAt && !inMission.has(task.id) && task.state !== "READY" && task.state !== "FAILED")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, OTHER_TASKS_SHOWN)
    .map((task) => ({ taskId: task.id, externalKey: task.externalKey, title: task.title, state: task.state, updatedAt: task.updatedAt }));

  const setup: NextCall[] = [
    ...repositories
      .filter((resource) => !resource.role)
      .map((resource) => ({
        tool: "superadmin_repository_role_set",
        arguments: { projectId, resourceId: resource.resourceId },
        why: `${resource.externalReference} has no role. Say what it is (WORKING, SANDBOX, CANDIDATE or ARCHIVE) so no session has to guess from its name.`,
      })),
    ...(active.length
      ? []
      : [{ tool: "superadmin_mission_create", arguments: { projectId }, why: "No mission is open. Record the goal (for a new version: PARITY of the CANDIDATE against the WORKING reference) so its progress survives every session." }]),
  ];
  const firstMission = missionViews.find((view) => view.status === "ACTIVE" && view.progress?.nextAction);

  return {
    project: { id: project.id, name: project.name, slug: project.slug, environment: project.environment, autonomyMode: project.autonomyMode, ...(project.product ? { product: project.product } : {}) },
    productRepositories: siblingRepositories.map(({ project: other, resource }) => ({
      projectId: other.id,
      projectName: other.name,
      resourceId: resource.resourceId,
      repository: resource.externalReference,
      ...(resource.role ? { role: resource.role } : {}),
      ...(resource.purpose ? { purpose: resource.purpose } : {}),
      status: resource.status,
      missions: servedBy(resource.resourceId),
    })),
    repositories: repositories.map((resource) => ({
      resourceId: resource.resourceId,
      repository: resource.externalReference,
      ...(resource.role ? { role: resource.role } : {}),
      ...(resource.purpose ? { purpose: resource.purpose } : {}),
      status: resource.status,
      permissions: resource.permissions,
      canonical: canonical?.resourceId === resource.resourceId,
      missions: servedBy(resource.resourceId),
    })),
    missions: missionViews,
    otherOpenTasks,
    jobsInFlight: inFlight.map((job) => ({ jobId: job.id, kind: job.kind, status: job.status, taskId: job.taskId, resourceId: job.resourceId, queuedAt: job.queuedAt })),
    setup,
    nextAction: firstMission?.progress?.nextAction ?? setup[0] ?? null,
    rules: [
      "Work from this brief and its nextAction. Do not rediscover the project from deployments, staging URLs or databases: verification runs in throwaway environments the autopilot builds itself.",
      "Repositories are named by role, not by guess: develop in the mission's target and compare against its reference. ARCHIVE is kept for recovery; nothing is developed there. Repositories listed under productRepositories belong to other projects of the same product: compare against them from here, develop in them only from their own project.",
      "A failure is a cause to fix, not a stop: read its diagnosis, fix that cause, run again. Only production access, real secrets, login or a product decision need a person.",
      "Re-read this brief after every step; it is recomputed from evidence each time.",
    ],
  };
}
