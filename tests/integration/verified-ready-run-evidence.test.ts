import { describe, expect, it, vi } from 'vitest';
import { AsyncExecutionCoordinator } from '../../packages/core/src/async-execution.js';
import { resolveMergeableCommit } from '../../packages/superadmin/src/merge-eligibility.js';
import type { Artifact, Resource, Run, Task } from '../../packages/schemas/src/index.js';
import { testService } from '../helpers/service.js';

const projectId='22222222-2222-2222-2222-222222222222';
const taskId='11111111-1111-1111-1111-111111111111';
const commitSha='a'.repeat(40);
const branch='autopilot/CORE-BE-18-observability';
const readyTask={id:taskId,projectId,externalKey:'CORE-BE-18',title:'Task',description:'d',requirements:['r'],relationships:[],state:'READY',repairAttempts:0,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'} as unknown as Task;
const resource={resourceId:'33333333-3333-3333-3333-333333333333',projectId,type:'GITHUB_REPOSITORY',provider:'github',externalReference:'owner/repo',environment:'SANDBOX',permissions:['READ','WRITE','ADMIN'],secretRefs:[],status:'ACTIVE'} as unknown as Resource;
const manifest={id:'44444444-4444-4444-4444-444444444444',projectId,taskId,kind:'FINAL_CHANGE_MANIFEST',status:'AVAILABLE',content:{verifiedCommitSha:commitSha},contentHash:'hash',createdAt:'2026-01-01T00:00:00.000Z'} as unknown as Artifact;
const failedButVerifiedRun={id:'55555555-5555-5555-5555-555555555555',projectId,taskId,operationId:'op-1',status:'FAILED',commitSha,branch,platformVersion:'1',workflowVersion:'1',policyVersion:'1',startedAt:'2026-01-01T00:00:00.000Z'} as unknown as Run;

describe('verified READY evidence survives runner finalization failures',()=>{
  it('allows guarded merge when READY manifest and latest run identify the exact same commit',()=>{
    expect(resolveMergeableCommit({task:readyTask,resource,runs:[failedButVerifiedRun],artifacts:[manifest]})).toEqual({branch,commitSha});
  });

  it('still rejects a failed run whose commit differs from the verified manifest',()=>{
    expect(()=>resolveMergeableCommit({task:readyTask,resource,runs:[{...failedButVerifiedRun,commitSha:'b'.repeat(40)}],artifacts:[manifest]})).toThrow(/verified commit evidence/i);
  });

  it('uses the exact formally verified predecessor as a dependency base even if its runner later recorded FAILED',async()=>{
    const {store,service}=testService();
    const project=await service.projectCreate({name:'Verified dependency',slug:`verified-${crypto.randomUUID()}`,sourceType:'LOCAL',environment:'SANDBOX',autonomyMode:'GUARDED'});
    const repo=await service.resourceRegister({projectId:project.id,type:'GITHUB_REPOSITORY',provider:'github',externalReference:'sandbox-owner/sandbox-repository',environment:'SANDBOX',permissions:['READ','WRITE'],secretRefs:[]});
    const predecessor=await service.taskCreate({projectId:project.id,externalKey:'CORE-BE-18',title:'Predecessor',description:'d',requirements:['r'],relationships:[]});
    const predecessorSha='c'.repeat(40);const predecessorBranch='autopilot/CORE-BE-18-predecessor';
    await store.updateTask({...predecessor,state:'READY'});
    await store.saveArtifact({id:crypto.randomUUID(),projectId:project.id,taskId:predecessor.id,kind:'FINAL_CHANGE_MANIFEST',schemaVersion:'1',content:{verifiedCommitSha:predecessorSha},contentHash:'hash',status:'AVAILABLE',createdAt:new Date().toISOString()} as never);
    await store.saveRun({id:crypto.randomUUID(),projectId:project.id,taskId:predecessor.id,operationId:'failed-after-review',status:'FAILED',commitSha:predecessorSha,branch:predecessorBranch,platformVersion:'1',workflowVersion:'1',policyVersion:'1',startedAt:new Date().toISOString()} as never);
    const dependent=await service.taskCreate({projectId:project.id,externalKey:'CORE-BE-19',title:'Dependent',description:'d',requirements:['r'],relationships:[{type:'DEPENDS_ON',targetTaskId:predecessor.id}]});
    await service.taskAnalyze(project.id,dependent.id);await service.taskPlan(project.id,dependent.id);
    const coordinator=new AsyncExecutionCoordinator(store,{dispatch:vi.fn(async()=>({workflowRunId:'wf-verified'}))});
    const {job}=await coordinator.enqueueImplementation({projectId:project.id,taskId:dependent.id,operationId:'verified-dependency-op',changes:[{path:'src/next.ts',content:'export const next = true;\n'}]},repo.resourceId);
    expect(job.baseBranch).toBe(predecessorBranch);expect(job.baseCommitSha).toBe(predecessorSha);
  });
});
