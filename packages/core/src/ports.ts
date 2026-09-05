import type { AdminOperation, Artifact, AuditEvent, CanonicalDevelopmentRepository, CommandRecord, ConsoleScreen, ExecutionJob, FileChange, ImplementationPlan, MigrationMarker, Operator, Project, ProjectContext, ProjectMembership, Resource, Run, SystemSetting, Task, TestReport, Transition } from '../../schemas/src/index.js';

/**
 * One durable, atomic canonical-binding replacement. Both promotion and metadata rollback go
 * through this single primitive so the "at most one ACTIVE canonical repository per project"
 * invariant has exactly one enforcement point rather than one per caller.
 *
 * `expectedCurrent` is the optimistic lock: `undefined` asserts that the project currently has no
 * ACTIVE binding at all, and any other value must match the ACTIVE row's id AND version. A store
 * that cannot satisfy the assertion must throw `Conflict` rather than write -- an application-level
 * read/check/write cannot survive two concurrent promotions, which is why the PostgreSQL stores
 * back this with a partial unique index on (project_id) WHERE status='ACTIVE' as well.
 */
export interface CanonicalPromotionRequest {
  projectId:string;
  /** The new binding, already built with status ACTIVE and the next version number. */
  record:CanonicalDevelopmentRepository;
  expectedCurrent?:{id:string;version:number};
  /** What the displaced binding becomes: replaced by a promotion, or undone by a rollback. */
  displacedStatus:'SUPERSEDED'|'ROLLED_BACK';
  displacedAt:string;
}

/**
 * An artifact stripped of its `content`. The console overview needs per-task artifact COUNTS and
 * nothing else about most artifacts, but an artifact's content is inline in the same row up to the
 * 64 KB externalization threshold -- so asking for artifacts in order to count them transfers the
 * project's entire recorded output. Stores back this with a projection that never reads the
 * content at all.
 */
export interface ArtifactDigest {
  id:string;
  projectId:string;
  taskId?:string|undefined;
  runId?:string|undefined;
  kind?:string|undefined;
  createdAt:string;
}

/**
 * An execution job without its three unbounded fields. `payload`, `result` and `error` hold whole
 * task inputs and whole run outputs: on the control plane's own project they average 29 kB per row
 * and reach 202 kB, so listing 172 jobs to read their statuses moved 5 MB. Every field kept here is
 * a real indexed column, so a store can satisfy this without reading the `data` document at all.
 */
export interface ExecutionJobSummary {
  id:string;
  projectId:string;
  taskId:string;
  resourceId:string;
  runId?:string|undefined;
  operationId:string;
  kind:string;
  status:string;
  attempt:number;
  workflowRunId?:string|undefined;
  leaseOwner?:string|undefined;
  leaseExpiresAt?:string|undefined;
  queuedAt:string;
  updatedAt:string;
}

