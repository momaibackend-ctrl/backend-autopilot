import { AuditLog } from '../../audit/src/index.js';
import { PolicyEngine } from '../../policy-engine/src/index.js';
import { executeInputSchema, PlatformVersions, taskRebaseInputSchema, type ExecutionJob, type Run, type Task } from '../../schemas/src/index.js';
import { WorkflowEngine } from '../../workflow-engine/src/index.js';
import { ArchitectureViolation, DependencyBlocked, ExecutionFailed, InvalidState, NotFound } from './errors.js';
import type { Clock, IdGenerator, StateStore } from './ports.js';
import { systemClock, uuidGenerator } from './ports.js';
import { deterministicTaskBranch } from './branch.js';
import { detectHardcodedSecret } from '../../secret-scanner/src/index.js';
import { requireProjectGithubRepository } from './repository-guard.js';

export interface ExecutionJobDispatcher {
  dispatch(job:ExecutionJob):Promise<{workflowRunId?:string;workflowRunUrl?:string}>;
}

export type DeterministicExecutionResult = {
  status:'EXECUTION_ACCEPTED';
  jobId:string;
  runId:string;
  mode:'DISPATCHED'|'STATUS_ONLY';
  job:ExecutionJob;
  run:Run;
  idempotentReplay:boolean;
};

