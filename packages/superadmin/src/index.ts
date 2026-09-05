import { createHash } from "node:crypto";
import { AuditLog, redact } from "../../audit/src/index.js";
import { ArtifactStore } from "../../artifact-store/src/index.js";
import type { AsyncExecutionCoordinator } from "../../core/src/async-execution.js";
import type { AutopilotService } from "../../core/src/application.js";
import {
  Conflict,
  InvalidState,
  NotFound,
  PolicyViolation,
  UnsupportedOperation,
} from "../../core/src/errors.js";
import type {
  ArtifactBlobStore,
  Clock,
  IdGenerator,
  StateStore,
} from "../../core/src/ports.js";
import { systemClock, uuidGenerator } from "../../core/src/ports.js";
import { requireProjectGithubRepository } from "../../core/src/repository-guard.js";
import { PolicyEngine } from "../../policy-engine/src/index.js";
import {
  consoleScreenUpsertSchema,
  confirmedDeleteSchema,
  operatorSchema,
  PlatformVersions,
  projectMembershipSchema,
  projectUpdateSchema,
  resourceUpdateSchema,
  systemSettingUpsertSchema,
  taskUpdateSchema,
  canonicalRepositoryPromoteInputSchema,
  canonicalRepositoryRollbackInputSchema,
  repositoryExportInputSchema,
  repositoryRenameInputSchema,
  validationScenarioSaveInputSchema,
  validationSuiteSchema,
  type DeveloperHandoverReport,
  type PrincipalRole,
  type Project,
  type Resource,
  type TaskState,
} from "../../schemas/src/index.js";
import { resolveRebasePlan } from "./rebase-eligibility.js";
import {
  CanonicalRepositoryService,
  type GitRepositoryProvider,
  type RepositoryExportDispatcher,
} from "../../canonical-repository/src/index.js";
import {
  HttpScenarioRunner,
  scenarioForStorage,
  type FetchLike,
  type ScenarioExecutionResult,
  type SecretResolver,
} from "../../http-runner/src/index.js";
import { WorkflowEngine } from "../../workflow-engine/src/index.js";
import { z } from "zod";

export interface SuperadminPrincipal {
  actor: string;
  role: PrincipalRole;
  authMethod?: "STATIC_TOKEN" | "OAUTH";
}

export interface SuperadminDependencies {
  store: StateStore;
  service: AutopilotService;
  asyncExecution?: AsyncExecutionCoordinator;
  systemProjectId: string;
  clock?: Clock;
  ids?: IdGenerator;
  artifactBlobs?: ArtifactBlobStore;
  deploymentStatus?: () => Promise<unknown>;
  /** Resolves HTTP_API resource secretRefs for the executable validation runner. */
  secrets?: SecretResolver;
  /** Injectable transport, used by tests; production uses global fetch. */
  fetchImpl?: FetchLike;
  /** Reads Git host state for canonical promotion, export and handover planning. */
  repositories?: GitRepositoryProvider;
  /** Starts the fixed control-repository workflow that performs a Git-level transfer. */
  exportDispatcher?: RepositoryExportDispatcher;
  exportWorkflow?: string;
}

const operationIdSchema = z.string().min(8).max(200);
const lifecycleTargets: Record<TaskState, TaskState[]> = {
  INGESTED: ["ANALYZING", "BLOCKED"],
  ANALYZING: ["PLANNED", "BLOCKED", "FAILED"],
  BLOCKED: ["ANALYZING", "PLANNED"],
  PLANNED: ["IMPLEMENTING", "BLOCKED"],
  IMPLEMENTING: ["TESTING", "FAILED", "BLOCKED"],
  TESTING: ["REVIEWING", "IMPLEMENTING", "BLOCKED", "FAILED"],
  REVIEWING: ["READY", "IMPLEMENTING", "BLOCKED", "FAILED"],
  READY: [],
  FAILED: ["ANALYZING", "IMPLEMENTING"],
};
const administrativeArtifactKinds = new Set(["ADMIN_NOTE", "CONSOLE_SNAPSHOT"]);

export class SuperadminService {
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly audit: AuditLog;
  private readonly artifacts: ArtifactStore;
  private readonly policy: PolicyEngine;
  private readonly workflow: WorkflowEngine;
  private readonly canonical: CanonicalRepositoryService;

  constructor(private readonly deps: SuperadminDependencies) {
    this.clock = deps.clock ?? systemClock;
    this.ids = deps.ids ?? uuidGenerator;
    this.audit = new AuditLog(deps.store, this.ids, this.clock);
    this.artifacts = new ArtifactStore(
      deps.store,
      this.ids,
      this.clock,
      deps.artifactBlobs,
    );
    this.policy = new PolicyEngine(deps.store);
    this.workflow = new WorkflowEngine(deps.store, this.ids, this.clock);
    // One domain implementation, composed once. The MCP tools, the Control API routes and the
    // documented manual operator path all end up here, so none of them can drift into a second
    // set of rules or skip a gate the others enforce.
    this.canonical = new CanonicalRepositoryService({
      store: deps.store,
      clock: this.clock,
      ids: this.ids,
      artifacts: this.artifacts,
      ...(deps.repositories ? { repositories: deps.repositories } : {}),
      ...(deps.exportDispatcher ? { exportDispatcher: deps.exportDispatcher } : {}),
      ...(deps.exportWorkflow ? { exportWorkflow: deps.exportWorkflow } : {}),
    });
  }

  executeMutation<T>(principal:SuperadminPrincipal,tool:string,projectId:string|undefined,operationId:string,input:unknown,action:()=>Promise<T>){
    return this.mutate(principal,tool,projectId,operationId,input,action);
  }

