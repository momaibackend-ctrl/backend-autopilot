import type { AdminOperation, Artifact, AuditEvent, CommandRecord, ConsoleScreen, ExecutionJob, FileChange, ImplementationPlan, MigrationMarker, Operator, Project, ProjectContext, ProjectMembership, Resource, Run, SystemSetting, Task, TestReport, Transition } from '../../schemas/src/index.js';

export interface StateStore {
  createProject(project:Project):Promise<Project>; updateProject(project:Project):Promise<Project>; getProject(id:string):Promise<Project|undefined>; listProjects():Promise<Project[]>;
  createResource(resource:Resource):Promise<Resource>; updateResource(resource:Resource):Promise<Resource>; getResource(id:string):Promise<Resource|undefined>; findResource(projectId:string,externalReference:string):Promise<Resource|undefined>; listResources(projectId:string):Promise<Resource[]>;
  saveContext(context:ProjectContext):Promise<ProjectContext>; updateContext(context:ProjectContext):Promise<ProjectContext>; getContext(projectId:string,id:string):Promise<ProjectContext|undefined>; getLatestContext(projectId:string):Promise<ProjectContext|undefined>; listContexts(projectId:string):Promise<ProjectContext[]>;
  createTask(task:Task):Promise<Task>; updateTask(task:Task):Promise<Task>; getTask(projectId:string,taskId:string):Promise<Task|undefined>; listTasks(projectId:string):Promise<Task[]>;
  saveArtifact(artifact:Artifact):Promise<Artifact>; updateArtifact(artifact:Artifact):Promise<Artifact>; getArtifact(projectId:string,id:string):Promise<Artifact|undefined>; listArtifacts(projectId:string,taskId?:string):Promise<Artifact[]>;
  saveRun(run:Run):Promise<Run>; updateRun(run:Run):Promise<Run>; getRun(projectId:string,id:string):Promise<Run|undefined>; findRunByOperation(projectId:string,operationId:string):Promise<Run|undefined>; listRuns(projectId:string,taskId?:string):Promise<Run[]>;
  createExecutionJob(job:ExecutionJob):Promise<ExecutionJob>; updateExecutionJob(job:ExecutionJob):Promise<ExecutionJob>; getExecutionJob(projectId:string,id:string):Promise<ExecutionJob|undefined>; getExecutionJobById(id:string):Promise<ExecutionJob|undefined>; findExecutionJobByOperation(projectId:string,operationId:string):Promise<ExecutionJob|undefined>; listExecutionJobs(projectId:string,taskId?:string):Promise<ExecutionJob[]>;
  claimExecutionJob(projectId:string,id:string,leaseOwner:string,leaseExpiresAt:string,now:string):Promise<ExecutionJob|undefined>;
  transitionTask(task:Task,transition:Transition):Promise<Task>;
  appendTransition(transition:Transition):Promise<void>; listTransitions(taskId:string):Promise<Transition[]>;
  appendAudit(event:AuditEvent):Promise<void>; getAudit(projectId:string,id:string):Promise<AuditEvent|undefined>; listAudit(projectId:string):Promise<AuditEvent[]>;
  upsertSystemSetting(value:SystemSetting):Promise<SystemSetting>; getSystemSetting(key:string):Promise<SystemSetting|undefined>; listSystemSettings():Promise<SystemSetting[]>; deleteSystemSetting(key:string):Promise<void>;
  upsertConsoleScreen(value:ConsoleScreen):Promise<ConsoleScreen>; getConsoleScreen(screenId:string):Promise<ConsoleScreen|undefined>; listConsoleScreens():Promise<ConsoleScreen[]>; deleteConsoleScreen(screenId:string):Promise<void>;
  upsertOperator(value:Operator):Promise<Operator>; getOperator(userId:string):Promise<Operator|undefined>; listOperators():Promise<Operator[]>; deleteOperator(userId:string):Promise<void>;
  upsertMembership(value:ProjectMembership):Promise<ProjectMembership>; getMembership(userId:string,projectId:string):Promise<ProjectMembership|undefined>; listMemberships(projectId?:string,userId?:string):Promise<ProjectMembership[]>; deleteMembership(userId:string,projectId:string):Promise<void>;
  saveAdminOperation(value:AdminOperation):Promise<AdminOperation>; getAdminOperation(operationId:string):Promise<AdminOperation|undefined>; listAdminOperations():Promise<AdminOperation[]>;
  listMigrationMarkers():Promise<MigrationMarker[]>;
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
