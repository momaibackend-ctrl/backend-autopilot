import type { Artifact, AuditEvent, Project, ProjectContext, Resource, Run, Task, Transition } from '../../schemas/src/index.js';

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