  // A whole-system view across every project, so it is the single call most exposed to history
  // growth. It used to load full tasks, jobs, runs, artifacts AND the entire audit trail per
  // project and then use counts, a state filter, ten errors and ten events -- 12.0 MB and 19.3 s
  // measured on this control plane. Every read below is bounded by what the view renders, so the
  // response size now tracks the number of PROJECTS rather than the volume of their history.
  async systemOverview(principal: SuperadminPrincipal) {
    this.requireSuperadmin(principal);
    const projects = await this.deps.store.listProjects();
    const snapshots = await Promise.all(
      projects.map(async (project) => {
        const [tasks, jobs, runs, artifacts, latestAudit] = await Promise.all([
          this.deps.store.listTasks(project.id),
          this.deps.store.listExecutionJobSummaries(project.id),
          this.deps.store.listRuns(project.id),
          this.deps.store.listArtifactDigests(project.id),
          this.deps.store.listRecentAuditDigests(project.id, 10),
        ]);
        // Job summaries deliberately carry no `error` body. A failed job is still named here, with
        // the pointer needed to fetch it in full, so nothing is hidden -- it is one job_get away
        // instead of ten redacted payloads inlined into every overview.
        const failedJobs = jobs.filter((value) => ["FAILED", "CANCELLED"].includes(value.status));
        // A system-wide view names what needs attention and counts the rest. Inlining all 172 job
        // summaries and all 175 runs of one project cost 180 kB of a 466 kB response to render a
        // status tally -- and that is per project, so it grew with every project added.
        const active = jobs.filter((value) => !["SUCCEEDED", "FAILED", "CANCELLED"].includes(value.status));
        return {
          project,
          tasks: tasks.map((value) => ({ id: value.id, externalKey: value.externalKey, title: value.title, state: value.state, updatedAt: value.updatedAt })),
          counts: { tasks: tasks.length, jobs: jobs.length, runs: runs.length, artifacts: artifacts.length },
          jobStatuses: jobs.reduce<Record<string, number>>((into, value) => { into[value.status] = (into[value.status] ?? 0) + 1; return into; }, {}),
          activeJobs: active,
          latestRuns: runs.slice(-10),
          failedGates: tasks.filter((value) => ["FAILED", "BLOCKED"].includes(value.state)).map((value) => ({ id: value.id, externalKey: value.externalKey, state: value.state })),
          latestErrors: failedJobs.slice(-10).map((value) => ({ jobId: value.id, taskId: value.taskId, status: value.status, attempt: value.attempt, readWith: "job_get" })),
          artifactCount: artifacts.length,
          latestAudit,
        };
      }),
    );
    return {
      generatedAt: this.clock.now(),
      versions: PlatformVersions,
      safety: {
        arbitraryShell: false,
        policyEngineBypass: false,
        productionWrites: "NOT_SUPPORTED",
      },
      capabilities:{superadminMcp:"FULL_SYSTEM_CONTROL",semanticTools:true,arbitraryShell:false,arbitrarySql:false,arbitraryFilesystem:false,arbitraryGitHubBinding:false,auditCoverage:true},
      projects: snapshots,
      settings: await this.settingsList(principal),
      screens: await this.screenList(principal),
      operators: await this.operatorList(principal),
      memberships: await this.membershipList(principal),
      migrations: await this.deps.store.listMigrationMarkers(),
      deployment: await this.deps.deploymentStatus?.(),
    };
  }

  projectList(principal: SuperadminPrincipal) {
    this.requireSuperadmin(principal);
    return this.deps.store.listProjects();
  }
  async projectGet(principal: SuperadminPrincipal, projectId: string) {
    this.requireSuperadmin(principal);
    return this.requireProject(projectId);
  }
  projectCreate(
    principal: SuperadminPrincipal,
    input: unknown,
    operationId: string,
  ) {
    return this.mutate(principal, "project_create", undefined, operationId, input, () =>
      this.deps.service.projectCreate(input, principal.actor, operationId),
    );
  }
  async projectUpdate(
    principal: SuperadminPrincipal,
    projectId: string,
    patch: unknown,
    operationId: string,
  ) {
    const data = projectUpdateSchema.parse(patch);
    return this.mutate(principal, "project_update", projectId, operationId, data, async () => {
      const current = await this.requireProject(projectId);
      if (
        data.autonomyMode === "AUTONOMOUS_PRODUCTION" ||
        current.environment === "PRODUCTION"
      )
        throw new UnsupportedOperation("Production writes are NOT_SUPPORTED");
      const updated:Project={...current,updatedAt:this.clock.now()};
      if(data.name!==undefined)updated.name=data.name;
      if(data.status!==undefined)updated.status=data.status;
      if(data.autonomyMode!==undefined)updated.autonomyMode=data.autonomyMode;
      if(data.sourceType!==undefined)updated.sourceType=data.sourceType;
      if(data.repository!==undefined){
        // Re-pointing the project's canonical repository must reference a real, ACTIVE,
        // project-owned GitHub repository resource -- the same invariant execution itself
        // enforces (repository-guard.ts) -- and the declared owner/name must actually match what
        // that resource is registered as, so this field can never drift from the resource it
        // claims to describe (which is exactly how it went stale for the prior repository).
        const resource=await requireProjectGithubRepository(this.deps.store,projectId,data.repository.resourceId);
        if(resource.externalReference!==`${data.repository.owner}/${data.repository.name}`)
          throw new PolicyViolation("repository owner/name does not match the referenced resource",{expected:resource.externalReference,actual:`${data.repository.owner}/${data.repository.name}`});
        updated.repository=data.repository;
      }
      return this.deps.store.updateProject(updated);
    });
  }
  async projectDelete(
    principal: SuperadminPrincipal,
    projectId: string,
    expectedSlug: string,
    input: unknown,
  ) {
    const data = confirmedDeleteSchema.parse(input);
    if (data.confirmation !== "ARCHIVE_PROJECT")
      throw new PolicyViolation("ARCHIVE_PROJECT confirmation is required");
    return this.mutate(principal, "project_delete", projectId, data.operationId, { expectedSlug, ...data }, async () => {
      const project = await this.requireProject(projectId);
      if (project.slug !== expectedSlug)
        throw new PolicyViolation("Project slug confirmation mismatch");
      const active = (await this.deps.store.listExecutionJobs(projectId)).filter(
        (value) => !["SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED", "TIMED_OUT"].includes(value.status),
      );
      if (active.length) throw new InvalidState("Project has active execution jobs");
      return this.deps.store.updateProject({
        ...project,
        status: "ARCHIVED",
        deletedAt: this.clock.now(),
        updatedAt: this.clock.now(),
      });
    });
  }

