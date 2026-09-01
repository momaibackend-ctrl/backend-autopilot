import 'dotenv/config';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { ArtifactStore } from '../packages/artifact-store/src/index.js';
import { AuditLog } from '../packages/audit/src/index.js';
import { R2ArtifactBlobStore, readR2ConfigFromEnv } from '../packages/adapters/r2/src/artifact-storage.js';
import { SupabaseStorageArtifactBlobStore } from '../packages/adapters/supabase/src/artifact-storage.js';
import { LiveGitHubAdapter } from '../packages/adapters/github/src/index.js';
import { LocalGitAdapter } from '../packages/adapters/git/src/index.js';
import { AutopilotService } from '../packages/core/src/application.js';
import { ExecutionFailed, PolicyViolation } from '../packages/core/src/errors.js';
import { systemClock, uuidGenerator } from '../packages/core/src/ports.js';
import type { StateStore } from '../packages/core/src/ports.js';
import { CommandPolicy, CommandRunner, ExecutionEngine, StackAwareTestExecutor, applyResolutions, assertBaseChangesPreserved, assertDependencyMerged, commitTransfer, detectStack, disposeWorkspaceDirectory, ensureDisposableCleanWorkspace, provisionGradleWrapper, resolveBranchContinuity, taskChangedPaths, transferTaskCommits, workspaceCheckoutExists, type RebaseGit } from '../packages/execution-engine/src/index.js';
import { PolicyEngine } from '../packages/policy-engine/src/index.js';
import { requireProjectGithubRepository } from '../packages/core/src/repository-guard.js';
import { PostgresStateStore } from '../packages/project-registry/src/index.js';
import { fileChangeSchema, rebaseConflictResolutionSchema, type ExecutionJob } from '../packages/schemas/src/index.js';
import { rebaseBranchName } from '../packages/superadmin/src/rebase-eligibility.js';
import { WorkflowEngine } from '../packages/workflow-engine/src/index.js';
import { DependencyBlocked } from '../packages/core/src/errors.js';

