import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { ArtifactStore } from '../packages/artifact-store/src/index.js';
import { AuditLog } from '../packages/audit/src/index.js';
import { createRuntime, DomainError } from '../packages/core/src/index.js';
import { systemClock, uuidGenerator } from '../packages/core/src/ports.js';
import { disposeWorkspaceDirectory, ensureDisposableCleanWorkspace, workspaceCheckoutExists } from '../packages/execution-engine/src/index.js';

if(process.env['AUTOPILOT_CONFIRM_DEDICATED_SANDBOX']!=='true')throw new Error('HUMAN_ACTION_REQUIRED: confirm the dedicated provider identities explicitly.');
const workspace=resolve(process.env['AUTOPILOT_LIVE_WORKSPACE']??'workspaces/backend-autopilot-live-sandbox');
const expectedLogin=requiredEnv('AUTOPILOT_GITHUB_SANDBOX_LOGIN');
const expectedRepository=requiredEnv('AUTOPILOT_GITHUB_SANDBOX_REPOSITORY');
const expectedSupabaseProject=requiredEnv('AUTOPILOT_SUPABASE_SANDBOX_PROJECT_REF');
if(!expectedRepository.toLowerCase().startsWith(`${expectedLogin.toLowerCase()}/`))throw new Error('Sandbox repository owner must equal AUTOPILOT_GITHUB_SANDBOX_LOGIN');

const runtime=createRuntime();
let project=(await runtime.service.projectList()).find(value=>value.slug==='backend-autopilot-live-sandbox');
if(!project)project=await runtime.service.projectCreate({name:'Backend Autopilot Live Sandbox',slug:'backend-autopilot-live-sandbox',sourceType:'LOCAL',environment:'STAGING',autonomyMode:'AUTONOMOUS_STAGING',workspacePath:workspace});
await prepareWorkspace(runtime,project.id,workspace);
const githubAccount=await runtime.bootstrap.registerGithubIdentity(project.id,true,expectedLogin);
const registeredRepository=await runtime.bootstrap.registerGithubRepository(project.id,githubAccount.resourceId,expectedRepository,true);
const supabaseOrganization=await runtime.bootstrap.registerSupabaseOrganization(project.id,true);
const registeredSupabaseProject=await runtime.bootstrap.registerSupabaseProject(project.id,supabaseOrganization.resourceId,expectedSupabaseProject,true);
let resources=await runtime.service.resourceList(project.id);
if(process.env['AUTOPILOT_CONFIRM_SUPABASE_CREDENTIAL_ROTATION']!=='true')throw new Error('HUMAN_ACTION_REQUIRED: confirm credential rotation for the explicitly registered sandbox database.');
await runtime.bootstrap.configureExistingSupabaseDatabase(project.id,registeredSupabaseProject.resource.resourceId,true);

const migration=await readFile(resolve('examples/demo-notes/implementation/migrations/001_notes.sql'),'utf8');
const boot=await runtime.bootstrap.bootstrap({projectId:project.id,operationId:'live-sandbox-bootstrap-v2',githubAccountResourceId:githubAccount.resourceId,githubRepositoryResourceId:registeredRepository.resource.resourceId,supabaseOrganizationResourceId:supabaseOrganization.resourceId,supabaseProjectResourceId:registeredSupabaseProject.resource.resourceId,region:registeredSupabaseProject.metadata.region,migrations:[{name:'notes_schema_v1',sql:migration,rollback:'DROP TABLE IF EXISTS notes'}],rlsPolicies:[{table:'notes',ownerColumn:'owner_id',policyName:'notes_owner_policy'}],authConfig:{site_url:'http://127.0.0.1',disable_signup:false,jwt_exp:3600},storageConfig:{fileSizeLimit:10_485_760},waitForCi:true});
resources=await runtime.service.resourceList(project.id);
const repository=resources.find(resource=>resource.resourceId===registeredRepository.resource.resourceId);
const database=resources.find(resource=>resource.type==='DATABASE'&&resource.provider==='supabase');
if(!repository||!database?.secretRefs[0])throw new Error('Bootstrap did not register repository/database resources');
const databaseUrl=await runtime.secrets.get(database.secretRefs[0],project.id);
process.env['AUTOPILOT_LIVE_DATABASE_URL']=databaseUrl;
await runtime.providers.github.setActionsSecret(repository,{workspace,name:'AUTOPILOT_LIVE_DATABASE_URL',value:databaseUrl,correlationId:project.id});