  async resourceList(principal: SuperadminPrincipal, projectId: string) {
    this.requireSuperadmin(principal);
    await this.requireProject(projectId);
    return this.deps.store.listResources(projectId);
  }
  async resourceGet(
    principal: SuperadminPrincipal,
    projectId: string,
    resourceId: string,
  ) {
    this.requireSuperadmin(principal);
    return this.requireResource(projectId, resourceId);
  }
  resourceCreate(
    principal: SuperadminPrincipal,
    input: unknown,
    operationId: string,
  ) {
    const parsed = z.object({ projectId: z.string().uuid(),type:z.string() }).passthrough().parse(input);
    const projectId = parsed.projectId;
    if (["GIT_REPOSITORY","GITHUB_REPOSITORY","GITHUB_ACCOUNT"].includes(parsed.type))
      throw new PolicyViolation("GitHub/Git bindings require the dedicated verified provider registration flow");
    return this.mutate(principal, "resource_create", projectId, operationId, input, () =>
      this.deps.service.resourceRegister(input, principal.actor, operationId),
    );
  }
  async resourceUpdate(
    principal: SuperadminPrincipal,
    projectId: string,
    resourceId: string,
    patch: unknown,
    operationId: string,
  ) {
    const data = resourceUpdateSchema.parse(patch);
    return this.mutate(principal, "resource_update", projectId, operationId, { resourceId, patch: data }, async () => {
      const project = await this.requireProject(projectId);
      const resource = await this.requireResource(projectId, resourceId);
      if (resource.environment === "PRODUCTION")
        throw new UnsupportedOperation("Production resource writes are NOT_SUPPORTED");
      await this.policy.authorize({
        project,
        action: "PROJECT_WRITE",
        actor: principal.actor,
      });
      const updated:Resource={...resource};
      if(data.status!==undefined)updated.status=data.status;
      if(data.permissions!==undefined)updated.permissions=data.permissions;
      if(data.secretRefs!==undefined)updated.secretRefs=data.secretRefs;
      return this.deps.store.updateResource(updated);
    });
  }
  async resourceBindingUpdate(
    principal: SuperadminPrincipal,
    projectId: string,
    resourceId: string,
    input: {
      operationId: string;
      expectedCurrentReference: string;
      newExternalReference: string;
      confirmation: "REBIND_NON_GIT_SANDBOX_RESOURCE";
      reason: string;
    },
  ) {
    return this.mutate(principal, "resource_binding_update", projectId, input.operationId, input, async () => {
      const resource = await this.requireResource(projectId, resourceId);
      if (["GIT_REPOSITORY", "GITHUB_REPOSITORY", "GITHUB_ACCOUNT"].includes(resource.type))
        throw new PolicyViolation("GitHub repository bindings cannot be changed through generic MCP input");
      if (resource.status !== "DISABLED")
        throw new InvalidState("Resource must be DISABLED before rebinding");
      if (resource.externalReference !== input.expectedCurrentReference)
        throw new PolicyViolation("Current resource binding confirmation mismatch");
      if (resource.environment === "PRODUCTION" || /:\/\/[^/@:]+:[^/@]+@/.test(input.newExternalReference))
        throw new UnsupportedOperation("Unsafe or production resource binding is forbidden");
      return this.deps.store.updateResource({
        ...resource,
        externalReference: input.newExternalReference,
      });
    });
  }
  async resourceDelete(
    principal: SuperadminPrincipal,
    projectId: string,
    resourceId: string,
    input: unknown,
  ) {
    const data = confirmedDeleteSchema.parse(input);
    if (data.confirmation !== "DELETE_RESOURCE")
      throw new PolicyViolation("DELETE_RESOURCE confirmation is required");
    return this.mutate(principal, "resource_delete", projectId, data.operationId, { resourceId, ...data }, async () => {
      const resource = await this.requireResource(projectId, resourceId);
      if (resource.status !== "DISABLED")
        throw new InvalidState("Resource must be DISABLED before deletion");
      return this.deps.store.updateResource({ ...resource, status: "DELETED" });
    });
  }

  async contextList(principal: SuperadminPrincipal, projectId: string) {
    this.requireSuperadmin(principal);
    await this.requireProject(projectId);
    return this.deps.store.listContexts(projectId);
  }
  async contextGet(principal: SuperadminPrincipal, projectId: string, contextId: string) {
    this.requireSuperadmin(principal);
    const value = await this.deps.store.getContext(projectId, contextId);
    if (!value) throw new NotFound("Project context not found");
    return value;
  }
  contextCreate(principal: SuperadminPrincipal, projectId: string, items: unknown[], operationId: string) {
    return this.mutate(principal, "context_create", projectId, operationId, { items }, () =>
      this.deps.service.contextImport(projectId, items as never[], principal.actor, operationId),
    );
  }
  async contextUpdate(principal: SuperadminPrincipal, projectId: string, contextId: string, items: unknown[], operationId: string) {
    return this.mutate(principal, "context_update", projectId, operationId, { contextId, items }, async () => {
      const current = await this.contextGet(principal, projectId, contextId);
      if (current.deletedAt) throw new InvalidState("Deleted context cannot be updated");
      return this.deps.service.contextImport(projectId, items as never[], principal.actor, operationId);
    });
  }
  async contextDelete(principal: SuperadminPrincipal, projectId: string, contextId: string, input: unknown) {
    const data = confirmedDeleteSchema.parse(input);
    if (data.confirmation !== "DELETE_CONTEXT") throw new PolicyViolation("DELETE_CONTEXT confirmation is required");
    return this.mutate(principal, "context_delete", projectId, data.operationId, { contextId, ...data }, async () => {
      const current = await this.contextGet(principal, projectId, contextId);
      return this.deps.store.updateContext({ ...current, deletedAt: this.clock.now() });
    });
  }

