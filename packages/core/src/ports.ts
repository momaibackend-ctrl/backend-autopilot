import type { Artifact, AuditEvent, CommandRecord, FileChange, ImplementationPlan, Project, ProjectContext, Resource, Run, Task, TestReport, Transition } from '../../schemas/src/index.js';

export interface StateStore {
  createProject(project:Project):Promise<Project>; getProject(id:string):Promise<Project|undefined>; listProjects():Promise<Project[]>;
  createResource(resource:Resource):Promise<Resource>; getResource(id:string):Promise<Resource|undefined>; findResource(projectId:string,externalReference:string):Promise<Resource|undefined>; listResources(projectId:string):Promise<Resource[]>;
  saveContext(context:ProjectContext):Promise<ProjectContext>; getLatestContext(projectId:string):Promise<ProjectContext|undefined>;
  createTask(task:Task):Promise<Task>; updateTask(task:Task):Promise<Task>; getTask(projectId:string,taskId:string):Promise<Task|undefined>; listTasks(projectId:string):Promise<Task[]>;
  saveArtifact(artifact:Artifact):Promise<Artifact>; getArtifact(projectId:string,id:string):Promise<Artifact|undefined>; listArtifacts(projectId:string,taskId?:string):Promise<Artifact[]>;
  saveRun(run:Run):Promise<Run>; updateRun(run:Run):Promise<Run>; getRun(projectId:string,id:string):Promise<Run|undefined>; findRunByOperation(projectId:string,operationId:string):Promise<Run|undefined>; listRuns(projectId:string,taskId?:string):Promise<Run[]>;
  appendTransition(transition:Transition):Promise<void>; listTransitions(taskId:string):Promise<Transition[]>;
  appendAudit(event:AuditEvent):Promise<void>; listAudit(projectId:string):Promise<AuditEvent[]>;
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