const inputSchema=z.object({changes:z.array(fileChangeSchema).min(1)});
const rebasePayloadSchema=z.object({rebase:z.object({sourceBranch:z.string().min(1),sourceCommitSha:z.string().regex(/^[0-9a-f]{40}$/),originalBaseCommit:z.string().regex(/^[0-9a-f]{40}$/),manifestArtifactId:z.string().uuid(),rebaseBranchPrefix:z.string().min(1),resolutions:z.array(rebaseConflictResolutionSchema).default([])})});
const jobId=argument('--job')??process.env['AUTOPILOT_JOB_ID'];
const databaseUrl=required('DATABASE_URL');
const githubToken=required('AUTOPILOT_GITHUB_TOKEN');
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are only resolved below, inside the ArtifactBlobStore
// selection, so a fully configured AUTOPILOT_R2_* set never needs to require them.
if(!jobId||!z.string().uuid().safeParse(jobId).success)throw new Error('A valid --job identifier is required');
const store=new PostgresStateStore(databaseUrl);const owner=`github-actions:${process.env['GITHUB_RUN_ID']??crypto.randomUUID()}:${process.env['GITHUB_RUN_ATTEMPT']??'1'}`;
const initial=await store.getExecutionJobById(jobId);if(!initial)throw new Error('Execution job not found');
const leaseExpiresAt=new Date(Date.now()+20*60_000).toISOString();const claimed=await store.claimExecutionJob(initial.projectId,initial.id,owner,leaseExpiresAt,systemClock.now());if(!claimed)throw new Error('Execution job is already claimed by another runner');let current:ExecutionJob=claimed;
const commands=new CommandRunner(new CommandPolicy(),systemClock);const git=new LocalGitAdapter(commands);const tests=new StackAwareTestExecutor(commands,systemClock);const execution=new ExecutionEngine(git,systemClock);
const r2Config=readR2ConfigFromEnv(name=>process.env[name]);
const blobs=r2Config?new R2ArtifactBlobStore(r2Config.accountId,r2Config.bucketName,r2Config.accessKeyId,r2Config.secretAccessKey):new SupabaseStorageArtifactBlobStore(required('SUPABASE_URL'),required('SUPABASE_SERVICE_ROLE_KEY'));
const artifacts=new ArtifactStore(store,uuidGenerator,systemClock,blobs);const audit=new AuditLog(store,uuidGenerator,systemClock);const service=new AutopilotService({store,execution,tests,git,commands,artifactBlobs:blobs});
try{
  // Stamp the GitHub run identity onto the job the moment it is actually running. The dispatch
  // endpoint answers 204 with an empty body, so the dispatcher never learns the run id -- which
  // left the reconciler blind to every job it dispatched. The runner is the first component that
  // knows the id, so it is the one that has to record it.
  const workflowRunId=process.env['GITHUB_RUN_ID'];
  const workflowRunUrl=process.env['GITHUB_SERVER_URL']&&process.env['GITHUB_REPOSITORY']&&workflowRunId?`${process.env['GITHUB_SERVER_URL']}/${process.env['GITHUB_REPOSITORY']}/actions/runs/${workflowRunId}`:undefined;
  current=await store.updateExecutionJob({...current,status:'RUNNING',...(workflowRunId?{workflowRunId}:{}),...(workflowRunUrl?{workflowRunUrl}:{}),startedAt:current.startedAt??systemClock.now(),updatedAt:systemClock.now()});const project=await store.getProject(current.projectId);const task=await store.getTask(current.projectId,current.taskId);if(!project||!task)throw new ExecutionFailed('Execution job references missing registered state');
  // requireProjectGithubRepository closes a real gap this script previously had: it fetched the
  // resource by id alone, with no check that it actually belongs to this job's project -- the same
  // invariant every other resource-consuming entry point enforces (see repository-guard.ts).
  const resource=await requireProjectGithubRepository(store,project.id,current.resourceId);
  await new PolicyEngine(store).authorize({project,action:'EXECUTE',resourceId:resource.resourceId,requiredPermission:'WRITE',actor:owner});if(resource.environment!=='SANDBOX')throw new PolicyViolation('Execution job target is not an allowlisted sandbox GitHub repository');
  const rebase=current.kind==='REBASE'?rebasePayloadSchema.parse(current.payload).rebase:undefined;
  const payload=rebase?{changes:[]}:inputSchema.parse(current.payload);
  // The runner workspace is disposable. If the restored task branch plus dependency install
  // leaves an unclean tree, ExecutionEngine's clean-tree precondition would fail this job before
  // the payload was ever applied. The precondition is kept as the detector: the dirty tree is
  // captured as WORKSPACE_QUARANTINE evidence, the attempt is marked quarantined in the
  // append-only audit trail, the directory is deleted and a brand-new checkout is taken for THE
  // SAME job. Nothing external is repeated: this runs strictly before push/test/review, and the
  // durable job/run checkpoints are untouched, so the job resumes rather than restarts.
  const acquired=await ensureDisposableCleanWorkspace({
    now:()=>systemClock.now(),
    exists:workspaceCheckoutExists,
    create:async()=>{const created=await prepareWorkspace(resource.externalReference,current,commands,githubToken,store);await installTargetDependencies(created,current,commands,await detectStack(created));return created;},
    inspect:async workspace=>{
      const status=await commands.run({command:'git',args:['status','--porcelain'],cwd:workspace,taskId:current.taskId,allowed:['READ']});
      const diff=await commands.run({command:'git',args:['diff','HEAD'],cwd:workspace,taskId:current.taskId,allowed:['READ']});
      return {status:status.record.exitCode===0?status.stdout:`!! git status failed\n${status.stderr}`,diff:diff.record.exitCode===0?diff.stdout:''};
    },
    dispose:workspace=>disposeWorkspaceDirectory(workspace,workspaceRoot()),
    quarantine:async record=>{
      const artifact=await artifacts.write(project.id,'WORKSPACE_QUARANTINE',{quarantined:true,scope:'EXECUTION_JOB',jobId:current.id,operationId:current.operationId,...record},task.id,current.runId);
      await audit.record({actor:owner,action:'execution.workspace.quarantined',projectId:project.id,taskId:task.id,resourceId:resource.resourceId,input:{jobId:current.id,attempt:record.attempt},result:{artifactId:artifact.id,statusTruncated:record.statusTruncated,diffTruncated:record.diffTruncated},reason:'Interrupted run left an unclean workspace; the attempt is quarantined and a clean checkout taken for the same job',correlationId:current.operationId});
      console.log(JSON.stringify({level:'warn',event:'execution.workspace.quarantined',jobId:current.id,attempt:record.attempt,artifactId:artifact.id}));
    },
  });
  const workspace=acquired.workspace;const stack=await detectStack(workspace);
  const rebaseOutcome=rebase?await performRebase({workspace,job:current,commands,rebase,githubToken,artifacts,audit,store,project,task,resource,owner}):undefined;
  const result=rebaseOutcome?rebaseOutcome.result:await execution.execute({workspace,task,changes:payload.changes});
  const provisionedWrapperSha=await commitProvisionedGradleWrapper(workspace,current,commands,git);const commitSha=provisionedWrapperSha??result.commitSha;
  current=await store.updateExecutionJob({...current,baseCommit:result.baseCommit,branch:result.branch,commitSha,updatedAt:systemClock.now()});
  await artifacts.write(project.id,'CODE_DIFF',{diff:result.diff,changedFiles:result.changedFiles},task.id,current.runId);
  const migrationFiles=rebaseOutcome?[]:payload.changes.filter(value=>/migrations?\//.test(value.path));if(migrationFiles.length)await artifacts.write(project.id,'MIGRATION_MANIFEST',{migrations:migrationFiles.map(value=>({path:value.path,content:value.content})),validation:'Pending migration test gate',rollback:'Implementation plan rollback strategy'},task.id,current.runId);
  const apiFiles=rebaseOutcome?[]:payload.changes.filter(value=>/openapi/i.test(value.path)&&value.content!==undefined);if(apiFiles.length)await artifacts.write(project.id,'API_CONTRACT',{contracts:apiFiles.map(value=>({path:value.path,document:(/\.ya?ml$/i.test(value.path)?parseYaml(value.content as string):JSON.parse(value.content as string)) as unknown}))},task.id,current.runId);
  await new LiveGitHubAdapter(commands).push(resource,{workspace,branch:result.branch,correlationId:task.id});
  if(current.runId){const run=await store.getRun(project.id,current.runId);if(run)await store.updateRun({...run,baseCommit:result.baseCommit,branch:result.branch,commitSha});}
  await service.taskTest(project.id,task.id,owner,current.operationId,workspace);
  const toolchain=stack==='KOTLIN_GRADLE'?await gradleToolchainVersions(workspace,current,commands):undefined;
  await artifacts.write(project.id,'CI_REPORT',{provider:'github-actions',repository:resource.externalReference,branch:result.branch,expectedSha:commitSha,detectedStack:stack,...(toolchain?{toolchain}:{}),...(provisionedWrapperSha?{gradleWrapperProvisioned:true}:{}),ci:{success:true,status:'completed',conclusion:'success',headSha:commitSha,url:process.env['GITHUB_SERVER_URL']&&process.env['GITHUB_REPOSITORY']&&process.env['GITHUB_RUN_ID']?`${process.env['GITHUB_SERVER_URL']}/${process.env['GITHUB_REPOSITORY']}/actions/runs/${process.env['GITHUB_RUN_ID']}`:undefined}},task.id,current.runId);
  await service.taskReview(project.id,task.id,owner,current.operationId);
  // Nothing was transferred when the target base already carried the verified commit, so there
  // is no diff to raise as a pull request -- GitHub rejects one with zero commits between head
  // and base, and there would be nothing for a reviewer to look at besides the merge already on
  // the base branch.
  const publication=rebaseOutcome&&!rebaseOutcome.alreadyIntegrated?await publishRebasedPullRequest({repository:resource.externalReference,token:githubToken,head:result.branch,base:rebaseOutcome.targetBaseBranch,task,staleHead:rebase!.sourceBranch}):undefined;
  if(rebaseOutcome)await artifacts.write(project.id,'REBASE_REPORT',{...rebaseOutcome.report,status:rebaseOutcome.alreadyIntegrated?'ALREADY_INTEGRATED':'REBASED',rebasedCommitSha:commitSha,pullRequest:publication?.opened,supersededPullRequests:publication?.superseded??[]},task.id,current.runId);
  if(current.runId){const run=await store.getRun(project.id,current.runId);if(run)await store.updateRun({...run,status:'SUCCEEDED',baseCommit:result.baseCommit,branch:result.branch,commitSha,finishedAt:systemClock.now()});}
  current=await store.updateExecutionJob({...current,status:'SUCCEEDED',leaseOwner:owner,leaseExpiresAt:systemClock.now(),finishedAt:systemClock.now(),updatedAt:systemClock.now(),result:{branch:result.branch,commitSha,changedFiles:result.changedFiles}});
  await audit.record({actor:owner,action:'execution.job.succeeded',projectId:project.id,taskId:task.id,resourceId:resource.resourceId,input:{jobId:current.id},result:{runId:current.runId,branch:result.branch,commitSha},reason:'GitHub Actions execution, tests and review completed',correlationId:current.operationId});
  console.log(JSON.stringify({level:'info',event:'execution.job.succeeded',jobId:current.id,branch:result.branch,commitSha}));
}catch(error){
  const task=await store.getTask(current.projectId,current.taskId);
  // TESTING and REVIEWING only exist while taskTest/taskReview are actively running; a task must
  // never be observed at rest in either one. If this job crashes while the task is stuck there
  // (MOMNA-1063: a transient artifact-storage failure threw out of taskTest after it had already
  // transitioned into TESTING but before the pass/fail-driven transition that should have
  // followed), force it to BLOCKED here, synchronously, rather than leaving it stranded forever --
  // the async reconciler only ever fixes up IMPLEMENTING, never TESTING/REVIEWING.
  const strandedInFlight=Boolean(task&&(task.state==='TESTING'||task.state==='REVIEWING'));
  if(task&&strandedInFlight)await new WorkflowEngine(store,uuidGenerator,systemClock).transition(task,'BLOCKED',`Execution job crashed while task was ${task.state}: ${error instanceof Error?error.message:'unknown error'}`,'execution-runner');
  const status=(task?.state==='BLOCKED'||strandedInFlight)?'BLOCKED':'FAILED';current=await store.updateExecutionJob({...current,status,leaseExpiresAt:systemClock.now(),finishedAt:systemClock.now(),updatedAt:systemClock.now(),error:{code:error instanceof Error?error.name:'UNKNOWN',message:error instanceof Error?error.message:'Unknown execution failure'}});if(current.runId){const run=await store.getRun(current.projectId,current.runId);if(run&&run.status==='RUNNING')await store.updateRun({...run,status:status==='BLOCKED'?'BLOCKED':'FAILED',finishedAt:systemClock.now(),...(current.branch?{branch:current.branch}:{}),...(current.commitSha?{commitSha:current.commitSha}:{})});}await audit.record({actor:owner,action:'execution.job.failed',projectId:current.projectId,taskId:current.taskId,resourceId:current.resourceId,input:{jobId:current.id},result:{status,error:error instanceof Error?error.name:'UNKNOWN'},reason:'GitHub Actions execution failed; durable state preserved',correlationId:current.operationId});throw error;
}finally{await store.close();}

function workspaceRoot(){return process.env['RUNNER_TEMP']??process.cwd();}
async function prepareWorkspace(repository:string,job:ExecutionJob,commands:CommandRunner,token:string,store:StateStore){if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))throw new PolicyViolation('Registered repository identity is invalid');const root=workspaceRoot();const workspace=await mkdtemp(join(root,'backend-autopilot-'));const env={GH_TOKEN:token};await checked(commands,{command:'gh',args:['auth','setup-git'],cwd:root,taskId:job.taskId,allowed:['NETWORK'],env});await checked(commands,{command:'gh',args:['repo','clone',repository,workspace,'--','--no-tags'],cwd:root,taskId:job.taskId,allowed:['NETWORK'],env});await checked(commands,{command:'git',args:['config','user.email','autopilot@localhost.invalid'],cwd:workspace,taskId:job.taskId,allowed:['BUILD']});await checked(commands,{command:'git',args:['config','user.name','Backend Autopilot'],cwd:workspace,taskId:job.taskId,allowed:['BUILD']});
  if(job.branch){
    const remote=await commands.run({command:'git',args:['ls-remote','--exit-code','--heads','origin',job.branch],cwd:workspace,taskId:job.taskId,allowed:['NETWORK'],env});
    if(remote.record.exitCode===0){
      await checked(commands,{command:'git',args:['fetch','origin',job.branch],cwd:workspace,taskId:job.taskId,allowed:['NETWORK'],env});await checked(commands,{command:'git',args:['switch','-C',job.branch,'--track',`origin/${job.branch}`],cwd:workspace,taskId:job.taskId,allowed:['BUILD'],env});
      if(job.commitSha){
        const head=await checked(commands,{command:'git',args:['rev-parse','HEAD'],cwd:workspace,taskId:job.taskId,allowed:['READ']});
        const actualHeadSha=head.stdout.trim();
        if(actualHeadSha!==job.commitSha){
          const ancestry=await commands.run({command:'git',args:['merge-base','--is-ancestor',job.commitSha,'HEAD'],cwd:workspace,taskId:job.taskId,allowed:['READ']});
          const decision=resolveBranchContinuity({expectedSha:job.commitSha,actualHeadSha,isAncestor:ancestry.record.exitCode===0});
          if(decision.status!=='FAST_FORWARD')throw new ExecutionFailed('Remote task branch no longer matches the persisted exact commit SHA',{expected:job.commitSha,actual:actualHeadSha});
          // FAST_FORWARD: heal the persisted commitSha to the new HEAD so this job -- and any
          // future retry that inherits it for continuity -- doesn't deadlock against a value that
          // can now never match again.
          console.log(JSON.stringify({level:'warn',event:'execution.branch.fast_forward_adopted',jobId:job.id,taskId:job.taskId,expected:job.commitSha,actual:actualHeadSha}));
          job={...job,commitSha:decision.healedSha};
          await store.updateExecutionJob({...job,updatedAt:systemClock.now()});
        }
      }
    }else if(job.baseBranch){
      // First run of a task that DEPENDS_ON an already-READY predecessor: branch from the
      // predecessor's own verified autopilot/* branch (server-resolved, never a caller-controlled
      // baseRef) instead of the registered repository's default branch, so this task's execution
      // actually builds on top of the predecessor's not-yet-merged changes.
      const baseRemote=await commands.run({command:'git',args:['ls-remote','--exit-code','--heads','origin',job.baseBranch],cwd:workspace,taskId:job.taskId,allowed:['NETWORK'],env});
      if(baseRemote.record.exitCode!==0)throw new ExecutionFailed('Predecessor verified branch no longer exists on origin',{baseBranch:job.baseBranch});
      await checked(commands,{command:'git',args:['fetch','origin',job.baseBranch],cwd:workspace,taskId:job.taskId,allowed:['NETWORK'],env});await checked(commands,{command:'git',args:['switch','-C',job.branch,'--track',`origin/${job.baseBranch}`],cwd:workspace,taskId:job.taskId,allowed:['BUILD'],env});
      if(job.baseCommitSha){const head=await checked(commands,{command:'git',args:['rev-parse','HEAD'],cwd:workspace,taskId:job.taskId,allowed:['READ']});if(head.stdout.trim()!==job.baseCommitSha)throw new ExecutionFailed('Predecessor verified branch no longer matches its persisted exact commit SHA',{expected:job.baseCommitSha,actual:head.stdout.trim()});}
    }
  }
  return workspace;}
