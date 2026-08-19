import { drizzle } from 'drizzle-orm/node-postgres';
import { and, desc, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import type { StateStore } from '../../core/src/ports.js';
import type { Artifact, AuditEvent, Project, ProjectContext, Resource, Run, Task, Transition } from '../../schemas/src/index.js';
import * as s from './schema.js';

export class PostgresStateStore implements StateStore {
  readonly pool:Pool; private db;
  constructor(connectionString:string){this.pool=new Pool({connectionString});this.db=drizzle(this.pool);}
  async close(){await this.pool.end();}
  async createProject(v:Project){await this.db.insert(s.projects).values({id:v.id,slug:v.slug,data:v,createdAt:new Date(v.createdAt)});return v;}
  async getProject(id:string){return data<Project>((await this.db.select().from(s.projects).where(eq(s.projects.id,id)).limit(1))[0]);}
  async listProjects(){return (await this.db.select().from(s.projects).orderBy(s.projects.createdAt)).map(r=>r.data as Project);}
  async createResource(v:Resource){await this.db.insert(s.resources).values({id:v.resourceId,projectId:v.projectId,provider:v.provider,externalReference:v.externalReference,data:v,createdAt:new Date(v.createdAt)});return v;}
  async getResource(id:string){return data<Resource>((await this.db.select().from(s.resources).where(eq(s.resources.id,id)).limit(1))[0]);}
  async findResource(projectId:string,externalReference:string){return data<Resource>((await this.db.select().from(s.resources).where(and(eq(s.resources.projectId,projectId),eq(s.resources.externalReference,externalReference))).limit(1))[0]);}
  async listResources(projectId:string){return (await this.db.select().from(s.resources).where(eq(s.resources.projectId,projectId))).map(r=>r.data as Resource);}
  async saveContext(v:ProjectContext){await this.db.insert(s.contexts).values({id:v.id,projectId:v.projectId,data:v,createdAt:new Date(v.createdAt)});return v;}
  async getLatestContext(projectId:string){return data<ProjectContext>((await this.db.select().from(s.contexts).where(eq(s.contexts.projectId,projectId)).orderBy(desc(s.contexts.createdAt)).limit(1))[0]);}
  async createTask(v:Task){await this.db.insert(s.tasks).values({id:v.id,projectId:v.projectId,externalKey:v.externalKey,data:v,createdAt:new Date(v.createdAt)});return v;}
  async updateTask(v:Task){await this.db.update(s.tasks).set({data:v}).where(and(eq(s.tasks.id,v.id),eq(s.tasks.projectId,v.projectId)));return v;}
  async getTask(projectId:string,id:string){return data<Task>((await this.db.select().from(s.tasks).where(and(eq(s.tasks.id,id),eq(s.tasks.projectId,projectId))).limit(1))[0]);}
  async listTasks(projectId:string){return (await this.db.select().from(s.tasks).where(eq(s.tasks.projectId,projectId))).map(r=>r.data as Task);}
  async saveArtifact(v:Artifact){await this.db.insert(s.artifacts).values({id:v.id,projectId:v.projectId,taskId:v.taskId??null,data:v,createdAt:new Date(v.createdAt)});return v;}
  async getArtifact(projectId:string,id:string){return data<Artifact>((await this.db.select().from(s.artifacts).where(and(eq(s.artifacts.id,id),eq(s.artifacts.projectId,projectId))).limit(1))[0]);}
  async listArtifacts(projectId:string,taskId?:string){const rows=taskId?await this.db.select().from(s.artifacts).where(and(eq(s.artifacts.projectId,projectId),eq(s.artifacts.taskId,taskId))):await this.db.select().from(s.artifacts).where(eq(s.artifacts.projectId,projectId));return rows.map(r=>r.data as Artifact);}
  async saveRun(v:Run){await this.db.insert(s.runs).values({id:v.id,projectId:v.projectId,taskId:v.taskId,operationId:v.operationId,data:v,createdAt:new Date(v.startedAt)}).onConflictDoNothing();return (await this.findRunByOperation(v.projectId,v.operationId))??v;}
  async updateRun(v:Run){await this.db.update(s.runs).set({data:v}).where(and(eq(s.runs.id,v.id),eq(s.runs.projectId,v.projectId)));return v;}
  async getRun(projectId:string,id:string){return data<Run>((await this.db.select().from(s.runs).where(and(eq(s.runs.id,id),eq(s.runs.projectId,projectId))).limit(1))[0]);}
  async findRunByOperation(projectId:string,operationId:string){return data<Run>((await this.db.select().from(s.runs).where(and(eq(s.runs.projectId,projectId),eq(s.runs.operationId,operationId))).limit(1))[0]);}
  async listRuns(projectId:string,taskId?:string){const rows=taskId?await this.db.select().from(s.runs).where(and(eq(s.runs.projectId,projectId),eq(s.runs.taskId,taskId))):await this.db.select().from(s.runs).where(eq(s.runs.projectId,projectId));return rows.map(r=>r.data as Run);}
  async appendTransition(v:Transition){await this.db.insert(s.transitions).values({id:v.id,taskId:v.taskId,data:v,createdAt:new Date(v.timestamp)});}
  async listTransitions(taskId:string){return (await this.db.select().from(s.transitions).where(eq(s.transitions.taskId,taskId)).orderBy(s.transitions.createdAt)).map(r=>r.data as Transition);}
  async appendAudit(v:AuditEvent){await this.db.insert(s.auditEvents).values({id:v.id,projectId:v.projectId,data:v,createdAt:new Date(v.timestamp)});}
  async listAudit(projectId:string){return (await this.db.select().from(s.auditEvents).where(eq(s.auditEvents.projectId,projectId)).orderBy(s.auditEvents.createdAt)).map(r=>r.data as AuditEvent);}
}
function data<T>(row:{data:unknown}|undefined):T|undefined{return row?.data as T|undefined;}