  async taskList(principal: SuperadminPrincipal, projectId: string) {
    this.requireSuperadmin(principal);
    await this.requireProject(projectId);
    return this.deps.store.listTasks(projectId);
  }
  async taskGet(principal: SuperadminPrincipal, projectId: string, taskId: string) {
    this.requireSuperadmin(principal);
    return this.requireTask(projectId, taskId);
  }
  taskCreate(principal: SuperadminPrincipal, input: unknown, operationId: string) {
    const projectId = z.object({ projectId: z.string().uuid() }).parse(input).projectId;
    return this.mutate(principal, "task_create", projectId, operationId, input, () =>
      this.deps.service.taskCreate(input, principal.actor, operationId),
    );
  }
  async taskUpdate(principal: SuperadminPrincipal, projectId: string, taskId: string, patch: unknown, operationId: string) {
    const data = taskUpdateSchema.parse(patch);
    return this.mutate(principal, "task_update", projectId, operationId, { taskId, patch: data }, async () => {
      const task = await this.requireTask(projectId, taskId);
      if (task.deletedAt) throw new InvalidState("Deleted task cannot be updated");
      if (!["INGESTED", "ANALYZING", "BLOCKED", "FAILED"].includes(task.state))
        throw new InvalidState("Requirements cannot change after planning; create a superseding task");
      const updated={...task,updatedAt:this.clock.now()};
      if(data.title!==undefined)updated.title=data.title;
      if(data.description!==undefined)updated.description=data.description;
      if(data.requirements!==undefined)updated.requirements=data.requirements;
      if(data.relationships!==undefined)updated.relationships=data.relationships;
      return this.deps.store.updateTask(updated);
    });
  }
  async taskTransition(principal: SuperadminPrincipal, projectId: string, taskId: string, to: TaskState, reason: string, operationId: string) {
    return this.mutate(principal, "task_transition", projectId, operationId, { taskId, to, reason }, async () => {
      const task = await this.requireTask(projectId, taskId);
      if (!lifecycleTargets[task.state].includes(to))
        throw new InvalidState(`Transition ${task.state} -> ${to} is not allowed`);
      if (to === "READY")
        throw new PolicyViolation("READY can only be reached through formal review gates");
      // ANALYZING is reachable by hand in the lifecycle table, but taskAnalyze is what writes the
      // REQUIREMENTS_SNAPSHOT the READY gate later demands. CORE-BE-11 was moved here manually to
      // route around an unrelated defect, silently skipped that artifact, and only found out at
      // the very end -- after a full implementation, test and review cycle had already run.
      if (to === "ANALYZING")
        throw new PolicyViolation("Use superadmin_task_analyze to enter ANALYZING", {
          blockingReport: {
            code: "ANALYZE_REQUIRED_FOR_ANALYZING",
            reason: "A manual transition into ANALYZING skips the REQUIREMENTS_SNAPSHOT that superadmin_task_analyze writes, and the READY gate rejects the task much later for missing it.",
            remediation: `Call superadmin_task_analyze for task ${taskId} instead. It performs this same transition and records the snapshot.`,
          },
        });
      return this.workflow.transition(task, to, reason, principal.actor);
    });
  }
  async taskDelete(principal: SuperadminPrincipal, projectId: string, taskId: string, input: unknown) {
    const data = confirmedDeleteSchema.parse(input);
    if (data.confirmation !== "DELETE_TASK") throw new PolicyViolation("DELETE_TASK confirmation is required");
    return this.mutate(principal, "task_delete", projectId, data.operationId, { taskId, ...data }, async () => {
      const task = await this.requireTask(projectId, taskId);
      if (!["INGESTED", "BLOCKED", "FAILED", "READY"].includes(task.state))
        throw new InvalidState("Only never-started or terminal tasks may be deleted");
      if ((await this.deps.store.listExecutionJobs(projectId, taskId)).some(value => !["SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED", "TIMED_OUT"].includes(value.status)))
        throw new InvalidState("Task has active execution jobs");
      return this.deps.store.updateTask({ ...task, deletedAt: this.clock.now(), updatedAt: this.clock.now() });
    });
  }

  async runList(principal: SuperadminPrincipal, projectId: string, taskId?: string) { this.requireSuperadmin(principal); return this.deps.store.listRuns(projectId, taskId); }
  async runGet(principal: SuperadminPrincipal, projectId: string, runId: string) { this.requireSuperadmin(principal); const value=await this.deps.store.getRun(projectId,runId);if(!value)throw new NotFound("Run not found");return value; }
  async runDelete(principal: SuperadminPrincipal, projectId:string,runId:string,input:unknown){const data=confirmedDeleteSchema.parse(input);if(data.confirmation!=="DELETE_RUN")throw new PolicyViolation("DELETE_RUN confirmation is required");return this.mutate(principal,"run_delete",projectId,data.operationId,{runId,...data},async()=>{const run=await this.runGet(principal,projectId,runId);if(run.status==="RUNNING")throw new InvalidState("Running run must be cancelled through its job");return this.deps.store.updateRun({...run,deletedAt:this.clock.now()});});}
  async jobList(principal: SuperadminPrincipal, projectId:string,taskId?:string){this.requireSuperadmin(principal);return this.deps.store.listExecutionJobs(projectId,taskId);}
  async jobGet(principal: SuperadminPrincipal,projectId:string,jobId:string){this.requireSuperadmin(principal);const value=await this.deps.store.getExecutionJob(projectId,jobId);if(!value)throw new NotFound("Execution job not found");return value;}
  jobCreate(principal:SuperadminPrincipal,input:unknown,resourceId:string|undefined,operationId:string){if(!this.deps.asyncExecution)throw new UnsupportedOperation("Remote execution dispatcher is unavailable");const parsed=z.object({projectId:z.string().uuid(),taskId:z.string().uuid(),changes:z.array(z.unknown())}).passthrough().parse(input);return this.mutate(principal,"job_create",parsed.projectId,operationId,{taskId:parsed.taskId,resourceId},()=>this.deps.asyncExecution!.enqueueImplementation({...parsed,operationId},resourceId,principal.actor));}
  async jobCancel(principal:SuperadminPrincipal,projectId:string,jobId:string,input:unknown){const data=confirmedDeleteSchema.parse(input);if(data.confirmation!=="CANCEL_JOB")throw new PolicyViolation("CANCEL_JOB confirmation is required");return this.mutate(principal,"job_cancel",projectId,data.operationId,{jobId,...data},async()=>{const job=await this.jobGet(principal,projectId,jobId);if(["SUCCEEDED","FAILED","CANCELLED","TIMED_OUT","BLOCKED"].includes(job.status))return job;const updated=await this.deps.store.updateExecutionJob({...job,status:"CANCELLED",finishedAt:this.clock.now(),updatedAt:this.clock.now(),error:{code:"SUPERADMIN_CANCELLED",reason:data.reason}});if(job.runId){const run=await this.deps.store.getRun(projectId,job.runId);if(run&&run.status==="RUNNING")await this.deps.store.updateRun({...run,status:"CANCELLED",finishedAt:this.clock.now()});}return updated;});}