export interface StateStore {
  createProject(project:Project):Promise<Project>; updateProject(project:Project):Promise<Project>; getProject(id:string):Promise<Project|undefined>; listProjects():Promise<Project[]>;
  createResource(resource:Resource):Promise<Resource>; updateResource(resource:Resource):Promise<Resource>; getResource(id:string):Promise<Resource|undefined>; findResource(projectId:string,externalReference:string):Promise<Resource|undefined>; listResources(projectId:string):Promise<Resource[]>;
  saveContext(context:ProjectContext):Promise<ProjectContext>; updateContext(context:ProjectContext):Promise<ProjectContext>; getContext(projectId:string,id:string):Promise<ProjectContext|undefined>; getLatestContext(projectId:string):Promise<ProjectContext|undefined>; listContexts(projectId:string):Promise<ProjectContext[]>;
  createTask(task:Task):Promise<Task>; updateTask(task:Task):Promise<Task>; getTask(projectId:string,taskId:string):Promise<Task|undefined>; listTasks(projectId:string):Promise<Task[]>;
  saveArtifact(artifact:Artifact):Promise<Artifact>; updateArtifact(artifact:Artifact):Promise<Artifact>; getArtifact(projectId:string,id:string):Promise<Artifact|undefined>; listArtifacts(projectId:string,taskId?:string):Promise<Artifact[]>;
  /**
   * Bounded reads for views that summarise a project rather than export it. `listArtifacts` and
   * `listAudit` are unbounded and carry every artifact's inline content and every audit event's
   * full input/result payload; a view that polls must never use them. See `overview` in
   * supabase/functions/control-api/index.ts for what this replaced and why.
   */
  listArtifactDigests(projectId:string):Promise<ArtifactDigest[]>;
  latestArtifactOfKind(projectId:string,kind:string):Promise<Artifact|undefined>;
  saveRun(run:Run):Promise<Run>; updateRun(run:Run):Promise<Run>; getRun(projectId:string,id:string):Promise<Run|undefined>; findRunByOperation(projectId:string,operationId:string):Promise<Run|undefined>; listRuns(projectId:string,taskId?:string):Promise<Run[]>;
  createExecutionJob(job:ExecutionJob):Promise<ExecutionJob>; updateExecutionJob(job:ExecutionJob):Promise<ExecutionJob>; getExecutionJob(projectId:string,id:string):Promise<ExecutionJob|undefined>; getExecutionJobById(id:string):Promise<ExecutionJob|undefined>; findExecutionJobByOperation(projectId:string,operationId:string):Promise<ExecutionJob|undefined>; listExecutionJobs(projectId:string,taskId?:string):Promise<ExecutionJob[]>;
  /** Statuses without payloads. See ExecutionJobSummary for why listing full jobs is not viable. */
  listExecutionJobSummaries(projectId:string,taskId?:string):Promise<ExecutionJobSummary[]>;
  claimExecutionJob(projectId:string,id:string,leaseOwner:string,leaseExpiresAt:string,now:string):Promise<ExecutionJob|undefined>;
  transitionTask(task:Task,transition:Transition):Promise<Task>;
  appendTransition(transition:Transition):Promise<void>; listTransitions(taskId:string):Promise<Transition[]>;
  appendAudit(event:AuditEvent):Promise<void>; getAudit(projectId:string,id:string):Promise<AuditEvent|undefined>; listAudit(projectId:string):Promise<AuditEvent[]>;
  /** The `limit` newest audit events for a project, newest first. */
  listRecentAudit(projectId:string,limit:number):Promise<AuditEvent[]>;
  upsertSystemSetting(value:SystemSetting):Promise<SystemSetting>; getSystemSetting(key:string):Promise<SystemSetting|undefined>; listSystemSettings():Promise<SystemSetting[]>; deleteSystemSetting(key:string):Promise<void>;
  upsertConsoleScreen(value:ConsoleScreen):Promise<ConsoleScreen>; getConsoleScreen(screenId:string):Promise<ConsoleScreen|undefined>; listConsoleScreens():Promise<ConsoleScreen[]>; deleteConsoleScreen(screenId:string):Promise<void>;
  upsertOperator(value:Operator):Promise<Operator>; getOperator(userId:string):Promise<Operator|undefined>; listOperators():Promise<Operator[]>; deleteOperator(userId:string):Promise<void>;
  upsertMembership(value:ProjectMembership):Promise<ProjectMembership>; getMembership(userId:string,projectId:string):Promise<ProjectMembership|undefined>; listMemberships(projectId?:string,userId?:string):Promise<ProjectMembership[]>; deleteMembership(userId:string,projectId:string):Promise<void>;
  saveAdminOperation(value:AdminOperation):Promise<AdminOperation>; getAdminOperation(operationId:string):Promise<AdminOperation|undefined>; listAdminOperations():Promise<AdminOperation[]>;
  listMigrationMarkers():Promise<MigrationMarker[]>;
  getCanonicalRepository(projectId:string,id:string):Promise<CanonicalDevelopmentRepository|undefined>;
  getActiveCanonicalRepository(projectId:string):Promise<CanonicalDevelopmentRepository|undefined>;
  listCanonicalRepositories(projectId:string):Promise<CanonicalDevelopmentRepository[]>;
  promoteCanonicalRepository(request:CanonicalPromotionRequest):Promise<{active:CanonicalDevelopmentRepository;displaced?:CanonicalDevelopmentRepository}>;
}

export interface Clock { now():string; }
export const systemClock:Clock={now:()=>new Date().toISOString()};
export interface IdGenerator { next():string; }
export const uuidGenerator:IdGenerator={next:()=>crypto.randomUUID()};

export interface GitWorkspaceAdapter {
  snapshot(cwd:string,taskId:string):Promise<{baseCommit:string;branch:string;clean:boolean}>; branch(cwd:string,taskId:string,name:string):Promise<void>;
  stage(cwd:string,taskId:string):Promise<void>; diff(cwd:string,taskId:string,baseCommit?:string):Promise<string>; commit(cwd:string,taskId:string,message:string):Promise<string>;
}
export interface ImplementationExecutor {execute(input:{workspace:string;task:Task;changes:FileChange[]}):Promise<{baseCommit:string;branch:string;commitSha:string;diff:string;changedFiles:string[];completedAt:string}>;}
export interface TestExecutor {run(workspace:string,taskId:string,plan:ImplementationPlan):Promise<TestReport>;}
export interface CommandJournal {drain(taskId:string):{record:CommandRecord;stdout:string;stderr:string}[];}
export interface ArtifactBlobStore {
  put(input:{projectId:string;artifactId:string;body:string;contentType:string}):Promise<{provider:string;bucket:string;path:string;contentType:string;size:number}>;
  get(reference:{provider:string;bucket:string;path:string;contentType:string;size:number}):Promise<string>;
}