// ---------------------------------------------------------------------------
// Rebase of an already-verified task onto the current base branch
// ---------------------------------------------------------------------------
//
// Replays the task's OWN commit range onto a branch cut from the repository's current default
// branch. `git cherry-pick` performs a real 3-way merge per commit, so work the base gained
// since the task forked is preserved rather than overwritten, and only genuine overlaps surface
// as conflicts. Nothing is copied over a file, and no side is ever picked automatically.
async function performRebase(input:{workspace:string;job:ExecutionJob;commands:CommandRunner;rebase:{sourceBranch:string;sourceCommitSha:string;originalBaseCommit:string;manifestArtifactId:string;rebaseBranchPrefix:string;resolutions:Array<{path:string;content:string}>};githubToken:string;artifacts:ArtifactStore;audit:AuditLog;store:PostgresStateStore;project:{id:string};task:Parameters<WorkflowEngine['transition']>[0];resource:{externalReference:string};owner:string}){
  const {workspace,commands,rebase,githubToken,artifacts,audit,store,project,task,resource,owner}=input;
  const env={GH_TOKEN:githubToken};
  const git:RebaseGit=async args=>{const result=await commands.run({command:'git',args,cwd:workspace,taskId:task.id,allowed:['READ','BUILD','NETWORK'],env});return {exitCode:result.record.exitCode,stdout:result.stdout,stderr:result.stderr};};
  const readFile=(path:string)=>readWorkspaceFile(join(workspace,path));
  const writeFile=(path:string,content:string)=>writeWorkspaceFile(join(workspace,path),content);

  const targetBaseBranch=await defaultBranch(resource.externalReference,githubToken);
  await checked(commands,{command:'git',args:['fetch','origin',targetBaseBranch],cwd:workspace,taskId:task.id,allowed:['NETWORK'],env});
  const targetBase=await checked(commands,{command:'git',args:['rev-parse',`origin/${targetBaseBranch}`],cwd:workspace,taskId:task.id,allowed:['READ']});
  const targetBaseCommit=targetBase.stdout.trim();
  // The source branch head must still be exactly the commit the manifest verified.
  const sourceHead=await checked(commands,{command:'git',args:['rev-parse',rebase.sourceCommitSha],cwd:workspace,taskId:task.id,allowed:['READ']});
  if(sourceHead.stdout.trim()!==rebase.sourceCommitSha)throw new ExecutionFailed('Verified task commit is not reachable in the checkout',{expected:rebase.sourceCommitSha});
  await assertDependencyMerged(git,rebase.originalBaseCommit,targetBaseCommit);

  const branch=rebaseBranchName(rebase.rebaseBranchPrefix,targetBaseCommit);
  await checked(commands,{command:'git',args:['switch','-C',branch,targetBaseCommit],cwd:workspace,taskId:task.id,allowed:['BUILD']});
  const taskPaths=await taskChangedPaths(git,rebase.originalBaseCommit,rebase.sourceCommitSha);
  const transfer=await transferTaskCommits(git,{originalBaseCommit:rebase.originalBaseCommit,sourceCommitSha:rebase.sourceCommitSha,readFile});

  const report={jobId:input.job.id,operationId:input.job.operationId,method:transfer.method,sourceBranch:rebase.sourceBranch,sourceCommitSha:rebase.sourceCommitSha,originalBaseCommit:rebase.originalBaseCommit,manifestArtifactId:rebase.manifestArtifactId,targetBaseBranch,targetBaseCommit,rebaseBranch:branch,replayedCommits:transfer.replayedCommits,taskChangedPaths:taskPaths,conflicts:transfer.conflicts};

  let resolved:Array<{path:string;kind:string;bytes:number}>=[];
  if(transfer.conflicts.length){
    if(!rebase.resolutions.length){
      // Fail closed with complete three-sided evidence instead of guessing a side. The task stays
      // BLOCKED with its durable history intact; a follow-up call carries the resolutions.
      const artifact=await artifacts.write(project.id,'REBASE_REPORT',{...report,status:'CONFLICTS_REQUIRE_RESOLUTION'},task.id,input.job.runId);
      await audit.record({actor:owner,action:'execution.rebase.conflicts',projectId:project.id,taskId:task.id,input:{jobId:input.job.id,targetBaseCommit},result:{artifactId:artifact.id,conflicts:transfer.conflicts.map(value=>({path:value.path,kind:value.kind}))},reason:'Transfer onto the current base hit genuine semantic conflicts; resolution is required before re-verification',correlationId:input.job.operationId});
      await new WorkflowEngine(store,uuidGenerator,systemClock).transition(task,'BLOCKED',`Rebase onto ${targetBaseBranch}@${targetBaseCommit.slice(0,12)} requires resolution of ${transfer.conflicts.length} conflicted path(s)`,owner);
      throw new DependencyBlocked('Rebase requires semantic conflict resolution',{artifactId:artifact.id,conflicts:transfer.conflicts.map(value=>value.path)});
    }
    resolved=await applyResolutions(git,{conflicts:transfer.conflicts,resolutions:rebase.resolutions,writeFile});
  }
  const rebasedCommitSha=await commitTransfer(git,`autopilot: ${task.externalKey} ${task.title} (transferred onto ${targetBaseBranch}@${targetBaseCommit.slice(0,12)})`);
  if(rebasedCommitSha===undefined){
    // The target base already carries this task's verified end state byte-for-byte -- almost
    // always because the task's own pull request was already merged before this rebase ran (an
    // agent double-checking a just-merged READY task is enough to trigger it). There is nothing
    // to transfer and no pull request to open; GitHub refuses to open one with zero commits
    // between head and base. The caller still re-verifies against the target base tip and
    // returns the task straight to READY through the normal test/review gate chain instead of
    // failing a re-verification the git evidence already proved safe to run.
    await audit.record({actor:owner,action:'execution.rebase.already_integrated',projectId:project.id,taskId:task.id,input:{jobId:input.job.id,sourceCommitSha:rebase.sourceCommitSha,targetBaseCommit},result:{rebaseBranch:branch},reason:'Target base already contains the verified commit; nothing to transfer',correlationId:input.job.operationId});
    return {targetBaseBranch,targetBaseCommit,alreadyIntegrated:true as const,report:{...report,resolutions:resolved,basePathsVerified:[],changedFiles:[]},result:{baseCommit:targetBaseCommit,branch,commitSha:targetBaseCommit,diff:'',changedFiles:[],completedAt:systemClock.now()}};
  }
  const preserved=await assertBaseChangesPreserved(git,{originalBaseCommit:rebase.originalBaseCommit,targetBaseCommit,rebasedCommitSha,taskPaths});
  const diff=await checked(commands,{command:'git',args:['diff',targetBaseCommit,rebasedCommitSha,'--'],cwd:workspace,taskId:task.id,allowed:['READ']});
  const changed=await checked(commands,{command:'git',args:['diff','--name-only',targetBaseCommit,rebasedCommitSha],cwd:workspace,taskId:task.id,allowed:['READ']});
  const changedFiles=changed.stdout.split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
  if(!changedFiles.length)throw new ExecutionFailed('Transfer produced no change against the target base');
  await audit.record({actor:owner,action:'execution.rebase.transferred',projectId:project.id,taskId:task.id,input:{jobId:input.job.id,method:transfer.method,sourceCommitSha:rebase.sourceCommitSha,originalBaseCommit:rebase.originalBaseCommit,targetBaseCommit},result:{rebaseBranch:branch,rebasedCommitSha,replayed:transfer.replayedCommits.length,conflicts:transfer.conflicts.map(value=>value.path),resolvedPaths:resolved.map(value=>value.path),basePathsVerified:preserved.verifiedPaths,changedFiles:changedFiles.length},reason:'Verified task work replayed onto the current base with a 3-way cherry-pick',correlationId:input.job.operationId});
  return {targetBaseBranch,targetBaseCommit,alreadyIntegrated:false as const,report:{...report,resolutions:resolved,basePathsVerified:preserved.verifiedPaths,changedFiles},result:{baseCommit:targetBaseCommit,branch,commitSha:rebasedCommitSha,diff:diff.stdout,changedFiles,completedAt:systemClock.now()}};
}

