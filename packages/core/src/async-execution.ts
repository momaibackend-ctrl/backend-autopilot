import { AuditLog } from '../../audit/src/index.js';
import { PolicyEngine } from '../../policy-engine/src/index.js';
import { executeInputSchema, PlatformVersions, type ExecutionJob, type Run, type Task } from '../../schemas/src/index.js';
import { WorkflowEngine } from '../../workflow-engine/src/index.js';
import { ArchitectureViolation, DependencyBlocked, InvalidState, NotFound } from './errors.js';
import type { Clock, IdGenerator, StateStore } from './ports.js';
import { systemClock, uuidGenerator } from './ports.js';
import { deterministicTaskBranch } from './branch.js';
import { detectHardcodedSecret } from '../../secret-scanner/src/index.js';

export interface ExecutionJobDispatcher {
  dispatch(job:ExecutionJob):Promise<{workflowRunId?:string;workflowRunUrl?:string}>;
}

export class AsyncExecutionCoordinator {
  private readonly policy:PolicyEngine;
  private readonly workflow:WorkflowEngine;
  private readonly audit:AuditLog;
  constructor(private readonly store:StateStore,private readonly dispatcher:ExecutionJobDispatcher,private readonly clock:Clock=systemClock,private readonly ids:IdGenerator=uuidGenerator){
    this.policy=new PolicyEngine(store);this.workflow=new WorkflowEngine(store,ids,clock);this.audit=new AuditLog(store,ids,clock);
  }
  async enqueueImplementation(input:unknown,resourceId:string,actor='external-agent'){
    const data=executeInputSchema.parse(input);const project=await this.store.getProject(data.projectId);if(!project)throw new NotFound('Project not found');let task=await this.store.getTask(data.projectId,data.taskId);if(!task)throw new NotFound('Task not found');
    const existing=await this.store.findExecutionJobByOperation(project.id,data.operationId);if(existing)return {job:existing,run:existing.runId?await this.store.getRun(project.id,existing.runId):undefined,idempotentReplay:true};
    if(!['PLANNED','IMPLEMENTING'].includes(task.state))throw new InvalidState('Task must be PLANNED or IMPLEMENTING before remote execution');
    await this.policy.authorize({project,action:'EXECUTE',resourceId,requiredPermission:'WRITE',actor});const resource=await this.store.getResource(resourceId);
    if(!resource||resource.projectId!==project.id||resource.type!=='GITHUB_REPOSITORY'||resource.provider!=='github')throw new ArchitectureViolation('Remote execution requires a project-owned registered GitHub repository');
    for(const change of data.changes)assertSafeChange(change.path,change.content);
    const dependencyBase=await this.resolveDependencyBase(project.id,task,actor);
    if(task.state==='PLANNED')task=await this.workflow.transition(task,'IMPLEMENTING','Remote execution job queued',actor);
    const now=this.clock.now();const run:Run={id:this.ids.next(),projectId:project.id,taskId:task.id,operationId:data.operationId,status:'RUNNING',platformVersion:PlatformVersions.platform,workflowVersion:PlatformVersions.workflow,policyVersion:PlatformVersions.policy,startedAt:now};
    await this.store.saveRun(run);
    const previous=(await this.store.listExecutionJobs(project.id,task.id)).filter(value=>value.commitSha).at(-1);
    let job:ExecutionJob={id:this.ids.next(),projectId:project.id,taskId:task.id,resourceId,runId:run.id,operationId:data.operationId,kind:task.repairAttempts?'REPAIR':'IMPLEMENTATION',status:'QUEUED',payload:{changes:data.changes},branch:deterministicTaskBranch(task),...(previous?.commitSha?{commitSha:previous.commitSha}:{}),...(dependencyBase?{baseBranch:dependencyBase.branch,baseCommitSha:dependencyBase.commitSha}:{}),attempt:task.repairAttempts,queuedAt:now,updatedAt:now};
    job=await this.store.createExecutionJob(job);
    await this.audit.record({actor,action:'execution.job.queued',projectId:project.id,taskId:task.id,resourceId,input:{operationId:data.operationId,changePaths:data.changes.map(value=>value.path)},result:{jobId:job.id,runId:run.id},reason:'Authorized asynchronous GitHub Actions execution',correlationId:data.operationId});
    try{
      job=await this.store.updateExecutionJob({...job,status:'DISPATCHING',updatedAt:this.clock.now()});const dispatched=await this.dispatcher.dispatch(job);job=await this.store.updateExecutionJob({...job,status:'DISPATCHED',...dispatched,updatedAt:this.clock.now()});
      await this.audit.record({actor:'github-actions-dispatcher',action:'execution.job.dispatched',projectId:project.id,taskId:task.id,resourceId,input:{jobId:job.id},result:{workflowRunId:job.workflowRunId??'pending'},reason:'Execution workflow accepted the safe job identifier',correlationId:data.operationId});
      return {job,run,idempotentReplay:false};
    }catch(error){job=await this.store.updateExecutionJob({...job,status:'QUEUED',error:{code:'DISPATCH_FAILED',message:error instanceof Error?error.message:'Unknown dispatch error'},updatedAt:this.clock.now()});throw error;}
  }
  async get(projectId:string,jobId:string){const job=await this.store.getExecutionJob(projectId,jobId);if(!job)throw new NotFound('Execution job not found');return job;}
  list(projectId:string,taskId?:string){return this.store.listExecutionJobs(projectId,taskId);}

