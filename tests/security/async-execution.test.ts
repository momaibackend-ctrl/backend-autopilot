import { describe, expect, it, vi } from 'vitest';
import { AsyncExecutionCoordinator } from '../../packages/core/src/async-execution.js';
import { testService } from '../helpers/service.js';

async function plannedSandbox() {
  const {store,service}=testService();
  const project=await service.projectCreate({name:'Remote sandbox',slug:`remote-${crypto.randomUUID()}`,sourceType:'LOCAL',environment:'SANDBOX',autonomyMode:'GUARDED'});
  const resource=await service.resourceRegister({projectId:project.id,type:'GITHUB_REPOSITORY',provider:'github',externalReference:'sandbox-owner/sandbox-repository',environment:'SANDBOX',permissions:['READ','WRITE'],secretRefs:[]});
  const task=await service.taskCreate({projectId:project.id,externalKey:'REMOTE-1',title:'Remote implementation',description:'Apply a controlled change',requirements:['Update the sandbox implementation'],relationships:[]});
  await service.taskAnalyze(project.id,task.id);
  await service.taskPlan(project.id,task.id);
  return {store,service,project,resource,task};
}

describe('asynchronous execution security',()=>{
  it('dispatches only once for the same operation id',async()=>{
    const {store,project,resource,task}=await plannedSandbox();
    const dispatch=vi.fn(async()=>({workflowRunId:'workflow-1'}));
    const coordinator=new AsyncExecutionCoordinator(store,{dispatch});
    const input={projectId:project.id,taskId:task.id,operationId:'remote-idempotency-1',changes:[{path:'src/remote.js',content:'export const remote = true;\n'}]};
    const first=await coordinator.enqueueImplementation(input,resource.resourceId);
    const replay=await coordinator.enqueueImplementation(input,resource.resourceId);
    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.job.id).toBe(first.job.id);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await store.listExecutionJobs(project.id,task.id))).toHaveLength(1);
  });

  it('denies a repository registered to another project',async()=>{
    const {store,service,project,task}=await plannedSandbox();
    const other=await service.projectCreate({name:'Other sandbox',slug:`other-${crypto.randomUUID()}`,sourceType:'LOCAL',environment:'SANDBOX',autonomyMode:'GUARDED'});
    const otherResource=await service.resourceRegister({projectId:other.id,type:'GITHUB_REPOSITORY',provider:'github',externalReference:'sandbox-owner/other-repository',environment:'SANDBOX',permissions:['READ','WRITE'],secretRefs:[]});
    const coordinator=new AsyncExecutionCoordinator(store,{dispatch:vi.fn()});
    await expect(coordinator.enqueueImplementation({projectId:project.id,taskId:task.id,operationId:'cross-project-denied',changes:[{path:'src/no.js',content:'export {};\n'}]},otherResource.resourceId)).rejects.toMatchObject({code:'POLICY_VIOLATION'});
    expect(await store.listExecutionJobs(project.id,task.id)).toEqual([]);
  });

  it('allows only one live lease owner to claim a queued job',async()=>{
    const {store,project,resource,task}=await plannedSandbox();
    const coordinator=new AsyncExecutionCoordinator(store,{dispatch:async()=>({})});
    const {job}=await coordinator.enqueueImplementation({projectId:project.id,taskId:task.id,operationId:'lease-test-1',changes:[{path:'src/lease.js',content:'export {};\n'}]},resource.resourceId);
    const first=await store.claimExecutionJob(project.id,job.id,'runner-a','2099-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    const second=await store.claimExecutionJob(project.id,job.id,'runner-b','2099-01-01T00:00:00.000Z','2026-01-01T00:00:01.000Z');
    expect(first?.leaseOwner).toBe('runner-a');
    expect(second).toBeUndefined();
  });
});