async function defaultBranch(repository:string,token:string){
  const response=await fetch(`https://api.github.com/repos/${repository}`,{headers:githubHeaders(token)});
  if(!response.ok)throw new ExecutionFailed('GitHub repository metadata lookup failed',{status:response.status});
  return (await response.json() as {default_branch:string}).default_branch;
}
function githubHeaders(token:string){return {authorization:`Bearer ${token}`,accept:'application/vnd.github+json','user-agent':'backend-autopilot','x-github-api-version':'2022-11-28','content-type':'application/json'};}

// Opens the fresh pull request for the transferred branch and supersedes -- never merges -- every
// still-open pull request that was raised from the stale pre-rebase branch.
async function publishRebasedPullRequest(input:{repository:string;token:string;head:string;base:string;task:{externalKey:string;title:string};staleHead:string}){
  const owner=input.repository.split('/')[0];
  const headers=githubHeaders(input.token);
  const created=await fetch(`https://api.github.com/repos/${input.repository}/pulls`,{method:'POST',headers,body:JSON.stringify({title:`${input.task.externalKey} · ${input.task.title} (rebased onto ${input.base})`,head:input.head,base:input.base,body:`Automated Backend Autopilot transfer of the already-verified ${input.task.externalKey} work onto the current \`${input.base}\`.\n\nThe previous pull request was raised from \`${input.staleHead}\`, which was built on a base that has since been merged, and is superseded by this one.`})});
  let opened:{number:number;url:string}|undefined;
  if(created.ok){const body=await created.json() as {number:number;html_url:string};opened={number:body.number,url:body.html_url};}
  else if(created.status===422){
    const existing=await fetch(`https://api.github.com/repos/${input.repository}/pulls?state=open&base=${encodeURIComponent(input.base)}&head=${encodeURIComponent(`${owner}:${input.head}`)}`,{headers});
    const matches=existing.ok?await existing.json() as Array<{number:number;html_url:string}>:[];
    if(matches[0])opened={number:matches[0].number,url:matches[0].html_url};
  }
  if(!opened)throw new ExecutionFailed('Could not open the rebased pull request',{status:created.status,body:(await created.text()).slice(0,300)});
  const superseded:Array<{number:number;url:string}>=[];
  const stale=await fetch(`https://api.github.com/repos/${input.repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.staleHead}`)}&per_page=20`,{headers});
  if(stale.ok)for(const pull of await stale.json() as Array<{number:number;html_url:string}>){
    if(pull.number===opened.number)continue;
    await fetch(`https://api.github.com/repos/${input.repository}/issues/${pull.number}/comments`,{method:'POST',headers,body:JSON.stringify({body:`Superseded by #${opened.number}: the same verified ${input.task.externalKey} work transferred onto the current \`${input.base}\`. This pull request must not be merged.`})});
    await fetch(`https://api.github.com/repos/${input.repository}/pulls/${pull.number}`,{method:'PATCH',headers,body:JSON.stringify({state:'closed'})});
    superseded.push({number:pull.number,url:pull.html_url});
  }
  return {opened,superseded};
}