function executionResult(job:ExecutionJob,run:Run|undefined,idempotentReplay:boolean):DeterministicExecutionResult{
  if(!job.id||!job.runId||!run?.id||job.runId!==run.id){
    throw new ExecutionFailed('Persisted execution is missing its deterministic job/run identity',{
      jobId:job.id,
      runId:job.runId,
      blockingReport:{
        code:'EXECUTION_IDENTITY_MISSING',
        reason:'An execution cannot be reported as accepted without a durable matching jobId and runId',
        remediation:'Inspect the persisted job/run pair and create a fresh operationId only after the incomplete record is terminalized',
      },
    });
  }
  return {status:'EXECUTION_ACCEPTED',jobId:job.id,runId:run.id,mode:idempotentReplay?'STATUS_ONLY':'DISPATCHED',job,run,idempotentReplay};
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
    const existing=await this.store.findExecutionJobByOperation(project.id,data.operationId);
    if(existing){
      const existingRun=existing.runId?await this.store.getRun(project.id,existing.runId):undefined;
      return executionResult(existing,existingRun,true);
    }
    if(!['PLANNED','IMPLEMENTING'].includes(task.state))throw new InvalidState('Task must be PLANNED or IMPLEMENTING before remote execution');
    await this.policy.authorize({project,action:'EXECUTE',resourceId,requiredPermission:'WRITE',actor});
    await requireProjectGithubRepository(this.store,project.id,resourceId);
    // A delete carries no content, so there is nothing to scan for secret material.
    for(const change of data.changes)if(change.content!==undefined)assertSafeChange(change.path,change.content);
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
      return executionResult(job,run,false);
    }catch(error){
      const reason=error instanceof Error?error.message:'Unknown dispatch error';
      job=await this.store.updateExecutionJob({...job,status:'BLOCKED',error:{code:'DISPATCH_FAILED',message:reason},finishedAt:this.clock.now(),updatedAt:this.clock.now()});
      await this.store.updateRun({...run,status:'FAILED',finishedAt:this.clock.now()});
      throw new ExecutionFailed('Execution dispatch failed; no progress is being reported',{
        jobId:job.id,
        runId:run.id,
        blockingReport:{
          code:'WRITE_DISPATCH_UNAVAILABLE',
          reason,
          remediation:'Restore the configured execution dispatcher, then use a fresh operationId. Repeating this operationId is status-only and must not redispatch.',
        },
      });
    }
  }
  async enqueueRebase(input:unknown,resourceId:string,plan:{sourceBranch:string;sourceCommitSha:string;originalBaseCommit:string;manifestArtifactId:string;rebaseBranchPrefix:string},actor='external-agent'){
    const data=taskRebaseInputSchema.parse(input);
    const project=await this.store.getProject(data.projectId);if(!project)throw new NotFound('Project not found');
    let task=await this.store.getTask(data.projectId,data.taskId);if(!task)throw new NotFound('Task not found');
    const existing=await this.store.findExecutionJobByOperation(project.id,data.operationId);
    if(existing){const existingRun=existing.runId?await this.store.getRun(project.id,existing.runId):undefined;return executionResult(existing,existingRun,true);}
    if(!['READY','IMPLEMENTING','BLOCKED'].includes(task.state))throw new InvalidState('Only a READY task (or one already being re-verified, or blocked awaiting conflict resolution) can be transferred onto a newer base');
    await this.policy.authorize({project,action:'EXECUTE',resourceId,requiredPermission:'WRITE',actor});
    const resource=await requireProjectGithubRepository(this.store,project.id,resourceId);
    for(const resolution of data.resolutions)assertSafeChange(resolution.path,resolution.content);
    if(task.state!=='IMPLEMENTING')task=await this.workflow.transition(task,'IMPLEMENTING',`Transferring verified work onto the current base of ${resource.externalReference}`,actor);
    const now=this.clock.now();
    const run:Run={id:this.ids.next(),projectId:project.id,taskId:task.id,operationId:data.operationId,status:'RUNNING',platformVersion:PlatformVersions.platform,workflowVersion:PlatformVersions.workflow,policyVersion:PlatformVersions.policy,baseCommit:plan.originalBaseCommit,startedAt:now};
    await this.store.saveRun(run);
    let job:ExecutionJob={id:this.ids.next(),projectId:project.id,taskId:task.id,resourceId,runId:run.id,operationId:data.operationId,kind:'REBASE',status:'QUEUED',payload:{rebase:{...plan,resolutions:data.resolutions}},branch:plan.sourceBranch,commitSha:plan.sourceCommitSha,baseCommitSha:plan.originalBaseCommit,attempt:task.repairAttempts,queuedAt:now,updatedAt:now};
    job=await this.store.createExecutionJob(job);
    await this.audit.record({actor,action:'execution.rebase.queued',projectId:project.id,taskId:task.id,resourceId,input:{operationId:data.operationId,sourceBranch:plan.sourceBranch,sourceCommitSha:plan.sourceCommitSha,originalBaseCommit:plan.originalBaseCommit,resolvedPaths:data.resolutions.map(value=>value.path)},result:{jobId:job.id,runId:run.id},reason:'Authorized transfer of verified task work onto the current base branch',correlationId:data.operationId});
    try{
      job=await this.store.updateExecutionJob({...job,status:'DISPATCHING',updatedAt:this.clock.now()});
      const dispatched=await this.dispatcher.dispatch(job);
      job=await this.store.updateExecutionJob({...job,status:'DISPATCHED',...dispatched,updatedAt:this.clock.now()});
      await this.audit.record({actor:'github-actions-dispatcher',action:'execution.job.dispatched',projectId:project.id,taskId:task.id,resourceId,input:{jobId:job.id,kind:'REBASE'},result:{workflowRunId:job.workflowRunId??'pending'},reason:'Execution workflow accepted the safe job identifier',correlationId:data.operationId});
      return executionResult(job,run,false);
    }catch(error){
      const reason=error instanceof Error?error.message:'Unknown dispatch error';
      job=await this.store.updateExecutionJob({...job,status:'BLOCKED',error:{code:'DISPATCH_FAILED',message:reason},finishedAt:this.clock.now(),updatedAt:this.clock.now()});
      await this.store.updateRun({...run,status:'FAILED',finishedAt:this.clock.now()});
      throw new ExecutionFailed('Rebase dispatch failed; no progress is being reported',{jobId:job.id,runId:run.id,blockingReport:{code:'WRITE_DISPATCH_UNAVAILABLE',reason,remediation:'Restore the configured execution dispatcher, then use a fresh operationId.'}});
    }
  }
  async get(projectId:string,jobId:string){const job=await this.store.getExecutionJob(projectId,jobId);if(!job)throw new NotFound('Execution job not found');return job;}
  list(projectId:string,taskId?:string){return this.store.listExecutionJobs(projectId,taskId);}

  private async resolveDependencyBase(projectId:string,task:Task,actor:string):Promise<{branch:string;commitSha:string}|undefined>{
    const dependsOn=task.relationships.filter(relationship=>relationship.type==='DEPENDS_ON');
    if(!dependsOn.length)return undefined;
    const resolved=await Promise.all(dependsOn.map(relationship=>resolvePredecessorEvidence(this.store,projectId,relationship.targetTaskId)));
    const unresolved=dependsOn.filter((relationship,index)=>!resolved[index]).map(relationship=>relationship.targetTaskId);
    if(unresolved.length){
      const reason=`Dependency evidence unresolved for: ${unresolved.join(', ')} (each predecessor must be READY with a verified FINAL_CHANGE_MANIFEST and an exact matching autopilot/* run)`;
      await this.workflow.transition(task,'BLOCKED',reason,actor);
      throw new DependencyBlocked('Required task dependencies have no verifiable execution base',{blocked:unresolved,blockingReport:{code:'DEPENDENCY_EVIDENCE_UNRESOLVED',reason,remediation:'Complete and formally verify each predecessor or repair its FINAL_CHANGE_MANIFEST/run evidence before dispatch.'}});
    }
    const evidence=resolved as {taskId:string;branch:string;commitSha:string}[];
    const distinct=new Map<string,{branch:string;commitSha:string}>();
    for(const value of evidence)distinct.set(`${value.branch}@${value.commitSha}`,{branch:value.branch,commitSha:value.commitSha});
    if(distinct.size>1){
      const bases=[...distinct.values()].map(value=>`${value.branch}@${value.commitSha}`).join(' vs ');
      const reason=`Dependencies resolve to conflicting execution bases (${bases}); a human must resolve which base is correct before execution can proceed`;
      await this.workflow.transition(task,'BLOCKED',reason,actor);
      throw new DependencyBlocked('Task dependencies do not agree on a single verified execution base',{bases:[...distinct.values()],blockingReport:{code:'CONFLICTING_VERIFIED_BASES',reason,remediation:'Resolve the dependency/canon conflict to one verified base before dispatch.'}});
    }
    return [...distinct.values()][0];
  }
}