  // Resolves the exact verified predecessor branch/commit a dependent task's execution should
  // start from, entirely from durable evidence (never a caller-controlled baseRef). Any predecessor
  // that isn't READY, or is READY but has no resolvable evidence, fails closed -- it BLOCKs the task
  // rather than silently falling back to the registered repository's default branch, which would
  // silently reproduce the exact bug this exists to fix (losing an unmerged predecessor's changes).
  // With two or more DEPENDS_ON predecessors, a single verified base is only used when every
  // predecessor agrees on the identical branch and commit; any disagreement also fails closed, since
  // there is no merge-base logic here to safely pick between conflicting bases.
  private async resolveDependencyBase(projectId:string,task:Task,actor:string):Promise<{branch:string;commitSha:string}|undefined>{
    const dependsOn=task.relationships.filter(relationship=>relationship.type==='DEPENDS_ON');
    if(!dependsOn.length)return undefined;
    const resolved=await Promise.all(dependsOn.map(relationship=>resolvePredecessorEvidence(this.store,projectId,relationship.targetTaskId)));
    const unresolved=dependsOn.filter((relationship,index)=>!resolved[index]).map(relationship=>relationship.targetTaskId);
    if(unresolved.length){
      const reason=`Dependency evidence unresolved for: ${unresolved.join(', ')} (each predecessor must be READY with a verified FINAL_CHANGE_MANIFEST and a SUCCEEDED run on an autopilot/* branch)`;
      await this.workflow.transition(task,'BLOCKED',reason,actor);
      throw new DependencyBlocked('Required task dependencies have no verifiable execution base',{blocked:unresolved});
    }
    const evidence=resolved as {taskId:string;branch:string;commitSha:string}[];
    const distinct=new Map<string,{branch:string;commitSha:string}>();
    for(const value of evidence)distinct.set(`${value.branch}@${value.commitSha}`,{branch:value.branch,commitSha:value.commitSha});
    if(distinct.size>1){
      const bases=[...distinct.values()].map(value=>`${value.branch}@${value.commitSha}`).join(' vs ');
      const reason=`Dependencies resolve to conflicting execution bases (${bases}); a human must resolve which base is correct before execution can proceed`;
      await this.workflow.transition(task,'BLOCKED',reason,actor);
      throw new DependencyBlocked('Task dependencies do not agree on a single verified execution base',{bases:[...distinct.values()]});
    }
    return [...distinct.values()][0];
  }
}

function assertSafeChange(path:string,content:string){if(detectHardcodedSecret(path,content))throw new ArchitectureViolation('Potential secret material in remote change set is forbidden',{path});}
async function resolvePredecessorEvidence(store:StateStore,projectId:string,predecessorTaskId:string):Promise<{taskId:string;branch:string;commitSha:string}|undefined>{
  const predecessor=await store.getTask(projectId,predecessorTaskId);
  if(!predecessor||predecessor.state!=='READY')return undefined;
  const artifacts=await store.listArtifacts(projectId,predecessorTaskId);
  const manifest=[...artifacts].reverse().find(artifact=>artifact.kind==='FINAL_CHANGE_MANIFEST'&&artifact.status==='AVAILABLE');
  const verifiedCommitSha=(manifest?.content as {verifiedCommitSha?:string}|undefined)?.verifiedCommitSha;
  if(!verifiedCommitSha)return undefined;
  const runs=await store.listRuns(projectId,predecessorTaskId);
  const run=runs.find(candidate=>candidate.status==='SUCCEEDED'&&candidate.commitSha===verifiedCommitSha&&candidate.branch?.startsWith('autopilot/'));
  if(!run?.branch)return undefined;
  return {taskId:predecessorTaskId,branch:run.branch,commitSha:verifiedCommitSha};
}
