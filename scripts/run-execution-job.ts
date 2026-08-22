import 'dotenv/config';
import { access, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { ArtifactStore } from '../packages/artifact-store/src/index.js';
import { AuditLog } from '../packages/audit/src/index.js';
import { SupabaseStorageArtifactBlobStore } from '../packages/adapters/supabase/src/artifact-storage.js';
import { LiveGitHubAdapter } from '../packages/adapters/github/src/index.js';
import { LocalGitAdapter } from '../packages/adapters/git/src/index.js';
import { AutopilotService } from '../packages/core/src/application.js';
import { ExecutionFailed, PolicyViolation } from '../packages/core/src/errors.js';
import { systemClock, uuidGenerator } from '../packages/core/src/ports.js';
import { CommandPolicy, CommandRunner, ExecutionEngine, StackAwareTestExecutor, detectStack, provisionGradleWrapper } from '../packages/execution-engine/src/index.js';
import { PolicyEngine } from '../packages/policy-engine/src/index.js';
import { PostgresStateStore } from '../packages/project-registry/src/index.js';
import { fileChangeSchema, type ExecutionJob } from '../packages/schemas/src/index.js';

const inputSchema=z.object({changes:z.array(fileChangeSchema).min(1)});
const jobId=argument('--job')??process.env['AUTOPILOT_JOB_ID'];
const databaseUrl=required('DATABASE_URL');
const githubToken=required('AUTOPILOT_GITHUB_TOKEN');
const supabaseUrl=required('SUPABASE_URL');
const serviceRoleKey=required('SUPABASE_SERVICE_ROLE_KEY');
if(!jobId||!z.string().uuid().safeParse(jobId).success)throw new Error('A valid --job identifier is required');
const store=new PostgresStateStore(databaseUrl);const owner=`github-actions:${process.env['GITHUB_RUN_ID']??crypto.randomUUID()}:${process.env['GITHUB_RUN_ATTEMPT']??'1'}`;
let current=await store.getExecutionJobById(jobId);if(!current)throw new Error('Execution job not found');
const leaseExpiresAt=new Date(Date.now()+20*60_000).toISOString();const claimed=await store.claimExecutionJob(current.projectId,current.id,owner,leaseExpiresAt,systemClock.now());if(!claimed)throw new Error('Execution job is already claimed by another runner');current=claimed;
const commands=new CommandRunner(new CommandPolicy(),systemClock);const git=new LocalGitAdapter(commands);const tests=new StackAwareTestExecutor(commands,systemClock);const execution=new ExecutionEngine(git,systemClock);const blobs=new SupabaseStorageArtifactBlobStore(supabaseUrl,serviceRoleKey);const artifacts=new ArtifactStore(store,uuidGenerator,systemClock,blobs);const audit=new AuditLog(store,uuidGenerator,systemClock);const service=new AutopilotService({store,execution,tests,git,commands,artifactBlobs:blobs});
try{
  current=await store.updateExecutionJob({...current,status:'RUNNING',updatedAt:systemClock.now()});const project=await store.getProject(current.projectId);const task=await store.getTask(current.projectId,current.taskId);const resource=await store.getResource(current.resourceId);if(!project||!task||!resource)throw new ExecutionFailed('Execution job references missing registered state');
  await new PolicyEngine(store).authorize({project,action:'EXECUTE',resourceId:resource.resourceId,requiredPermission:'WRITE',actor:owner});if(resource.type!=='GITHUB_REPOSITORY'||resource.provider!=='github'||resource.environment!=='SANDBOX')throw new PolicyViolation('Execution job target is not an allowlisted sandbox GitHub repository');
  const workspace=await prepareWorkspace(resource.externalReference,current,commands,githubToken);const stack=await detectStack(workspace);await installTargetDependencies(workspace,current,commands,stack);const payload=inputSchema.parse(current.payload);const result=await execution.execute({workspace,task,changes:payload.changes});
  const provisionedWrapperSha=await commitProvisionedGradleWrapper(workspace,current,commands,git);const commitSha=provisionedWrapperSha??result.commitSha;
  current=await store.updateExecutionJob({...current,baseCommit:result.baseCommit,branch:result.branch,commitSha,updatedAt:systemClock.now()});
  await artifacts.write(project.id,'CODE_DIFF',{diff:result.diff,changedFiles:result.changedFiles},task.id,current.runId);
  const migrationFiles=payload.changes.filter(value=>/migrations?\//.test(value.path));if(migrationFiles.length)await artifacts.write(project.id,'MIGRATION_MANIFEST',{migrations:migrationFiles.map(value=>({path:value.path,content:value.content})),validation:'Pending migration test gate',rollback:'Implementation plan rollback strategy'},task.id,current.runId);
  const apiFiles=payload.changes.filter(value=>/openapi/i.test(value.path));if(apiFiles.length)await artifacts.write(project.id,'API_CONTRACT',{contracts:apiFiles.map(value=>({path:value.path,document:(/\.ya?ml$/i.test(value.path)?parseYaml(value.content):JSON.parse(value.content)) as unknown}))},task.id,current.runId);
  await new LiveGitHubAdapter(commands).push(resource,{workspace,branch:result.branch,correlationId:task.id});
  if(current.runId){const run=await store.getRun(project.id,current.runId);if(run)await store.updateRun({...run,baseCommit:result.baseCommit,branch:result.branch,commitSha});}
  await service.taskTest(project.id,task.id,owner,current.operationId,workspace);
  const toolchain=stack==='KOTLIN_GRADLE'?await gradleToolchainVersions(workspace,current,commands):undefined;
  await artifacts.write(project.id,'CI_REPORT',{provider:'github-actions',repository:resource.externalReference,branch:result.branch,expectedSha:commitSha,detectedStack:stack,...(toolchain?{toolchain}:{}),...(provisionedWrapperSha?{gradleWrapperProvisioned:true}:{}),ci:{success:true,status:'completed',conclusion:'success',headSha:commitSha,url:process.env['GITHUB_SERVER_URL']&&process.env['GITHUB_REPOSITORY']&&process.env['GITHUB_RUN_ID']?`${process.env['GITHUB_SERVER_URL']}/${process.env['GITHUB_REPOSITORY']}/actions/runs/${process.env['GITHUB_RUN_ID']}`:undefined}},task.id,current.runId);
  await service.taskReview(project.id,task.id,owner,current.operationId);
  if(current.runId){const run=await store.getRun(project.id,current.runId);if(run)await store.updateRun({...run,status:'SUCCEEDED',baseCommit:result.baseCommit,branch:result.branch,commitSha,finishedAt:systemClock.now()});}
  current=await store.updateExecutionJob({...current,status:'SUCCEEDED',leaseOwner:owner,leaseExpiresAt:systemClock.now(),finishedAt:systemClock.now(),updatedAt:systemClock.now(),result:{branch:result.branch,commitSha,changedFiles:result.changedFiles}});
  await audit.record({actor:owner,action:'execution.job.succeeded',projectId:project.id,taskId:task.id,resourceId:resource.resourceId,input:{jobId:current.id},result:{runId:current.runId,branch:result.branch,commitSha},reason:'GitHub Actions execution, tests and review completed',correlationId:current.operationId});
  console.log(JSON.stringify({level:'info',event:'execution.job.succeeded',jobId:current.id,branch:result.branch,commitSha}));
}catch(error){
  const task=await store.getTask(current.projectId,current.taskId);const status=task?.state==='BLOCKED'?'BLOCKED':'FAILED';current=await store.updateExecutionJob({...current,status,leaseExpiresAt:systemClock.now(),finishedAt:systemClock.now(),updatedAt:systemClock.now(),error:{code:error instanceof Error?error.name:'UNKNOWN',message:error instanceof Error?error.message:'Unknown execution failure'}});if(current.runId){const run=await store.getRun(current.projectId,current.runId);if(run&&run.status==='RUNNING')await store.updateRun({...run,status:status==='BLOCKED'?'BLOCKED':'FAILED',finishedAt:systemClock.now(),...(current.branch?{branch:current.branch}:{}),...(current.commitSha?{commitSha:current.commitSha}:{})});}await audit.record({actor:owner,action:'execution.job.failed',projectId:current.projectId,taskId:current.taskId,resourceId:current.resourceId,input:{jobId:current.id},result:{status,error:error instanceof Error?error.name:'UNKNOWN'},reason:'GitHub Actions execution failed; durable state preserved',correlationId:current.operationId});throw error;
}finally{await store.close();}

async function prepareWorkspace(repository:string,job:ExecutionJob,commands:CommandRunner,token:string){if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))throw new PolicyViolation('Registered repository identity is invalid');const root=process.env['RUNNER_TEMP']??process.cwd();const workspace=await mkdtemp(join(root,'backend-autopilot-'));const env={GH_TOKEN:token};await checked(commands,{command:'gh',args:['auth','setup-git'],cwd:root,taskId:job.taskId,allowed:['NETWORK'],env});await checked(commands,{command:'gh',args:['repo','clone',repository,workspace,'--','--no-tags'],cwd:root,taskId:job.taskId,allowed:['NETWORK'],env});await checked(commands,{command:'git',args:['config','user.email','autopilot@localhost.invalid'],cwd:workspace,taskId:job.taskId,allowed:['BUILD']});await checked(commands,{command:'git',args:['config','user.name','Backend Autopilot'],cwd:workspace,taskId:job.taskId,allowed:['BUILD']});
  if(job.branch){
    const remote=await commands.run({command:'git',args:['ls-remote','--exit-code','--heads','origin',job.branch],cwd:workspace,taskId:job.taskId,allowed:['NETWORK'],env});
    if(remote.record.exitCode===0){
      await checked(commands,{command:'git',args:['fetch','origin',job.branch],cwd:workspace,taskId:job.taskId,allowed:['NETWORK'],env});await checked(commands,{command:'git',args:['switch','-C',job.branch,'--track',`origin/${job.branch}`],cwd:workspace,taskId:job.taskId,allowed:['BUILD'],env});
      if(job.commitSha){const head=await checked(commands,{command:'git',args:['rev-parse','HEAD'],cwd:workspace,taskId:job.taskId,allowed:['READ']});if(head.stdout.trim()!==job.commitSha)throw new ExecutionFailed('Remote task branch no longer matches the persisted exact commit SHA',{expected:job.commitSha,actual:head.stdout.trim()});}
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
function argument(name:string){const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:undefined;}
function required(name:string){const value=process.env[name];if(!value)throw new Error(`${name} is required`);return value;}