function assertSafeChange(path:string,content:string){if(detectHardcodedSecret(path,content))throw new ArchitectureViolation('Potential secret material in remote change set is forbidden',{path,blockingReport:{code:'ARCHITECTURE_OR_SECURITY_CONFLICT',reason:`Unsafe change rejected at ${path}`,remediation:'Remove the conflicting secret/architecture violation before execution.'}});}
async function resolvePredecessorEvidence(store:StateStore,projectId:string,predecessorTaskId:string):Promise<{taskId:string;branch:string;commitSha:string}|undefined>{
  const predecessor=await store.getTask(projectId,predecessorTaskId);
  if(!predecessor||predecessor.state!=='READY')return undefined;
  const artifacts=await store.listArtifacts(projectId,predecessorTaskId);
  const manifest=[...artifacts].reverse().find(artifact=>artifact.kind==='FINAL_CHANGE_MANIFEST'&&artifact.status==='AVAILABLE');
  const verifiedCommitSha=(manifest?.content as {verifiedCommitSha?:string}|undefined)?.verifiedCommitSha;
  if(!verifiedCommitSha)return undefined;
  const runs=await store.listRuns(projectId,predecessorTaskId);
  // READY + FINAL_CHANGE_MANIFEST is the formal verification boundary. A historical runner status
  // must not become a second truth source after a later formal review verified this exact commit.
  // Keep the actual code identity strict: only an autopilot branch carrying the manifest SHA is a
  // valid dependency base.
  const run=[...runs].reverse().find(candidate=>candidate.commitSha===verifiedCommitSha&&candidate.branch?.startsWith('autopilot/'));
  if(!run?.branch)return undefined;
  return {taskId:predecessorTaskId,branch:run.branch,commitSha:verifiedCommitSha};
}