  async artifactList(principal:SuperadminPrincipal,projectId:string,taskId?:string){this.requireSuperadmin(principal);return this.deps.store.listArtifacts(projectId,taskId);}
  async artifactGet(principal:SuperadminPrincipal,projectId:string,artifactId:string){this.requireSuperadmin(principal);const value=await this.deps.store.getArtifact(projectId,artifactId);if(!value)throw new NotFound("Artifact not found");return value;}
  // artifactGet returns the raw stored record, which is a `{externalized:true}` stub once content
  // is blob-backed (anything >=64KB — command stdout/stderr, large test reports). Mutation paths
  // (artifactUpdate/artifactDelete) need that raw record's storage metadata, so they keep calling
  // artifactGet directly; callers that actually want the content — the superadmin_artifact_get MCP
  // tool — must go through here instead, which dereferences the blob the same way the non-superadmin
  // artifact_read tool already does.
  async artifactRead(principal:SuperadminPrincipal,projectId:string,artifactId:string){this.requireSuperadmin(principal);return this.artifacts.read(projectId,artifactId);}
  artifactCreate(principal:SuperadminPrincipal,projectId:string,input:{kind:"ADMIN_NOTE"|"CONSOLE_SNAPSHOT";content:unknown;taskId?:string},operationId:string){return this.mutate(principal,"artifact_create",projectId,operationId,input,()=>this.artifacts.write(projectId,input.kind,input.content,input.taskId));}
  async artifactUpdate(principal:SuperadminPrincipal,projectId:string,artifactId:string,content:unknown,operationId:string){return this.mutate(principal,"artifact_update",projectId,operationId,{artifactId,content},async()=>{const artifact=await this.artifactGet(principal,projectId,artifactId);if(!administrativeArtifactKinds.has(artifact.kind))throw new PolicyViolation("Formal gate artifacts are immutable");return this.deps.store.updateArtifact({...artifact,content,contentHash:hash(content)});});}
  async artifactDelete(principal:SuperadminPrincipal,projectId:string,artifactId:string,input:unknown){const data=confirmedDeleteSchema.parse(input);if(data.confirmation!=="DELETE_ARTIFACT")throw new PolicyViolation("DELETE_ARTIFACT confirmation is required");return this.mutate(principal,"artifact_delete",projectId,data.operationId,{artifactId,...data},async()=>{const artifact=await this.artifactGet(principal,projectId,artifactId);return this.deps.store.updateArtifact({...artifact,status:"DELETED"});});}

  async scenarioList(principal:SuperadminPrincipal,projectId:string){return (await this.artifactList(principal,projectId)).filter(v=>v.kind==="VALIDATION_SCENARIO"&&v.status!=="DELETED");}
  async scenarioGet(principal:SuperadminPrincipal,projectId:string,id:string){const value=await this.artifactGet(principal,projectId,id);if(value.kind!=="VALIDATION_SCENARIO")throw new NotFound("Validation scenario not found");return value;}
  scenarioCreate(principal:SuperadminPrincipal,projectId:string,input:unknown,operationId:string){const value=validationScenarioSaveInputSchema.parse(input);return this.mutate(principal,"scenario_create",projectId,operationId,value,()=>this.artifacts.write(projectId,"VALIDATION_SCENARIO",{...scenarioForStorage(value),createdAt:this.clock.now()},value.taskId));}
  async scenarioUpdate(principal:SuperadminPrincipal,projectId:string,id:string,input:unknown,operationId:string){const value=validationScenarioSaveInputSchema.parse(input);return this.mutate(principal,"scenario_update",projectId,operationId,{id,value},async()=>{const current=await this.scenarioGet(principal,projectId,id);const content={...scenarioForStorage(value),updatedAt:this.clock.now()};return this.deps.store.updateArtifact({...current,taskId:value.taskId,content,contentHash:hash(content)});});}
  async scenarioDelete(principal:SuperadminPrincipal,projectId:string,id:string,input:unknown){const data=confirmedDeleteSchema.parse(input);if(data.confirmation!=="DELETE_SCENARIO")throw new PolicyViolation("DELETE_SCENARIO confirmation is required");return this.mutate(principal,"scenario_delete",projectId,data.operationId,{id,...data},async()=>{const current=await this.scenarioGet(principal,projectId,id);return this.deps.store.updateArtifact({...current,status:"DELETED"});});}

  // Executes a persisted scenario as real HTTP requests. The caller supplies only the saved
  // scenario ID: the HTTP_API resource, base URL, steps, extractions and bearer handoff all
  // come from the stored definition, so no tool input can retarget the request. Wrapped in
  // mutate() so it inherits SUPERADMIN enforcement, operationId replay protection, production
  // denial and the immutable mcp.scenario_run audit event.
  scenarioRun(principal:SuperadminPrincipal,projectId:string,input:{scenarioId:string;operationId:string}){
    return this.mutate(principal,"scenario_run",projectId,input.operationId,{scenarioId:input.scenarioId},():Promise<ScenarioExecutionResult>=>new HttpScenarioRunner({
      store:this.deps.store,
      artifacts:this.artifacts,
      clock:this.clock,
      ...(this.deps.secrets?{secrets:this.deps.secrets}:{}),
      ...(this.deps.fetchImpl?{fetchImpl:this.deps.fetchImpl}:{}),
    }).run({projectId,scenarioId:input.scenarioId,operationId:input.operationId,actor:principal.actor}));
  }

