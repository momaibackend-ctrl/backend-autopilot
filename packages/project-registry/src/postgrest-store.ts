import { Conflict, ExecutionFailed } from '../../core/src/errors.js';
import type { ArtifactDigest, CanonicalPromotionRequest, StateStore } from '../../core/src/ports.js';
import type { AdminOperation, Artifact, AuditEvent, CanonicalDevelopmentRepository, ConsoleScreen, ExecutionJob, MigrationMarker, Operator, Project, ProjectContext, ProjectMembership, Resource, Run, SystemSetting, Task, Transition } from '../../schemas/src/index.js';

// Stays at or below PostgREST's own max-rows so a full page is a real page boundary rather than
// a server-side cap we cannot see.
const manyPageSize=1000;

export class PostgrestStateStore implements StateStore {
  constructor(private readonly url:string,private readonly serviceKey:string){if(!/^https:\/\/[a-z]{20}\.supabase\.co$/.test(url)||!serviceKey)throw new ExecutionFailed('Valid Supabase URL and server credential are required');}
  createProject(v:Project){return this.insert<Project>('projects',{id:v.id,slug:v.slug,data:v,created_at:v.createdAt});}
  async updateProject(v:Project){await this.patch('projects',`id=eq.${v.id}`,{data:v});return v;}
  async getProject(id:string){return this.one<Project>('projects',`id=eq.${encodeURIComponent(id)}`);}
  listProjects(){return this.many<Project>('projects','order=created_at.asc');}
  createResource(v:Resource){return this.insert<Resource>('resources',{id:v.resourceId,project_id:v.projectId,provider:v.provider,external_reference:v.externalReference,data:v,created_at:v.createdAt});}
  async updateResource(v:Resource){await this.patch('resources',`id=eq.${v.resourceId}&project_id=eq.${v.projectId}`,{data:v});return v;}
  getResource(id:string){return this.one<Resource>('resources',`id=eq.${encodeURIComponent(id)}`);}
  findResource(projectId:string,externalReference:string){return this.one<Resource>('resources',`project_id=eq.${projectId}&external_reference=eq.${encodeURIComponent(externalReference)}`);}
  listResources(projectId:string){return this.many<Resource>('resources',`project_id=eq.${projectId}&order=created_at.asc`);}
  saveContext(v:ProjectContext){return this.insert<ProjectContext>('project_contexts',{id:v.id,project_id:v.projectId,data:v,created_at:v.createdAt});}
  async updateContext(v:ProjectContext){await this.patch('project_contexts',`id=eq.${v.id}&project_id=eq.${v.projectId}`,{data:v});return v;}
  getContext(projectId:string,id:string){return this.one<ProjectContext>('project_contexts',`id=eq.${id}&project_id=eq.${projectId}`);}
  getLatestContext(projectId:string){return this.one<ProjectContext>('project_contexts',`project_id=eq.${projectId}&data->>deletedAt=is.null&order=created_at.desc`);}
  listContexts(projectId:string){return this.many<ProjectContext>('project_contexts',`project_id=eq.${projectId}&order=created_at.asc`);}
  createTask(v:Task){return this.insert<Task>('tasks',{id:v.id,project_id:v.projectId,external_key:v.externalKey,data:v,created_at:v.createdAt});}
  async updateTask(v:Task){await this.patch('tasks',`id=eq.${v.id}&project_id=eq.${v.projectId}`,{data:v});return v;}
  getTask(projectId:string,taskId:string){return this.one<Task>('tasks',`id=eq.${taskId}&project_id=eq.${projectId}`);}
  listTasks(projectId:string){return this.many<Task>('tasks',`project_id=eq.${projectId}&order=created_at.asc`);}
  createArtifactRow(v:Artifact){return {id:v.id,project_id:v.projectId,task_id:v.taskId??null,run_id:v.runId??null,kind:v.kind,status:v.status,content_hash:v.contentHash,storage_bucket:v.storage?.bucket??null,storage_path:v.storage?.path??null,byte_size:v.storage?.size??null,data:v,created_at:v.createdAt};}
  saveArtifact(v:Artifact){return this.insert<Artifact>('artifacts',this.createArtifactRow(v));}
  async updateArtifact(v:Artifact){await this.patch('artifacts',`id=eq.${v.id}&project_id=eq.${v.projectId}`,{status:v.status,data:v});return v;}
  getArtifact(projectId:string,id:string){return this.one<Artifact>('artifacts',`id=eq.${id}&project_id=eq.${projectId}`);}
  listArtifacts(projectId:string,taskId?:string){return this.many<Artifact>('artifacts',`project_id=eq.${projectId}${taskId?`&task_id=eq.${taskId}`:''}&order=created_at.asc`);}
  // `select=` names the identity columns explicitly and omits `data`, so PostgREST never
  // serialises the artifacts' inline content. This is the difference between a response that
  // grows with a project's entire recorded output and one that grows with its artifact COUNT --
  // the reason the previous console overview, polled every few seconds per open tab, was the
  // dominant consumer of the project's egress allowance.
  async listArtifactDigests(projectId:string):Promise<ArtifactDigest[]>{
    const rows=await this.page<{id:string;project_id:string;task_id:string|null;run_id:string|null;kind:string|null;created_at:string}>('artifacts','id,project_id,task_id,run_id,kind,created_at',`project_id=eq.${projectId}&order=created_at.asc`);
    return rows.map(r=>({id:r.id,projectId:r.project_id,...(r.task_id?{taskId:r.task_id}:{}),...(r.run_id?{runId:r.run_id}:{}),...(r.kind?{kind:r.kind}:{}),createdAt:r.created_at}));
  }
  async latestArtifactOfKind(projectId:string,kind:string){
    return this.one<Artifact>('artifacts',`project_id=eq.${projectId}&kind=eq.${encodeURIComponent(kind)}&order=created_at.desc`);
  }
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
  getAudit(projectId:string,id:string){return this.one<AuditEvent>('audit_events',`id=eq.${id}&project_id=eq.${projectId}`);}
  listAudit(projectId:string){return this.many<AuditEvent>('audit_events',`project_id=eq.${projectId}&order=created_at.asc`);}
  // Bounded by `limit`, so this is a single small request rather than a paged walk of the whole
  // audit trail -- audit payloads carry each event's full input and result.
  async listRecentAudit(projectId:string,limit:number){
    return (await this.request<{data:AuditEvent}[]>('GET',`/rest/v1/audit_events?select=data&project_id=eq.${projectId}&order=created_at.desc&limit=${Math.max(1,Math.trunc(limit))}`)).map(row=>row.data);
  }
  upsertSystemSetting(v:SystemSetting){return this.upsertData<SystemSetting>('system_settings','key',v.key,{key:v.key,data:v,updated_at:v.updatedAt});}
  getSystemSetting(key:string){return this.one<SystemSetting>('system_settings',`key=eq.${encodeURIComponent(key)}`);}
  listSystemSettings(){return this.many<SystemSetting>('system_settings','order=key.asc');}
  deleteSystemSetting(key:string){return this.remove('system_settings',`key=eq.${encodeURIComponent(key)}`);}
  upsertConsoleScreen(v:ConsoleScreen){return this.upsertData<ConsoleScreen>('console_screens','screen_id',v.screenId,{screen_id:v.screenId,data:v,updated_at:v.updatedAt});}
  getConsoleScreen(id:string){return this.one<ConsoleScreen>('console_screens',`screen_id=eq.${encodeURIComponent(id)}`);}
  listConsoleScreens(){return this.many<ConsoleScreen>('console_screens','order=screen_id.asc');}
  deleteConsoleScreen(id:string){return this.remove('console_screens',`screen_id=eq.${encodeURIComponent(id)}`);}
  async upsertOperator(v:Operator){const rows=await this.request<Array<{user_id:string,email:string,role:string,status:string,created_at:string,updated_at:string}>>('POST','/rest/v1/autopilot_operators?on_conflict=user_id',{user_id:v.userId,email:v.email,role:v.role,status:v.status,created_at:v.createdAt,updated_at:v.updatedAt},{prefer:'resolution=merge-duplicates,return=representation'});const row=rows[0];if(!row)throw new ExecutionFailed('Operator upsert returned no data');return operator(row);}
  async getOperator(id:string){const rows=await this.request<Array<{user_id:string,email:string,role:string,status:string,created_at:string,updated_at:string}>>('GET',`/rest/v1/autopilot_operators?select=*&user_id=eq.${id}&limit=1`);return rows[0]?operator(rows[0]):undefined;}
  async listOperators(){return (await this.request<Array<{user_id:string,email:string,role:string,status:string,created_at:string,updated_at:string}>>('GET','/rest/v1/autopilot_operators?select=*&order=created_at.asc')).map(operator);}
  deleteOperator(id:string){return this.remove('autopilot_operators',`user_id=eq.${id}`);}
  async upsertMembership(v:ProjectMembership){const rows=await this.request<Array<{user_id:string,project_id:string,role:string,created_at:string,updated_at:string}>>('POST','/rest/v1/autopilot_project_memberships?on_conflict=user_id,project_id',{user_id:v.userId,project_id:v.projectId,role:v.role,created_at:v.createdAt,updated_at:v.updatedAt},{prefer:'resolution=merge-duplicates,return=representation'});const row=rows[0];if(!row)throw new ExecutionFailed('Membership upsert returned no data');return membership(row);}
  async getMembership(userId:string,projectId:string){const rows=await this.request<Array<{user_id:string,project_id:string,role:string,created_at:string,updated_at:string}>>('GET',`/rest/v1/autopilot_project_memberships?select=*&user_id=eq.${userId}&project_id=eq.${projectId}&limit=1`);return rows[0]?membership(rows[0]):undefined;}
  async listMemberships(projectId?:string,userId?:string){const query=[projectId?`project_id=eq.${projectId}`:'',userId?`user_id=eq.${userId}`:''].filter(Boolean).join('&');return (await this.request<Array<{user_id:string,project_id:string,role:string,created_at:string,updated_at:string}>>('GET',`/rest/v1/autopilot_project_memberships?select=*${query?`&${query}`:''}&order=created_at.asc`)).map(membership);}
  deleteMembership(userId:string,projectId:string){return this.remove('autopilot_project_memberships',`user_id=eq.${userId}&project_id=eq.${projectId}`);}
  async saveAdminOperation(v:AdminOperation){const existing=await this.getAdminOperation(v.operationId);if(existing)return existing;await this.request('POST','/rest/v1/admin_operations',{operation_id:v.operationId,actor:v.actor,tool:v.tool,project_id:v.projectId??null,data:v,created_at:v.createdAt},{prefer:'return=minimal'});return v;}
  getAdminOperation(id:string){return this.one<AdminOperation>('admin_operations',`operation_id=eq.${encodeURIComponent(id)}`);}
  listAdminOperations(){return this.many<AdminOperation>('admin_operations','order=created_at.asc');}
  async listMigrationMarkers(){const rows=await this.request<Array<{key:string,checksum:string,data:unknown,created_at:string}>>('GET','/rest/v1/migration_markers?select=*&order=created_at.asc');return rows.map((v):MigrationMarker=>({key:v.key,checksum:v.checksum,data:v.data,createdAt:v.created_at}));}
  getCanonicalRepository(projectId:string,id:string){return this.one<CanonicalDevelopmentRepository>('canonical_development_repositories',`id=eq.${id}&project_id=eq.${projectId}`);}
  getActiveCanonicalRepository(projectId:string){return this.one<CanonicalDevelopmentRepository>('canonical_development_repositories',`project_id=eq.${projectId}&status=eq.ACTIVE`);}
  listCanonicalRepositories(projectId:string){return this.many<CanonicalDevelopmentRepository>('canonical_development_repositories',`project_id=eq.${projectId}&order=version.asc`);}
  // PostgREST has no transactions across requests, so the whole replacement is one database
  // function. It takes the ACTIVE row FOR UPDATE, checks the caller's optimistic lock inside that
  // lock, and inserts under the partial unique index -- the same guarantee the direct-Postgres
  // store gets, expressed as an RPC because Edge speaks only PostgREST.
  async promoteCanonicalRepository(request:CanonicalPromotionRequest){
    const value=await this.rpc<{active:CanonicalDevelopmentRepository;displaced:CanonicalDevelopmentRepository|null}>('promote_canonical_repository',{
      p_project_id:request.projectId,
      p_record:request.record,
      p_expected_id:request.expectedCurrent?.id??null,
      p_expected_version:request.expectedCurrent?.version??null,
      p_displaced_status:request.displacedStatus,
      p_displaced_at:request.displacedAt,
    });
    return {active:value.active,...(value.displaced?{displaced:value.displaced}:{})};
  }
  private async one<T>(table:string,query:string){const values=await this.request<{data:T}[]>('GET',`/rest/v1/${table}?select=data&${query}&limit=1`);return values[0]?.data;}
  // PostgREST caps an unbounded GET at its configured max rows (1000 on Supabase) and returns the
  // truncated page with a 200, giving no signal that anything was withheld. Every list here feeds
  // decisions -- dependency evidence, READY gates, the delivery view -- so a silent truncation is
  // not slow data, it is wrong data: an active project's newest artifacts simply vanish while the
  // caller sees a plausible-looking array. Paging explicitly is the only way to get the real set.
  // Column-projected sibling of `many`: same explicit paging (and the same reason for it -- a
  // silently truncated PostgREST page is wrong data, not slow data), but the caller chooses which
  // columns cross the wire instead of always taking the whole `data` document.
  private async page<T>(table:string,select:string,query:string){
    const values:T[]=[];
    for(let offset=0;;offset+=manyPageSize){
      const rows=await this.request<T[]>('GET',`/rest/v1/${table}?select=${select}&${query}`,undefined,{range:`${offset}-${offset+manyPageSize-1}`,'range-unit':'items'});
      if(!rows?.length)break;
      values.push(...rows);
      if(rows.length<manyPageSize)break;
    }
    return values;
  }
  private async many<T>(table:string,query:string){
    const values:T[]=[];
    for(let offset=0;;offset+=manyPageSize){
      const page=await this.request<{data:T}[]>('GET',`/rest/v1/${table}?select=data&${query}`,undefined,{range:`${offset}-${offset+manyPageSize-1}`,'range-unit':'items'});
      if(!page?.length)break;
      for(const row of page)values.push(row.data);
      // A short page means the server had nothing more to give; a full one may or may not, so ask
      // again rather than inferring.
      if(page.length<manyPageSize)break;
    }
    return values;
  }
  private async insert<T>(table:string,value:unknown){const rows=await this.request<{data:T}[]>('POST',`/rest/v1/${table}`,value,{'prefer':'return=representation'});const data=rows[0]?.data;if(!data)throw new ExecutionFailed(`PostgREST insert into ${table} returned no data`);return data;}
  private async patch(table:string,query:string,value:unknown){await this.request('PATCH',`/rest/v1/${table}?${query}`,value,{'prefer':'return=minimal'});}
  private async remove(table:string,query:string){await this.request('DELETE',`/rest/v1/${table}?${query}`,undefined,{'prefer':'return=minimal'});}
  private async upsertData<T>(table:string,key:string,keyValue:string,value:unknown){const rows=await this.request<{data:T}[]>('POST',`/rest/v1/${table}?on_conflict=${key}`,value,{'prefer':'resolution=merge-duplicates,return=representation'});const data=rows[0]?.data;if(!data)throw new ExecutionFailed(`PostgREST upsert into ${table} returned no data`,{keyValue});return data;}
  private rpc<T>(name:string,value:unknown){return this.request<T>('POST',`/rest/v1/rpc/${name}`,value);}
  private async request<T=unknown>(method:string,path:string,body?:unknown,headers:Record<string,string>={}){const response=await fetch(`${this.url}${path}`,{method,headers:{apikey:this.serviceKey,authorization:`Bearer ${this.serviceKey}`,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});if(response.status===409)throw new Conflict('Persistent state uniqueness constraint rejected the operation');if(!response.ok)throw new ExecutionFailed('Supabase PostgREST operation failed',{method,path,status:response.status,body:(await response.text()).slice(0,300)});const text=await response.text();return (text?JSON.parse(text):undefined) as T;}
}
function operator(v:{user_id:string,email:string,role:string,status:string,created_at:string,updated_at:string}):Operator{return {userId:v.user_id,email:v.email,role:v.role as Operator['role'],status:v.status as Operator['status'],createdAt:v.created_at,updatedAt:v.updated_at};}
function membership(v:{user_id:string,project_id:string,role:string,created_at:string,updated_at:string}):ProjectMembership{return {userId:v.user_id,projectId:v.project_id,role:v.role as ProjectMembership['role'],createdAt:v.created_at,updatedAt:v.updated_at};}
function jobRow(v:ExecutionJob){return {id:v.id,project_id:v.projectId,task_id:v.taskId,resource_id:v.resourceId,run_id:v.runId??null,operation_id:v.operationId,kind:v.kind,status:v.status,attempt:v.attempt,workflow_run_id:v.workflowRunId??null,lease_owner:v.leaseOwner??null,lease_expires_at:v.leaseExpiresAt??null,data:v,created_at:v.queuedAt,updated_at:v.updatedAt};}
function jobUpdate(v:ExecutionJob){return {task_id:v.taskId,resource_id:v.resourceId,run_id:v.runId??null,operation_id:v.operationId,kind:v.kind,status:v.status,attempt:v.attempt,workflow_run_id:v.workflowRunId??null,lease_owner:v.leaseOwner??null,lease_expires_at:v.leaseExpiresAt??null,data:v,updated_at:v.updatedAt};}