async function installTargetDependencies(workspace:string,job:ExecutionJob,commands:CommandRunner,stack:Awaited<ReturnType<typeof detectStack>>){
  // Kotlin/Gradle dependency resolution is deferred to commitProvisionedGradleWrapper below, which
  // runs AFTER execution.execute() and commits any wrapper fixup atomically -- chmod'ing gradlew
  // here (before execute()) would leave an uncommitted mode-only diff on a repaired task whose
  // branch already carries a previously-committed wrapper, tripping ExecutionEngine's clean-tree
  // precondition (this was the MOMNA-990 "Target repository must have a clean working tree" retry
  // failure).
  if(stack==='KOTLIN_GRADLE')return;
  try{await access(join(workspace,'package.json'));}catch{return;}let frozen=false;try{await access(join(workspace,'pnpm-lock.yaml'));frozen=true;}catch{/* install without mutating an untracked lockfile */}await checked(commands,{command:'pnpm',args:['install',...(frozen?['--frozen-lockfile']:['--lockfile=false'])],cwd:workspace,taskId:job.taskId,allowed:['BUILD']});
}
// Delegates the actual wrapper-file provisioning (the part covered by the MOMNA-990 EACCES
// regression test) to a pure, unit-testable module, then commits the result only if it actually
// changed anything -- a no-op for repos that already carried the identical pinned wrapper.
async function commitProvisionedGradleWrapper(workspace:string,job:ExecutionJob,commands:CommandRunner,git:LocalGitAdapter):Promise<string|undefined>{
  const pinned=fileURLToPath(new URL('../examples/kotlin-sandbox-base/',import.meta.url));
  if(!(await provisionGradleWrapper(workspace,pinned)))return undefined;
  const status=await commands.run({command:'git',args:['status','--porcelain'],cwd:workspace,taskId:job.taskId,allowed:['READ']});
  if(!status.stdout.trim())return undefined;
  return git.commit(workspace,job.taskId,'backend-autopilot: provision pinned Gradle Wrapper');
}
async function gradleToolchainVersions(workspace:string,job:ExecutionJob,commands:CommandRunner){
  try{
    const result=await commands.run({command:join(workspace,'gradlew'),args:['--version','--no-daemon','--console=plain'],cwd:workspace,taskId:job.taskId,allowed:['BUILD']});
    const pick=(label:string)=>result.stdout.match(new RegExp(`^${label}\\s*:?\\s*(\\S+)`,'m'))?.[1];
    return {gradle:pick('Gradle'),kotlin:pick('Kotlin'),jvm:pick('JVM')};
  }catch{return undefined;}
}
async function checked(commands:CommandRunner,input:Parameters<CommandRunner['run']>[0]){const result=await commands.run(input);if(result.record.exitCode!==0)throw new ExecutionFailed('Execution setup command failed',{command:result.record.command,stderr:result.stderr});return result;}
async function readWorkspaceFile(path:string){return readFile(path,'utf8');}
async function writeWorkspaceFile(path:string,content:string){await writeFile(path,content,'utf8');}
function argument(name:string){const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:undefined;}
function required(name:string){const value=process.env[name];if(!value)throw new Error(`${name} is required`);return value;}
