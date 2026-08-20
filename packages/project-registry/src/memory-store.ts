import { Conflict } from '../../core/src/errors.js';
import type { StateStore } from '../../core/src/ports.js';
import type { Artifact, AuditEvent, ExecutionJob, Project, ProjectContext, Resource, Run, Task, Transition } from '../../schemas/src/index.js';

export class MemoryStateStore implements StateStore {
  private projects=new Map<string,Project>(); private resources=new Map<string,Resource>(); private contexts:ProjectContext[]=[];
  private tasks=new Map<string,Task>(); private artifacts=new Map<string,Artifact>(); private runs=new Map<string,Run>();
  private jobs=new Map<string,ExecutionJob>();
  private transitions:Transition[]=[]; private audit:AuditEvent[]=[];
  async createProject(v:Project){if([...this.projects.values()].some(p=>p.slug===v.slug))throw new Conflict('Project slug already exists');this.projects.set(v.id,structuredClone(v));return structuredClone(v);}
  async getProject(id:string){return clone(this.projects.get(id));} async listProjects(){return clones([...this.projects.values()]);}
  async createResource(v:Resource){const duplicate=[...this.resources.values()].find(r=>r.provider===v.provider&&r.externalReference===v.externalReference);if(duplicate)throw new Conflict('External resource already registered',{resourceId:duplicate.resourceId});this.resources.set(v.resourceId,structuredClone(v));return structuredClone(v);}
  async updateResource(v:Resource){this.resources.set(v.resourceId,structuredClone(v));return structuredClone(v);}
  async getResource(id:string){return clone(this.resources.get(id));}
  async findResource(projectId:string,externalReference:string){return clone([...this.resources.values()].find(r=>r.projectId===projectId&&r.externalReference===externalReference));}
  async listResources(projectId:string){return clones([...this.resources.values()].filter(r=>r.projectId===projectId));}
  async saveContext(v:ProjectContext){this.contexts.push(structuredClone(v));return structuredClone(v);}
  async getLatestContext(projectId:string){return clone(this.contexts.filter(c=>c.projectId===projectId).at(-1));}
  async createTask(v:Task){if([...this.tasks.values()].some(t=>t.projectId===v.projectId&&t.externalKey===v.externalKey))throw new Conflict('Task external key already exists');this.tasks.set(v.id,structuredClone(v));return structuredClone(v);}
  async updateTask(v:Task){this.tasks.set(v.id,structuredClone(v));return structuredClone(v);}
  async getTask(projectId:string,taskId:string){const v=this.tasks.get(taskId);return v?.projectId===projectId?structuredClone(v):undefined;}
  async listTasks(projectId:string){return clones([...this.tasks.values()].filter(t=>t.projectId===projectId));}
  async saveArtifact(v:Artifact){this.artifacts.set(v.id,structuredClone(v));return structuredClone(v);}
  async getArtifact(projectId:string,id:string){const v=this.artifacts.get(id);return v?.projectId===projectId?structuredClone(v):undefined;}
  async listArtifacts(projectId:string,taskId?:string){return clones([...this.artifacts.values()].filter(a=>a.projectId===projectId&&(!taskId||a.taskId===taskId)));}
  async saveRun(v:Run){const duplicate=await this.findRunByOperation(v.projectId,v.operationId);if(duplicate)return duplicate;this.runs.set(v.id,structuredClone(v));return structuredClone(v);}
  async updateRun(v:Run){this.runs.set(v.id,structuredClone(v));return structuredClone(v);}
  async getRun(projectId:string,id:string){const v=this.runs.get(id);return v?.projectId===projectId?structuredClone(v):undefined;}
  async findRunByOperation(projectId:string,operationId:string){return clone([...this.runs.values()].find(r=>r.projectId===projectId&&r.operationId===operationId));}
  async listRuns(projectId:string,taskId?:string){return clones([...this.runs.values()].filter(r=>r.projectId===projectId&&(!taskId||r.taskId===taskId)));}
  async createExecutionJob(v:ExecutionJob){const duplicate=await this.findExecutionJobByOperation(v.projectId,v.operationId);if(duplicate)return duplicate;this.jobs.set(v.id,structuredClone(v));return structuredClone(v);}
  async updateExecutionJob(v:ExecutionJob){this.jobs.set(v.id,structuredClone(v));return structuredClone(v);}
  async getExecutionJob(projectId:string,id:string){const value=this.jobs.get(id);return value?.projectId===projectId?structuredClone(value):undefined;}
  async getExecutionJobById(id:string){return clone(this.jobs.get(id));}
  async findExecutionJobByOperation(projectId:string,operationId:string){return clone([...this.jobs.values()].find(v=>v.projectId===projectId&&v.operationId===operationId));}
  async listExecutionJobs(projectId:string,taskId?:string){return clones([...this.jobs.values()].filter(v=>v.projectId===projectId&&(!taskId||v.taskId===taskId)));}
  async claimExecutionJob(projectId:string,id:string,leaseOwner:string,leaseExpiresAt:string,now:string){const value=await this.getExecutionJob(projectId,id);if(!value||!["QUEUED","DISPATCHED","CLAIMED"].includes(value.status))return undefined;if(value.leaseExpiresAt&&value.leaseExpiresAt>now&&value.leaseOwner!==leaseOwner)return undefined;const claimed:ExecutionJob={...value,status:"CLAIMED",leaseOwner,leaseExpiresAt,startedAt:value.startedAt??now,updatedAt:now};this.jobs.set(id,structuredClone(claimed));return structuredClone(claimed);}
  async transitionTask(task:Task,transition:Transition){this.tasks.set(task.id,structuredClone(task));this.transitions.push(structuredClone(transition));return structuredClone(task);}
  async appendTransition(v:Transition){this.transitions.push(structuredClone(v));} async listTransitions(taskId:string){return clones(this.transitions.filter(t=>t.taskId===taskId));}
  async appendAudit(v:AuditEvent){this.audit.push(structuredClone(v));} async listAudit(projectId:string){return clones(this.audit.filter(a=>a.projectId===projectId));}
}
function clone<T>(v:T|undefined):T|undefined{return v===undefined?undefined:structuredClone(v);}
function clones<T>(v:T[]):T[]{return structuredClone(v);}
