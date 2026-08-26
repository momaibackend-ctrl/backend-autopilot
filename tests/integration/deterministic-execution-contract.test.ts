import { describe, expect, it, vi } from 'vitest';
import { AsyncExecutionCoordinator } from '../../packages/core/src/async-execution.js';
import { testService } from '../helpers/service.js';

async function fixture(){
  const {store,service}=testService();
  const project=await service.projectCreate({name:'Execution contract',slug:`execution-contract-${crypto.randomUUID()}`,sourceType:'LOCAL',environment:'SANDBOX',autonomyMode:'GUARDED'});
  const resource=await service.resourceRegister({projectId:project.id,type:'GITHUB_REPOSITORY',provider:'github',externalReference:'sandbox-owner/backend-autopilot',environment:'SANDBOX',permissions:['READ','WRITE'],secretRefs:[]});
  const task=await service.taskCreate({projectId:project.id,externalKey:'EXEC-1',title:'Execution contract',description:'d',requirements:['r'],relationships:[]});
  await service.taskAnalyze(project.id,task.id);await service.taskPlan(project.id,task.id);
  return {store,service,project,resource,task};
}

const changes=[{path:'src/change.ts',content:'export const changed = true;\n'}];

describe('deterministic asynchronous execution contract',()=>{
  it('returns durable jobId/runId and turns an operation replay into status-only without redispatch',async()=>{
    const {store,project,resource,task}=await fixture();
    const dispatch=vi.fn(async()=>({workflowRunId:'wf-1'}));
    const coordinator=new AsyncExecutionCoordinator(store,{dispatch});
    const first=await coordinator.enqueueImplementation({projectId:project.id,taskId:task.id,operationId:'deterministic-op-1',changes},resource.resourceId);
    const replay=await coordinator.enqueueImplementation({projectId:project.id,taskId:task.id,operationId:'deterministic-op-1',changes},resource.resourceId);
    expect(first).toMatchObject({status:'EXECUTION_ACCEPTED',mode:'DISPATCHED',idempotentReplay:false});
    expect(first.jobId).toBe(first.job.id);expect(first.runId).toBe(first.run.id);
    expect(replay).toMatchObject({status:'EXECUTION_ACCEPTED',mode:'STATUS_ONLY',idempotentReplay:true,jobId:first.jobId,runId:first.runId});
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await store.listExecutionJobs(project.id,task.id))).toHaveLength(1);
    expect((await store.listRuns(project.id,task.id))).toHaveLength(1);
  });

  it('terminalizes dispatch failure and returns a structured blocking report rather than pseudo-progress',async()=>{
    const {store,project,resource,task}=await fixture();
    const coordinator=new AsyncExecutionCoordinator(store,{dispatch:vi.fn(async()=>{throw new Error('write tool offline');})});
    await expect(coordinator.enqueueImplementation({projectId:project.id,taskId:task.id,operationId:'deterministic-op-2',changes},resource.resourceId)).rejects.toMatchObject({code:'EXECUTION_FAILED',details:{blockingReport:{code:'WRITE_DISPATCH_UNAVAILABLE'}}});
    const [job]=await store.listExecutionJobs(project.id,task.id);const [run]=await store.listRuns(project.id,task.id);
    expect(job.status).toBe('BLOCKED');expect(run.status).toBe('FAILED');expect(job.id).toBeTruthy();expect(run.id).toBeTruthy();
  });

  it('does not mutate historical CANCELLED execution records when a fresh operation is dispatched',async()=>{
    const {store,project,resource,task}=await fixture();
    const oldRun={id:crypto.randomUUID(),projectId:project.id,taskId:task.id,operationId:'old-cancelled-op',status:'CANCELLED',platformVersion:'1',workflowVersion:'1',policyVersion:'1',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString()} as never;
    await store.saveRun(oldRun);
    const oldJob={id:crypto.randomUUID(),projectId:project.id,taskId:task.id,resourceId:resource.resourceId,runId:(oldRun as {id:string}).id,operationId:'old-cancelled-op',kind:'IMPLEMENTATION',status:'CANCELLED',payload:{changes},branch:'autopilot/old',attempt:0,queuedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),finishedAt:new Date().toISOString()} as never;
    await store.createExecutionJob(oldJob);
    const coordinator=new AsyncExecutionCoordinator(store,{dispatch:vi.fn(async()=>({workflowRunId:'wf-new'}))});
    const fresh=await coordinator.enqueueImplementation({projectId:project.id,taskId:task.id,operationId:'fresh-after-cancelled',changes},resource.resourceId);
    expect(fresh.jobId).not.toBe((oldJob as {id:string}).id);expect(fresh.runId).not.toBe((oldRun as {id:string}).id);
    expect((await store.getExecutionJob(project.id,(oldJob as {id:string}).id))?.status).toBe('CANCELLED');
    expect((await store.getRun(project.id,(oldRun as {id:string}).id))?.status).toBe('CANCELLED');
    expect((await store.listExecutionJobs(project.id,task.id))).toHaveLength(2);
  });

  it('fails closed when an idempotent replay points at a job without a durable run identity',async()=>{
    const {store,project,resource,task}=await fixture();
    const broken={id:crypto.randomUUID(),projectId:project.id,taskId:task.id,resourceId:resource.resourceId,operationId:'broken-identity-op',kind:'IMPLEMENTATION',status:'CANCELLED',payload:{changes},branch:'autopilot/broken',attempt:0,queuedAt:new Date().toISOString(),updatedAt:new Date().toISOString()} as never;
    await store.createExecutionJob(broken);
    const coordinator=new AsyncExecutionCoordinator(store,{dispatch:vi.fn(async()=>({}))});
    await expect(coordinator.enqueueImplementation({projectId:project.id,taskId:task.id,operationId:'broken-identity-op',changes},resource.resourceId)).rejects.toMatchObject({code:'EXECUTION_FAILED',details:{blockingReport:{code:'EXECUTION_IDENTITY_MISSING'}}});
  });
});