  // Transfers an already-verified task onto the repository's current base branch after its
  // dependency was merged and its pull request went stale. Everything that identifies WHAT is
  // moved -- branch, verified commit, original base, manifest -- is resolved server-side from
  // durable evidence by resolveRebasePlan; the caller only names the task and repository. The
  // task keeps its identity and plan and is re-verified, never recreated.
  async taskRebaseOntoCurrentBase(principal:SuperadminPrincipal,input:{projectId:string;taskId:string;resourceId:string;operationId:string;resolutions?:Array<{path:string;content:string}>}){
    return this.mutate(principal,"task_rebase_onto_current_base",input.projectId,input.operationId,{taskId:input.taskId,resourceId:input.resourceId,resolvedPaths:(input.resolutions??[]).map(value=>value.path)},async()=>{
      if(!this.deps.asyncExecution)throw new UnsupportedOperation("Asynchronous execution is not configured");
      const [task,resource,runs,artifacts,jobs]=await Promise.all([
        this.deps.store.getTask(input.projectId,input.taskId),
        this.requireResource(input.projectId,input.resourceId),
        this.deps.store.listRuns(input.projectId,input.taskId),
        this.deps.store.listArtifacts(input.projectId,input.taskId),
        this.deps.store.listExecutionJobs(input.projectId,input.taskId),
      ]);
      const plan=resolveRebasePlan({...(task?{task}:{}),resource,runs,artifacts,rebaseInProgress:jobs.some(job=>job.kind==='REBASE')});
      return this.deps.asyncExecution.enqueueRebase({projectId:input.projectId,taskId:input.taskId,operationId:input.operationId,resolutions:input.resolutions??[]},input.resourceId,plan,principal.actor);
    });
  }

  async validationList(principal:SuperadminPrincipal,projectId:string,taskId?:string){return (await this.artifactList(principal,projectId,taskId)).filter(v=>v.kind==="VALIDATION_REPORT"&&v.status!=="DELETED");}
  async validationGet(principal:SuperadminPrincipal,projectId:string,id:string){const value=await this.artifactGet(principal,projectId,id);if(value.kind!=="VALIDATION_REPORT")throw new NotFound("Validation result not found");return value;}
  validationRun(principal:SuperadminPrincipal,projectId:string,input:{taskId:string;suite:string;operationId:string}){const suite=validationSuiteSchema.parse(input.suite);return this.mutate(principal,"validation_run",projectId,input.operationId,input,async()=>{const task=await this.requireTask(projectId,input.taskId);const [artifacts,jobs,runs]=await Promise.all([this.deps.store.listArtifacts(projectId,task.id),this.deps.store.listExecutionJobs(projectId,task.id),this.deps.store.listRuns(projectId,task.id)]);const checks={taskExists:true,productionWritesDisabled:true,noActiveFailedJob:!jobs.some(v=>v.status==="FAILED"),formalReadyGates:task.state!=="READY"||["REQUIREMENTS_SNAPSHOT","IMPLEMENTATION_PLAN","ARCHITECTURE_REVIEW","TEST_REPORT","SECURITY_REPORT","REVIEW_REPORT","FINAL_CHANGE_MANIFEST"].every(kind=>artifacts.some(v=>v.kind===kind&&v.status==="AVAILABLE")),runEvidence:task.state==="INGESTED"||runs.length>0};const passed=Object.values(checks).every(Boolean);return this.artifacts.write(projectId,"VALIDATION_REPORT",{suite,operationId:input.operationId,result:passed?"PASS":"FAIL",checks,taskState:task.state,createdAt:this.clock.now()},task.id);});}
  async validationDelete(principal:SuperadminPrincipal,projectId:string,id:string,input:unknown){const data=confirmedDeleteSchema.parse(input);if(data.confirmation!=="DELETE_VALIDATION")throw new PolicyViolation("DELETE_VALIDATION confirmation is required");return this.mutate(principal,"validation_delete",projectId,data.operationId,{id,...data},async()=>{const current=await this.validationGet(principal,projectId,id);return this.deps.store.updateArtifact({...current,status:"DELETED"});});}

  settingsList(principal:SuperadminPrincipal){this.requireSuperadmin(principal);return this.deps.store.listSystemSettings();}
  async settingGet(principal:SuperadminPrincipal,key:string){this.requireSuperadmin(principal);const value=await this.deps.store.getSystemSetting(key);if(!value)throw new NotFound("System setting not found");return value;}
  settingUpsert(principal:SuperadminPrincipal,input:unknown,operationId:string){const value=systemSettingUpsertSchema.parse(input);if(value.key.startsWith("safety.")&&value.key!=="safety.production_writes")throw new PolicyViolation("Unknown safety setting");if(value.key==="safety.production_writes"&&value.value!=="NOT_SUPPORTED")throw new UnsupportedOperation("Production writes remain NOT_SUPPORTED");return this.mutate(principal,"setting_upsert",undefined,operationId,value,()=>{const now=this.clock.now();return this.deps.store.upsertSystemSetting({...value,updatedAt:now,updatedBy:principal.actor});});}
  async settingDelete(principal:SuperadminPrincipal,key:string,input:unknown){const data=confirmedDeleteSchema.parse(input);if(data.confirmation!=="DELETE_SETTING")throw new PolicyViolation("DELETE_SETTING confirmation is required");if(key.startsWith("safety."))throw new PolicyViolation("Safety settings cannot be deleted");return this.mutate(principal,"setting_delete",undefined,data.operationId,{key,...data},async()=>{await this.deps.store.deleteSystemSetting(key);return {key,deleted:true};});}
  screenList(principal:SuperadminPrincipal){this.requireSuperadmin(principal);return this.deps.store.listConsoleScreens();}
  async screenGet(principal:SuperadminPrincipal,id:string){this.requireSuperadmin(principal);const value=await this.deps.store.getConsoleScreen(id);if(!value)throw new NotFound("Console screen not found");return value;}
  screenUpsert(principal:SuperadminPrincipal,input:unknown,operationId:string){const value=consoleScreenUpsertSchema.parse(input);return this.mutate(principal,"screen_upsert",undefined,operationId,value,()=>this.deps.store.upsertConsoleScreen({...value,updatedAt:this.clock.now(),updatedBy:principal.actor}));}
  async screenDelete(principal:SuperadminPrincipal,id:string,input:unknown){const data=confirmedDeleteSchema.parse(input);if(data.confirmation!=="DELETE_SCREEN")throw new PolicyViolation("DELETE_SCREEN confirmation is required");if(["dashboard","settings"].includes(id))throw new PolicyViolation("Core safety screens cannot be deleted");return this.mutate(principal,"screen_delete",undefined,data.operationId,{id,...data},async()=>{await this.deps.store.deleteConsoleScreen(id);return {screenId:id,deleted:true};});}