let task=(await runtime.service.taskList(project.id)).find(value=>value.externalKey==='LIVE-1');
if(!task){
  task=await runtime.service.taskCreate({projectId:project.id,externalKey:'LIVE-1',title:'Live Notes CRUD REST API',description:'Implement PostgreSQL Notes API, OpenAPI, ownership authorization and observable error handling',requirements:['Create/read/update/delete owned notes','Apply reproducible database migration','Run contract, migration, security, regression and live API tests','Structured logging and observable errors'],relationships:[]});
  await runtime.service.taskAnalyze(project.id,task.id);
  await runtime.service.taskPlan(project.id,task.id);
  const desired=await loadChanges(resolve('examples/demo-notes/implementation'));
  desired.push({path:'tests/live-api.test.js',content:await readFile(resolve('examples/live-sandbox-live-test.js'),'utf8'),operation:'CREATE'});
  const first=desired.map(change=>change.path==='tests/security.test.js'?{...change,content:"import test from 'node:test';import assert from 'node:assert/strict';test('intentional live failure',()=>assert.equal(1,2));"}:change);
  const localResourceId=resources.find(resource=>resource.type==='GIT_REPOSITORY'&&resource.provider==='local')?.resourceId??await ensureLocalResource(runtime,project.id,workspace);
  await runtime.service.taskExecute({projectId:project.id,taskId:task.id,operationId:'live-implementation-v1',changes:first},localResourceId);
  let run=(await runtime.service.runList(project.id,task.id)).at(-1)!;
  if(!run.branch||!run.commitSha)throw new Error('Execution run is missing branch or commit SHA');
  await runtime.providers.github.push(repository,{workspace,branch:run.branch,correlationId:project.id});
  const failedCi=await runtime.providers.github.ciStatus(repository,{workspace,branch:run.branch,correlationId:project.id,wait:true,expectedSha:run.commitSha});
  if(failedCi.success)throw new Error('Intentional CI failure was not detected');
  try{await runtime.service.taskTest(project.id,task.id);throw new Error('Intentional local failure was not detected');}catch(error){if(!(error instanceof DomainError&&error.code==='TEST_FAILED'))throw error;}
  const repair=desired.find(change=>change.path==='tests/security.test.js')!;
  await runtime.service.taskExecute({projectId:project.id,taskId:task.id,operationId:'live-repair-v1',changes:[repair]},localResourceId);
  run=(await runtime.service.runList(project.id,task.id)).at(-1)!;
  if(!run.branch||!run.commitSha)throw new Error('Repair run is missing branch or commit SHA');
  await runtime.providers.github.push(repository,{workspace,branch:run.branch,correlationId:project.id});
  const passedCi=await runtime.providers.github.ciStatus(repository,{workspace,branch:run.branch,correlationId:project.id,wait:true,expectedSha:run.commitSha});
  if(!passedCi.success)throw new Error('Repaired CI did not pass');
  await runtime.bootstrap.verifyGithubCi(project.id,task.id,repository.resourceId,run.branch,run.commitSha);
  await runtime.service.taskTest(project.id,task.id);
  const review=await runtime.service.taskReview(project.id,task.id);
  const pr=await runtime.bootstrap.openGithubPullRequest(project.id,task.id,repository.resourceId,'main',run.branch,'Backend Autopilot live sandbox implementation','Automated live provider verification with intentional failure and repair.');
  console.log(JSON.stringify({success:true,projectId:project.id,repository:repository.externalReference,databaseProvider:database.provider,bootstrap:boot.report,failedCi,passedCi,review:review.review.result,pullRequest:pr.pullRequest,capabilities:await runtime.bootstrap.runtimeCapabilities(project.id)},null,2));
}else{
  console.log(JSON.stringify({success:task.state==='READY',idempotentReplay:true,projectId:project.id,taskId:task.id,status:task.state,bootstrap:boot.report,capabilities:await runtime.bootstrap.runtimeCapabilities(project.id)},null,2));
}

