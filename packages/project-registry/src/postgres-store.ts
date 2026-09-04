import { drizzle } from 'drizzle-orm/node-postgres';
import { and, desc, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { Conflict } from '../../core/src/errors.js';
import type { ArtifactDigest, CanonicalPromotionRequest, StateStore } from '../../core/src/ports.js';
import type { AdminOperation, Artifact, AuditEvent, CanonicalDevelopmentRepository, ConsoleScreen, ExecutionJob, MigrationMarker, Operator, Project, ProjectContext, ProjectMembership, Resource, Run, SystemSetting, Task, Transition } from '../../schemas/src/index.js';
import * as s from './schema.js';

export class PostgresStateStore implements StateStore {
  readonly pool:Pool; private db;
  constructor(connectionString:string){this.pool=new Pool({connectionString});this.db=drizzle(this.pool);}
  async close(){await this.pool.end();}
  async createProject(v:Project){await this.db.insert(s.projects).values({id:v.id,slug:v.slug,data:v,createdAt:new Date(v.createdAt)});return v;}
  async updateProject(v:Project){await this.db.update(s.projects).set({data:v}).where(eq(s.projects.id,v.id));return v;}
  async getProject(id:string){return data<Project>((await this.db.select().from(s.projects).where(eq(s.projects.id,id)).limit(1))[0]);}
  async listProjects(){return (await this.db.select().from(s.projects).orderBy(s.projects.createdAt)).map(r=>r.data as Project);}
  async createResource(v:Resource){await this.db.insert(s.resources).values({id:v.resourceId,projectId:v.projectId,provider:v.provider,externalReference:v.externalReference,data:v,createdAt:new Date(v.createdAt)});return v;}
  async updateResource(v:Resource){await this.db.update(s.resources).set({data:v}).where(and(eq(s.resources.id,v.resourceId),eq(s.resources.projectId,v.projectId)));return v;}
  async getResource(id:string){return data<Resource>((await this.db.select().from(s.resources).where(eq(s.resources.id,id)).limit(1))[0]);}
  async findResource(projectId:string,externalReference:string){return data<Resource>((await this.db.select().from(s.resources).where(and(eq(s.resources.projectId,projectId),eq(s.resources.externalReference,externalReference))).limit(1))[0]);}
  async listResources(projectId:string){return (await this.db.select().from(s.resources).where(eq(s.resources.projectId,projectId))).map(r=>r.data as Resource);}
  async saveContext(v:ProjectContext){await this.db.insert(s.contexts).values({id:v.id,projectId:v.projectId,data:v,createdAt:new Date(v.createdAt)});return v;}
  async updateContext(v:ProjectContext){await this.db.update(s.contexts).set({data:v}).where(and(eq(s.contexts.id,v.id),eq(s.contexts.projectId,v.projectId)));return v;}
  async getContext(projectId:string,id:string){return data<ProjectContext>((await this.db.select().from(s.contexts).where(and(eq(s.contexts.id,id),eq(s.contexts.projectId,projectId))).limit(1))[0]);}
  async getLatestContext(projectId:string){return (await this.listContexts(projectId)).filter(v=>!v.deletedAt).at(-1);}
  async listContexts(projectId:string){return (await this.db.select().from(s.contexts).where(eq(s.contexts.projectId,projectId)).orderBy(s.contexts.createdAt)).map(r=>r.data as ProjectContext);}
  async createTask(v:Task){await this.db.insert(s.tasks).values({id:v.id,projectId:v.projectId,externalKey:v.externalKey,data:v,createdAt:new Date(v.createdAt)});return v;}
  async updateTask(v:Task){await this.db.update(s.tasks).set({data:v}).where(and(eq(s.tasks.id,v.id),eq(s.tasks.projectId,v.projectId)));return v;}
  async getTask(projectId:string,id:string){return data<Task>((await this.db.select().from(s.tasks).where(and(eq(s.tasks.id,id),eq(s.tasks.projectId,projectId))).limit(1))[0]);}
  async listTasks(projectId:string){return (await this.db.select().from(s.tasks).where(eq(s.tasks.projectId,projectId))).map(r=>r.data as Task);}
  async saveArtifact(v:Artifact){await this.db.insert(s.artifacts).values({id:v.id,projectId:v.projectId,taskId:v.taskId??null,runId:v.runId??null,kind:v.kind,status:v.status,contentHash:v.contentHash,storageBucket:v.storage?.bucket??null,storagePath:v.storage?.path??null,byteSize:v.storage?.size??null,data:v,createdAt:new Date(v.createdAt)});return v;}
  async updateArtifact(v:Artifact){await this.db.update(s.artifacts).set({status:v.status,data:v}).where(and(eq(s.artifacts.id,v.id),eq(s.artifacts.projectId,v.projectId)));return v;}
  async getArtifact(projectId:string,id:string){return data<Artifact>((await this.db.select().from(s.artifacts).where(and(eq(s.artifacts.id,id),eq(s.artifacts.projectId,projectId))).limit(1))[0]);}
  async listArtifacts(projectId:string,taskId?:string){const rows=taskId?await this.db.select().from(s.artifacts).where(and(eq(s.artifacts.projectId,projectId),eq(s.artifacts.taskId,taskId))):await this.db.select().from(s.artifacts).where(eq(s.artifacts.projectId,projectId));return rows.map(r=>r.data as Artifact);}
  // Selects the indexed identity columns only. `data` -- which holds the artifact's inline content
  // up to the externalization threshold -- is never read, so this stays flat in cost as a
  // project's recorded output grows.
  async listArtifactDigests(projectId:string):Promise<ArtifactDigest[]>{
    const rows=await this.db.select({id:s.artifacts.id,projectId:s.artifacts.projectId,taskId:s.artifacts.taskId,runId:s.artifacts.runId,kind:s.artifacts.kind,createdAt:s.artifacts.createdAt}).from(s.artifacts).where(eq(s.artifacts.projectId,projectId)).orderBy(s.artifacts.createdAt);
    return rows.map(r=>({id:r.id,projectId:r.projectId,...(r.taskId?{taskId:r.taskId}:{}),...(r.runId?{runId:r.runId}:{}),...(r.kind?{kind:r.kind}:{}),createdAt:r.createdAt.toISOString()}));
  }
  async latestArtifactOfKind(projectId:string,kind:string){
    const rows=await this.db.select({data:s.artifacts.data}).from(s.artifacts).where(and(eq(s.artifacts.projectId,projectId),eq(s.artifacts.kind,kind))).orderBy(desc(s.artifacts.createdAt)).limit(1);
    return rows[0]?.data as Artifact|undefined;
  }
  async saveRun(v:Run){await this.db.insert(s.runs).values({id:v.id,projectId:v.projectId,taskId:v.taskId,operationId:v.operationId,data:v,createdAt:new Date(v.startedAt)}).onConflictDoNothing();return (await this.findRunByOperation(v.projectId,v.operationId))??v;}
  async updateRun(v:Run){await this.db.update(s.runs).set({data:v}).where(and(eq(s.runs.id,v.id),eq(s.runs.projectId,v.projectId)));return v;}
  async getRun(projectId:string,id:string){return data<Run>((await this.db.select().from(s.runs).where(and(eq(s.runs.id,id),eq(s.runs.projectId,projectId))).limit(1))[0]);}
  async findRunByOperation(projectId:string,operationId:string){return data<Run>((await this.db.select().from(s.runs).where(and(eq(s.runs.projectId,projectId),eq(s.runs.operationId,operationId))).limit(1))[0]);}
  async listRuns(projectId:string,taskId?:string){const rows=taskId?await this.db.select().from(s.runs).where(and(eq(s.runs.projectId,projectId),eq(s.runs.taskId,taskId))):await this.db.select().from(s.runs).where(eq(s.runs.projectId,projectId));return rows.map(r=>r.data as Run);}
  async createExecutionJob(v:ExecutionJob){await this.db.insert(s.executionJobs).values(jobValues(v)).onConflictDoNothing();return (await this.findExecutionJobByOperation(v.projectId,v.operationId))??v;}
  async updateExecutionJob(v:ExecutionJob){await this.db.update(s.executionJobs).set({...jobValues(v),createdAt:new Date(v.queuedAt)}).where(and(eq(s.executionJobs.id,v.id),eq(s.executionJobs.projectId,v.projectId)));return v;}
  async getExecutionJob(projectId:string,id:string){return data<ExecutionJob>((await this.db.select().from(s.executionJobs).where(and(eq(s.executionJobs.id,id),eq(s.executionJobs.projectId,projectId))).limit(1))[0]);}
  async getExecutionJobById(id:string){return data<ExecutionJob>((await this.db.select().from(s.executionJobs).where(eq(s.executionJobs.id,id)).limit(1))[0]);}
  async findExecutionJobByOperation(projectId:string,operationId:string){return data<ExecutionJob>((await this.db.select().from(s.executionJobs).where(and(eq(s.executionJobs.projectId,projectId),eq(s.executionJobs.operationId,operationId))).limit(1))[0]);}
  async listExecutionJobs(projectId:string,taskId?:string){const rows=taskId?await this.db.select().from(s.executionJobs).where(and(eq(s.executionJobs.projectId,projectId),eq(s.executionJobs.taskId,taskId))):await this.db.select().from(s.executionJobs).where(eq(s.executionJobs.projectId,projectId));return rows.map(r=>r.data as ExecutionJob);}
  async claimExecutionJob(projectId:string,id:string,leaseOwner:string,leaseExpiresAt:string,now:string){if(!await this.getExecutionJob(projectId,id))return undefined;const requestedSeconds=Math.max(60,Math.round((new Date(leaseExpiresAt).getTime()-new Date(now).getTime())/1000));const result=await this.pool.query<{job:ExecutionJob|null}>('select claim_execution_job($1::uuid,$2::text,$3::integer) as job',[id,leaseOwner,requestedSeconds]);const job=result.rows[0]?.job??undefined;return job?.projectId===projectId?job:undefined;}
  async transitionTask(task:Task,transition:Transition){await this.db.transaction(async tx=>{await tx.update(s.tasks).set({data:task}).where(and(eq(s.tasks.id,task.id),eq(s.tasks.projectId,task.projectId)));await tx.insert(s.transitions).values({id:transition.id,taskId:transition.taskId,data:transition,createdAt:new Date(transition.timestamp)});});return task;}
  async appendTransition(v:Transition){await this.db.insert(s.transitions).values({id:v.id,taskId:v.taskId,data:v,createdAt:new Date(v.timestamp)});}
  async listTransitions(taskId:string){return (await this.db.select().from(s.transitions).where(eq(s.transitions.taskId,taskId)).orderBy(s.transitions.createdAt)).map(r=>r.data as Transition);}
  async appendAudit(v:AuditEvent){await this.db.insert(s.auditEvents).values({id:v.id,projectId:v.projectId,data:v,createdAt:new Date(v.timestamp)});}
  async getAudit(projectId:string,id:string){return data<AuditEvent>((await this.db.select().from(s.auditEvents).where(and(eq(s.auditEvents.id,id),eq(s.auditEvents.projectId,projectId))).limit(1))[0]);}
  async listAudit(projectId:string){return (await this.db.select().from(s.auditEvents).where(eq(s.auditEvents.projectId,projectId)).orderBy(s.auditEvents.createdAt)).map(r=>r.data as AuditEvent);}
  async listRecentAudit(projectId:string,limit:number){return (await this.db.select({data:s.auditEvents.data}).from(s.auditEvents).where(eq(s.auditEvents.projectId,projectId)).orderBy(desc(s.auditEvents.createdAt)).limit(limit)).map(r=>r.data as AuditEvent);}
  async upsertSystemSetting(v:SystemSetting){await this.pool.query('insert into system_settings(key,data,updated_at) values($1,$2,$3) on conflict(key) do update set data=excluded.data,updated_at=excluded.updated_at',[v.key,v,v.updatedAt]);return v;}
  async getSystemSetting(key:string){const r=await this.pool.query<{data:SystemSetting}>('select data from system_settings where key=$1 limit 1',[key]);return r.rows[0]?.data;}
  async listSystemSettings(){return (await this.pool.query<{data:SystemSetting}>('select data from system_settings order by key')).rows.map(v=>v.data);}
  async deleteSystemSetting(key:string){await this.pool.query('delete from system_settings where key=$1',[key]);}
  async upsertConsoleScreen(v:ConsoleScreen){await this.pool.query('insert into console_screens(screen_id,data,updated_at) values($1,$2,$3) on conflict(screen_id) do update set data=excluded.data,updated_at=excluded.updated_at',[v.screenId,v,v.updatedAt]);return v;}
  async getConsoleScreen(id:string){const r=await this.pool.query<{data:ConsoleScreen}>('select data from console_screens where screen_id=$1 limit 1',[id]);return r.rows[0]?.data;}
  async listConsoleScreens(){return (await this.pool.query<{data:ConsoleScreen}>('select data from console_screens order by screen_id')).rows.map(v=>v.data);}
  async deleteConsoleScreen(id:string){await this.pool.query('delete from console_screens where screen_id=$1',[id]);}
  async upsertOperator(v:Operator){await this.pool.query('insert into autopilot_operators(user_id,email,role,status,created_at,updated_at) values($1,$2,$3,$4,$5,$6) on conflict(user_id) do update set email=excluded.email,role=excluded.role,status=excluded.status,updated_at=excluded.updated_at',[v.userId,v.email,v.role,v.status,v.createdAt,v.updatedAt]);return v;}
  async getOperator(id:string){const r=await this.pool.query<{user_id:string,email:string,role:string,status:string,created_at:string,updated_at:string}>('select * from autopilot_operators where user_id=$1 limit 1',[id]);return r.rows[0]?operator(r.rows[0]):undefined;}
  async listOperators(){return (await this.pool.query<{user_id:string,email:string,role:string,status:string,created_at:string,updated_at:string}>('select * from autopilot_operators order by created_at')).rows.map(operator);}
  async deleteOperator(id:string){await this.pool.query('delete from autopilot_operators where user_id=$1',[id]);}
  async upsertMembership(v:ProjectMembership){await this.pool.query('insert into autopilot_project_memberships(user_id,project_id,role,created_at,updated_at) values($1,$2,$3,$4,$5) on conflict(user_id,project_id) do update set role=excluded.role,updated_at=excluded.updated_at',[v.userId,v.projectId,v.role,v.createdAt,v.updatedAt]);return v;}
  async getMembership(userId:string,projectId:string){const r=await this.pool.query<{user_id:string,project_id:string,role:string,created_at:string,updated_at:string}>('select * from autopilot_project_memberships where user_id=$1 and project_id=$2 limit 1',[userId,projectId]);return r.rows[0]?membership(r.rows[0]):undefined;}
  async listMemberships(projectId?:string,userId?:string){const r=projectId&&userId?await this.pool.query<{user_id:string,project_id:string,role:string,created_at:string,updated_at:string}>('select * from autopilot_project_memberships where project_id=$1 and user_id=$2 order by created_at',[projectId,userId]):projectId?await this.pool.query<{user_id:string,project_id:string,role:string,created_at:string,updated_at:string}>('select * from autopilot_project_memberships where project_id=$1 order by created_at',[projectId]):userId?await this.pool.query<{user_id:string,project_id:string,role:string,created_at:string,updated_at:string}>('select * from autopilot_project_memberships where user_id=$1 order by created_at',[userId]):await this.pool.query<{user_id:string,project_id:string,role:string,created_at:string,updated_at:string}>('select * from autopilot_project_memberships order by created_at');return r.rows.map(membership);}
  async deleteMembership(userId:string,projectId:string){await this.pool.query('delete from autopilot_project_memberships where user_id=$1 and project_id=$2',[userId,projectId]);}
  async saveAdminOperation(v:AdminOperation){await this.pool.query('insert into admin_operations(operation_id,actor,tool,project_id,data,created_at) values($1,$2,$3,$4,$5,$6) on conflict(operation_id) do nothing',[v.operationId,v.actor,v.tool,v.projectId??null,v,v.createdAt]);return (await this.getAdminOperation(v.operationId))??v;}
  async getAdminOperation(id:string){const r=await this.pool.query<{data:AdminOperation}>('select data from admin_operations where operation_id=$1 limit 1',[id]);return r.rows[0]?.data;}
  async listAdminOperations(){return (await this.pool.query<{data:AdminOperation}>('select data from admin_operations order by created_at')).rows.map(v=>v.data);}
  async listMigrationMarkers(){return (await this.pool.query<{key:string,checksum:string,data:unknown,created_at:string}>('select * from migration_markers order by created_at')).rows.map((v):MigrationMarker=>({key:v.key,checksum:v.checksum,data:v.data,createdAt:new Date(v.created_at).toISOString()}));}
  async getCanonicalRepository(projectId:string,id:string){const r=await this.pool.query<{data:CanonicalDevelopmentRepository}>('select data from canonical_development_repositories where id=$1 and project_id=$2 limit 1',[id,projectId]);return r.rows[0]?.data;}
  async getActiveCanonicalRepository(projectId:string){const r=await this.pool.query<{data:CanonicalDevelopmentRepository}>("select data from canonical_development_repositories where project_id=$1 and status='ACTIVE' limit 1",[projectId]);return r.rows[0]?.data;}
  async listCanonicalRepositories(projectId:string){return (await this.pool.query<{data:CanonicalDevelopmentRepository}>('select data from canonical_development_repositories where project_id=$1 order by version',[projectId])).rows.map(v=>v.data);}
  // One transaction, and the optimistic lock is taken as a row lock (FOR UPDATE) rather than as a
  // plain read: two concurrent promotions serialise on it instead of both reading the same
  // pre-state. The partial unique index is the backstop -- if anything still raced through, the
  // second INSERT violates it and surfaces as Conflict rather than as a second ACTIVE binding.
  async promoteCanonicalRepository(request:CanonicalPromotionRequest){
    const client=await this.pool.connect();
    try{
      await client.query('begin');
      const current=await client.query<{id:string;version:number;data:CanonicalDevelopmentRepository}>("select id,version,data from canonical_development_repositories where project_id=$1 and status='ACTIVE' for update",[request.projectId]);
      const active=current.rows[0];
      if(request.expectedCurrent){
        if(!active)throw new Conflict('Expected an ACTIVE canonical repository that no longer exists',{expected:request.expectedCurrent});
        if(active.id!==request.expectedCurrent.id||Number(active.version)!==request.expectedCurrent.version)
          throw new Conflict('Canonical repository changed since the plan was generated',{expected:request.expectedCurrent,actual:{id:active.id,version:Number(active.version)}});
      }else if(active)throw new Conflict('Project already has an ACTIVE canonical repository',{actual:{id:active.id,version:Number(active.version)}});
      let displaced:CanonicalDevelopmentRepository|undefined;
      if(active){
        displaced={...active.data,status:request.displacedStatus,supersededBy:request.record.id,supersededAt:request.displacedAt,updatedAt:request.displacedAt};
        await client.query('update canonical_development_repositories set status=$1,data=$2,updated_at=$3 where id=$4',[request.displacedStatus,displaced,request.displacedAt,active.id]);
      }
      const v=request.record;
      await client.query('insert into canonical_development_repositories(id,project_id,resource_id,status,version,operation_id,data,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[v.id,v.projectId,v.resourceId,v.status,v.version,v.operationId,v,v.createdAt,v.updatedAt]);
      await client.query('commit');
      return {active:v,...(displaced?{displaced}:{})};
    }catch(error){
      await client.query('rollback').catch(()=>undefined);
      if(error instanceof Conflict)throw error;
      if((error as {code?:string}).code==='23505')throw new Conflict('Concurrent canonical promotion was rejected by the durable uniqueness invariant',{projectId:request.projectId});
      throw error;
    }finally{client.release();}
  }
}
function data<T>(row:{data:unknown}|undefined):T|undefined{return row?.data as T|undefined;}
function jobValues(v:ExecutionJob){return {id:v.id,projectId:v.projectId,taskId:v.taskId,resourceId:v.resourceId,runId:v.runId??null,operationId:v.operationId,kind:v.kind,status:v.status,attempt:v.attempt,workflowRunId:v.workflowRunId??null,leaseOwner:v.leaseOwner??null,leaseExpiresAt:v.leaseExpiresAt?new Date(v.leaseExpiresAt):null,data:v,createdAt:new Date(v.queuedAt),updatedAt:new Date(v.updatedAt)};}
function operator(v:{user_id:string,email:string,role:string,status:string,created_at:string|Date,updated_at:string|Date}):Operator{return {userId:v.user_id,email:v.email,role:v.role as Operator['role'],status:v.status as Operator['status'],createdAt:new Date(v.created_at).toISOString(),updatedAt:new Date(v.updated_at).toISOString()};}
function membership(v:{user_id:string,project_id:string,role:string,created_at:string|Date,updated_at:string|Date}):ProjectMembership{return {userId:v.user_id,projectId:v.project_id,role:v.role as ProjectMembership['role'],createdAt:new Date(v.created_at).toISOString(),updatedAt:new Date(v.updated_at).toISOString()};}