  operatorList(principal:SuperadminPrincipal){this.requireSuperadmin(principal);return this.deps.store.listOperators();}
  async operatorGet(principal:SuperadminPrincipal,id:string){this.requireSuperadmin(principal);const value=await this.deps.store.getOperator(id);if(!value)throw new NotFound("Operator not found");return value;}
  operatorUpsert(principal:SuperadminPrincipal,input:unknown,operationId:string){const parsed=operatorSchema.omit({createdAt:true,updatedAt:true}).parse(input);return this.mutate(principal,"operator_upsert",undefined,operationId,parsed,async()=>{const current=await this.deps.store.getOperator(parsed.userId);const now=this.clock.now();return this.deps.store.upsertOperator({...parsed,createdAt:current?.createdAt??now,updatedAt:now});});}
  async operatorDelete(principal:SuperadminPrincipal,userId:string,input:unknown){const data=confirmedDeleteSchema.parse(input);if(data.confirmation!=="DELETE_OPERATOR")throw new PolicyViolation("DELETE_OPERATOR confirmation is required");return this.mutate(principal,"operator_delete",undefined,data.operationId,{userId,...data},async()=>{const current=await this.operatorGet(principal,userId);if(current.role==="SUPERADMIN"&&(await this.deps.store.listOperators()).filter(value=>value.role==="SUPERADMIN"&&value.status==="ACTIVE").length<=1)throw new PolicyViolation("The last active SUPERADMIN cannot be deleted");await this.deps.store.deleteOperator(userId);return {userId,deleted:true};});}
  membershipList(principal:SuperadminPrincipal,projectId?:string,userId?:string){this.requireSuperadmin(principal);return this.deps.store.listMemberships(projectId,userId);}
  async membershipGet(principal:SuperadminPrincipal,userId:string,projectId:string){this.requireSuperadmin(principal);const value=await this.deps.store.getMembership(userId,projectId);if(!value)throw new NotFound("Project membership not found");return value;}
  membershipUpsert(principal:SuperadminPrincipal,input:unknown,operationId:string){const parsed=projectMembershipSchema.omit({createdAt:true,updatedAt:true}).parse(input);return this.mutate(principal,"membership_upsert",parsed.projectId,operationId,parsed,async()=>{await this.requireProject(parsed.projectId);await this.operatorGet(principal,parsed.userId);const current=await this.deps.store.getMembership(parsed.userId,parsed.projectId),now=this.clock.now();return this.deps.store.upsertMembership({...parsed,createdAt:current?.createdAt??now,updatedAt:now});});}
  async membershipDelete(principal:SuperadminPrincipal,userId:string,projectId:string,input:unknown){const data=confirmedDeleteSchema.parse(input);if(data.confirmation!=="DELETE_MEMBERSHIP")throw new PolicyViolation("DELETE_MEMBERSHIP confirmation is required");return this.mutate(principal,"membership_delete",projectId,data.operationId,{userId,...data},async()=>{await this.membershipGet(principal,userId,projectId);await this.deps.store.deleteMembership(userId,projectId);return {userId,projectId,deleted:true};});}
  async auditList(principal:SuperadminPrincipal,projectId:string){this.requireSuperadmin(principal);return this.deps.store.listAudit(projectId);}
  async auditGet(principal:SuperadminPrincipal,projectId:string,id:string){this.requireSuperadmin(principal);const value=await this.deps.store.getAudit(projectId,id);if(!value)throw new NotFound("Audit event not found");return value;}

  // ------------------------------------------------------------------------
  // Canonical Development Repository
  //
  // Promotion assigns an already-registered repository the role of "the project's one source of
  // further development". It copies no Git, creates no repository, renames nothing and changes no
  // organization. Export is the separate operation that moves history, and a successful export
  // never makes its target canonical on its own -- that stays an explicit second decision.
  // ------------------------------------------------------------------------

  /** Read-only. Current binding plus the full append-only history of what was canonical when. */
  async canonicalRepositoryGet(principal: SuperadminPrincipal, projectId: string) {
    this.requireSuperadmin(principal);
    await this.requireProject(projectId);
    return this.canonical.get(projectId);
  }

  /**
   * Read-only dry run. Reports the exact change a promotion would make, every blocker with a
   * remediation, and the pinned values the mutation must carry. It writes nothing, dispatches
   * nothing and has no side effect of any kind.
   */
  async canonicalRepositoryPlan(principal: SuperadminPrincipal, projectId: string, resourceId: string) {
    this.requireSuperadmin(principal);
    await this.requireProject(projectId);
    return this.canonical.plan({ projectId, resourceId });
  }

  canonicalRepositoryPromote(principal: SuperadminPrincipal, input: unknown) {
    const data = canonicalRepositoryPromoteInputSchema.parse(input);
    return this.mutate(principal, "canonical_repository_promote", data.projectId, data.operationId, { resourceId: data.resourceId, expectedHeadSha: data.expectedHeadSha, expectedCurrentCanonicalVersion: data.expectedCurrentCanonicalVersion, reason: data.reason }, () =>
      this.canonical.promote(data, principal.actor),
    );
  }