// The sandbox workspace is disposable. An interrupted previous run can leave uncommitted or
// untracked files behind, and ExecutionEngine's clean-tree precondition would then fail the very
// next run before the payload was ever applied. Rather than weakening that precondition, a dirty
// reused tree is captured as WORKSPACE_QUARANTINE evidence, the attempt is marked quarantined in
// the append-only audit trail, the directory is deleted and a fresh checkout is seeded for the
// same project/task. No provider registration, bootstrap, push or CI step is repeated: this runs
// before any external call, and the durable project/task/run checkpoints are untouched.
async function prepareWorkspace(runtime:ReturnType<typeof createRuntime>,projectId:string,path:string){
  const artifacts=new ArtifactStore(runtime.store,uuidGenerator,systemClock);
  const audit=new AuditLog(runtime.store,uuidGenerator,systemClock);
  const result=await ensureDisposableCleanWorkspace({
    workspace:path,
    now:()=>systemClock.now(),
    exists:workspaceCheckoutExists,
    create:async()=>{await seedWorkspace(path);return path;},
    inspect:async workspace=>{
      const status=gitCapture(workspace,['status','--porcelain']);
      const diff=gitCapture(workspace,['diff','HEAD']);
      // A workspace whose own `git status` fails (interrupted seeding, corrupt index) is dirty
      // by definition, and the failure text is the evidence.
      return {status:status.ok?status.output:`!! git status failed\n${status.output}`,diff:diff.ok?diff.output:''};
    },
    dispose:workspace=>disposeWorkspaceDirectory(workspace,dirname(path)),
    quarantine:async record=>{
      const artifact=await artifacts.write(projectId,'WORKSPACE_QUARANTINE',{quarantined:true,scope:'LIVE_SANDBOX_BOOTSTRAP',...record});
      await audit.record({actor:'live-sandbox-bootstrap',action:'execution.workspace.quarantined',projectId,input:{workspace:record.workspace,attempt:record.attempt},result:{artifactId:artifact.id,statusTruncated:record.statusTruncated,diffTruncated:record.diffTruncated},reason:'Interrupted run left an unclean reused workspace; the attempt is quarantined and a clean checkout recreated',correlationId:`workspace-quarantine-${projectId}-${record.attempt}`});
      console.log(JSON.stringify({level:'warn',event:'workspace.quarantined',projectId,attempt:record.attempt,artifactId:artifact.id}));
    },
  });
  if(result.quarantines.length)console.log(JSON.stringify({level:'info',event:'workspace.recreated',projectId,attempts:result.attempts,quarantined:result.quarantines.length}));
  return result;
}
async function seedWorkspace(path:string){await mkdir(path,{recursive:true});await cp(resolve('examples/live-sandbox-base'),path,{recursive:true});if(process.platform==='win32')execFileSync(process.env['ComSpec']??'C:\\Windows\\System32\\cmd.exe',['/d','/s','/c','pnpm install'],{cwd:path,stdio:'ignore'});else execFileSync('pnpm',['install'],{cwd:path,stdio:'ignore'});for(const args of [['init','-b','main'],['config','user.email','autopilot@localhost.invalid'],['config','user.name','Backend Autopilot'],['add','.'],['commit','-m','live sandbox baseline']])execFileSync('git',args,{cwd:path,stdio:'ignore'});}
function gitCapture(cwd:string,args:string[]){try{return {ok:true,output:execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']})};}catch(error){const failure=error as {stderr?:string;message?:string};return {ok:false,output:failure.stderr??failure.message??'git command failed'};}}
async function loadChanges(root:string){const files:string[]=[];async function walk(directory:string){for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await walk(path);else files.push(path);}}await walk(root);return Promise.all(files.map(async path=>({path:relative(root,path).replaceAll('\\','/'),content:await readFile(path,'utf8'),operation:'CREATE' as const})));}
async function ensureLocalResource(runtime:ReturnType<typeof createRuntime>,projectId:string,workspacePath:string){const existing=(await runtime.service.resourceList(projectId)).find(resource=>resource.type==='GIT_REPOSITORY'&&resource.provider==='local'&&resource.externalReference===workspacePath);if(existing)return existing.resourceId;const resource=await runtime.service.resourceRegister({projectId,type:'GIT_REPOSITORY',provider:'local',externalReference:workspacePath,environment:'SANDBOX',permissions:['READ','WRITE'],secretRefs:[]});return resource.resourceId;}
function requiredEnv(name:string){const value=process.env[name]?.trim();if(!value)throw new Error(`HUMAN_ACTION_REQUIRED: ${name} must explicitly name the confirmed sandbox target.`);return value;}
