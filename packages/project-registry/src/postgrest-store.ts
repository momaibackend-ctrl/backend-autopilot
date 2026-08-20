import { Conflict, ExecutionFailed } from '../../core/src/errors.js';
import type { StateStore } from '../../core/src/ports.js';
import type { Artifact, AuditEvent, ExecutionJob, Project, ProjectContext, Resource, Run, Task, Transition } from '../../schemas/src/index.js';

export class PostgrestStateStore implements StateStore {
  constructor(private readonly url:string,private readonly serviceKey:string){if(!/^https:\/\/[a-z]{20}\.supabase\.co$/.test(url)||!serviceKey)throw new ExecutionFailed('Valid Supabase URL and server credential are required');}
  createProject(v:Project){return this.insert<Project>('projects',{id:v.id,slug:v.slug,data:v,created_at:v.createdAt});}
  async getProject(id:string){return this.one<Project>('projects',`id=eq.${encodeURIComponent(id)}`);}
  listProjects(){return this.many<Project>('projects','order=created_at.asc');}
  createResource(v:Resource){return this.insert<Resource>('resources',{id:v.resourceId,project_id:v.projectId,provider:v.provider,external_reference:v.externalReference,data:v,created_at:v.createdAt});}
  async updateResource(v:Resource){await this.patch('resources',`id=eq.${v.resourceId}&project_id=eq.${v.projectId}`,{data:v});return v;}
  getResource(id:string){return this.one<Resource>('resources',`id=eq.${encodeURIComponent(id)}`);}
  findResource(projectId:string,externalReference:string){return this.one<Resource>('resources',`project_id=eq.${projectId}&external_reference=eq.${encodeURIComponent(externalReference)}`);}
  listResources(projectId:string){return this.many<Resource>('resources',`project_id=eq.${projectId}&order=created_at.asc`);}
  saveContext(v:ProjectContext){return this.insert<ProjectContext>('project_contexts',{id:v.id,project_id:v.projectId,data:v,created_at:v.createdAt});}
  getLatestContext(projectId:string){return this.one<ProjectContext>('project_contexts',`project_id=eq.${projectId}&order=created_at.desc`);}
  createTask(v:Task){return this.insert<Task>('tasks',{id:v.id,project_id:v.projectId,external_key:v.externalKey,data:v,created_at:v.createdAt});}
  async updateTask(v:Task){await this.patch('tasks',`id=eq.${v.id}&project_id=eq.${v.projectId}`,{data:v});return v;}
  getTask(projectId:string,taskId:string){return this.one<Task>('tasks',`id=eq.${taskId}&project_id=eq.${projectId}`);}
  listTasks(projectId:string){return this.many<Task>('tasks',`project_id=eq.${projectId}&order=created_at.asc`);}
  createArtifactRow(v:Artifact){return {id:v.id,project_id:v.projectId,task_id:v.taskId??null,run_id:v.runId??null,kind:v.kind,status:v.status,content_hash:v.contentHash,storage_bucket:v.storage?.bucket??null,storage_path:v.storage?.path??null,byte_size:v.storage?.size??null,data:v,created_at:v.createdAt};}
  saveArtifact(v:Artifact){return this.insert<Artifact>('artifacts',this.createArtifactRow(v));}
  getArtifact(projectId:string,id:string){return this.one<Artifact>('artifacts',`id=eq.${id}&project_id=eq.${projectId}`);}
  listArtifacts(projectId:string,taskId?:string){return this.many<Artifact>('artifacts',`project_id=eq.${projectId}${taskId?`&task_id=eq.${taskId}`:''}&order=created_at.asc`);}
  async saveRun(v:Run){const existing=await this.findRunByOperation(v.projectId,v.operationId);if(existing)return existing;return this.insert<Run>('runs',{id:v.id,project_id:v.projectId,task_id:v.taskId,operation_id:v.operationId,data:v,created_at:v.startedAt});}
  async updateRun(v:Run){await this.patch('runs',`id=eq.${v.id}&project_id=eq.${v.projectId}`,{data:v});return v;}
  getRun(projectId:string,id:string){return this.one<Run>('runs',`id=eq.${id}&project_id=eq.${projectId}`);}
  findRunByOperation(projectId:string,operationId:string){return this.one<Run>('runs',`project_id=eq.${projectId}&operation_id=eq.${encodeURIComponent(operationId)}`);}
  listRuns(projectId:string,taskId?:string){return this.many<Run>('runs',`project_id=eq.${projectId}${taskId?`&task_id=eq.${taskId}`:''}&order=created_at.asc`);}
  async createExecutionJob(v:ExecutionJob){const existing=await this.findExecutionJobByOperation(v.projectId,v.operationId);if(existing)return existing;return this.insert<ExecutionJob>('execution_jobs',jobRow(v));}
  async updateExecutionJob(v:ExecutionJob){await this.patch('execution_jobs',`id=eq.${v.id}&project_id=eq.${v.projectId}`,jobUpdate(v));return v;}
  getExecutionJob(projectId:string,id:string){return this.one<ExecutionJob>('execution_jobs',`id=eq.${id}&project_id=eq.${projectId}`);}
  getExecutionJobById(id:string){return this.one<ExecutionJob>('execution_jobs',`id=eq.${id}`);}
  findExecutionJobByOperation(projectId:string,operationId:string){return this.one<ExecutionJob>('execution_jobs',`project_id=eq.${projectId}&operation_id=eq.${encodeURIComponent(operationId)}`);}
  listExecutionJobs(projectId:string,taskId?:string){return this.many<ExecutionJob>('execution_jobs',`project_id=eq.${projectId}${taskId?`&task_id=eq.${taskId}`:''}&order=created_at.asc`);}
  async claimExecutionJob(projectId:string,id:string,leaseOwner:string,leaseExpiresAt:string,now:string){const seconds=Math.max(60,Math.round((new Date(leaseExpiresAt).getTime()-new Date(now).getTime())/1000));const value=await this.rpc<ExecutionJob|null>('claim_execution_job',{requested_job_id:id,requested_owner:leaseOwner,lease_seconds:seconds});return value?.projectId===projectId?value:undefined;}
  transitionTask(task:Task,transition:Transition){return this.rpc<Task>('transition_task_atomic',{task_data:task,transition_data:transition});}
  async appendTransition(v:Transition){await this.insert<Transition>('task_transitions',{id:v.id,task_id:v.taskId,data:v,created_at:v.timestamp});}
  listTransitions(taskId:string){return this.many<Transition>('task_transitions',`task_id=eq.${taskId}&order=created_at.asc`);}
  async appendAudit(v:AuditEvent){await this.insert<AuditEvent>('audit_events',{id:v.id,project_id:v.projectId,data:v,created_at:v.timestamp});}
  listAudit(projectId:string){return this.many<AuditEvent>('audit_events',`project_id=eq.${projectId}&order=created_at.asc`);}
  private async one<T>(table:string,query:string){const values=await this.request<{data:T}[]>('GET',`/rest/v1/${table}?select=data&${query}&limit=1`);return values[0]?.data;}
  private async many<T>(table:string,query:string){return (await this.request<{data:T}[]>('GET',`/rest/v1/${table}?select=data&${query}`)).map(value=>value.data);}
  private async insert<T>(table:string,value:unknown){const rows=await this.request<{data:T}[]>('POST',`/rest/v1/${table}`,value,{'prefer':'return=representation'});const data=rows[0]?.data;if(!data)throw new ExecutionFailed(`PostgREST insert into ${table} returned no data`);return data;}
  private async patch(table:string,query:string,value:unknown){await this.request('PATCH',`/rest/v1/${table}?${query}`,value,{'prefer':'return=minimal'});}
  private rpc<T>(name:string,value:unknown){return this.request<T>('POST',`/rest/v1/rpc/${name}`,value);}
  private async request<T=unknown>(method:string,path:string,body?:unknown,headers:Record<string,string>={}){const response=await fetch(`${this.url}${path}`,{method,headers:{apikey:this.serviceKey,authorization:`Bearer ${this.serviceKey}`,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});if(response.status===409)throw new Conflict('Persistent state uniqueness constraint rejected the operation');if(!response.ok)throw new ExecutionFailed('Supabase PostgREST operation failed',{method,path,status:response.status,body:(await response.text()).slice(0,300)});const text=await response.text();return (text?JSON.parse(text):undefined) as T;}
}
function jobRow(v:ExecutionJob){return {id:v.id,project_id:v.projectId,task_id:v.taskId,resource_id:v.resourceId,run_id:v.runId??null,operation_id:v.operationId,kind:v.kind,status:v.status,attempt:v.attempt,workflow_run_id:v.workflowRunId??null,lease_owner:v.leaseOwner??null,lease_expires_at:v.leaseExpiresAt??null,data:v,created_at:v.queuedAt,updated_at:v.updatedAt};}
function jobUpdate(v:ExecutionJob){return {task_id:v.taskId,resource_id:v.resourceId,run_id:v.runId??null,operation_id:v.operationId,kind:v.kind,status:v.status,attempt:v.attempt,workflow_run_id:v.workflowRunId??null,lease_owner:v.leaseOwner??null,lease_expires_at:v.leaseExpiresAt??null,data:v,updated_at:v.updatedAt};}