  /** Restores the previous BINDING. Never deletes a repository, force-pushes or rewrites history. */
  canonicalRepositoryRollback(principal: SuperadminPrincipal, input: unknown) {
    const data = canonicalRepositoryRollbackInputSchema.parse(input);
    return this.mutate(principal, "canonical_repository_rollback", data.projectId, data.operationId, { expectedCurrentCanonicalVersion: data.expectedCurrentCanonicalVersion, reason: data.reason }, () =>
      this.canonical.rollback(data, principal.actor),
    );
  }

  /**
   * Read-only dry run for renaming the repository a project is registered against. Reports the
   * identity that would have to be preserved, everything that would block, and the exact changes.
   */
  async repositoryRenamePlan(principal: SuperadminPrincipal, projectId: string, resourceId: string, newName: string) {
    this.requireSuperadmin(principal);
    await this.requireProject(projectId);
    return this.canonical.renamePlan({ projectId, resourceId, newName });
  }

  /**
   * Renames a registered repository in place and re-points its registration. This is the single
   * exception to "GitHub repository bindings cannot be changed through generic MCP input", and it
   * earns the exception by proving the repository object, default branch and head commit are
   * unchanged across the rename. Nothing else can move a GITHUB_REPOSITORY binding.
   */
  repositoryRename(principal: SuperadminPrincipal, input: unknown) {
    const data = repositoryRenameInputSchema.parse(input);
    return this.mutate(principal, "repository_rename", data.projectId, data.operationId, { resourceId: data.resourceId, expectedCurrentReference: data.expectedCurrentReference, newName: data.newName, expectedHeadSha: data.expectedHeadSha, reason: data.reason }, () =>
      this.canonical.renameRepository(data, principal.actor),
    );
  }

  /** Read-only. Describes the Git transfer as an engineering object, never as a file archive. */
  async repositoryExportPlan(principal: SuperadminPrincipal, projectId: string, sourceResourceId: string, targetResourceId: string) {
    this.requireSuperadmin(principal);
    await this.requireProject(projectId);
    return this.canonical.exportPlan({ projectId, sourceResourceId, targetResourceId });
  }

  repositoryExport(principal: SuperadminPrincipal, input: unknown) {
    const data = repositoryExportInputSchema.parse(input);
    return this.mutate(principal, "repository_export", data.projectId, data.operationId, { sourceResourceId: data.sourceResourceId, targetResourceId: data.targetResourceId, expectedSourceHeadSha: data.expectedSourceHeadSha, reason: data.reason }, () =>
      this.canonical.exportRepository(data, principal.actor),
    );
  }

  repositoryExportVerify(principal: SuperadminPrincipal, input: unknown) {
    const data = z.object({ projectId: z.string().uuid(), sourceResourceId: z.string().uuid(), targetResourceId: z.string().uuid(), operationId: operationIdSchema }).parse(input);
    return this.mutate(principal, "repository_export_verify", data.projectId, data.operationId, data, () =>
      this.canonical.exportVerify({ ...data, persist: true }, principal.actor),
    );
  }

  /**
   * Machine-checkable developer handover readiness. Read-only unless `operationId` is supplied, in
   * which case the report is persisted as a terminal DEVELOPER_HANDOVER_REPORT artifact.
   */
  async developerHandoverReport(principal: SuperadminPrincipal, projectId: string, operationId?: string) {
    this.requireSuperadmin(principal);
    await this.requireProject(projectId);
    if (!operationId) return this.canonical.handoverReport({ projectId }, principal.actor);
    // Unwrapped deliberately: persisting is a side effect of the same question, so the answer keeps
    // one shape whether or not an operationId was supplied. A replay returns the stored report.
    const outcome = await this.mutate(principal, "developer_handover_report", projectId, operationId, { projectId }, () =>
      this.canonical.handoverReport({ projectId, persist: true, operationId }, principal.actor),
    );
    return outcome.value as DeveloperHandoverReport;
  }

  private requireSuperadmin(principal: SuperadminPrincipal) {
    if (principal.role !== "SUPERADMIN")
      throw new PolicyViolation("SUPERADMIN role is required");
  }
  private async requireProject(id:string){const value=await this.deps.store.getProject(id);if(!value)throw new NotFound("Project not found",{projectId:id});return value;}
  private async requireTask(projectId:string,id:string){const value=await this.deps.store.getTask(projectId,id);if(!value)throw new NotFound("Task not found",{projectId,taskId:id});return value;}
  private async requireResource(projectId:string,id:string){const value=await this.deps.store.getResource(id);if(!value||value.projectId!==projectId)throw new NotFound("Project resource not found",{projectId,resourceId:id});return value;}
  private async mutate<T>(principal:SuperadminPrincipal,tool:string,projectId:string|undefined,operationId:string,input:unknown,action:()=>Promise<T>):Promise<{value:T|unknown;idempotentReplay:boolean}> {
    this.requireSuperadmin(principal);operationIdSchema.parse(operationId);
    const existing=await this.deps.store.getAdminOperation(operationId);
    if(existing){if(existing.actor!==principal.actor||existing.tool!==tool||existing.projectId!==projectId)throw new Conflict("Admin operation ID was already used for a different mutation");return {value:existing.result,idempotentReplay:true};}
    if(projectId){const project=await this.requireProject(projectId);if(project.environment==="PRODUCTION"||project.autonomyMode==="AUTONOMOUS_PRODUCTION")throw new UnsupportedOperation("Production writes are NOT_SUPPORTED");}
    const value=await action();const safeResult=redact(value);
    await this.deps.store.saveAdminOperation({operationId,actor:principal.actor,tool,...(projectId?{projectId}:{}),result:safeResult,createdAt:this.clock.now()});
    await this.audit.record({actor:principal.actor,action:`mcp.${tool}` ,projectId:projectId??this.deps.systemProjectId,input:{tool,operationId,payload:input},result:safeResult,reason:`Authorized SUPERADMIN semantic MCP mutation: ${tool}`,correlationId:operationId,...(principal.authMethod?{authMethod:principal.authMethod}:{})});
    return {value,idempotentReplay:false};
  }
}

function hash(value:unknown){return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
