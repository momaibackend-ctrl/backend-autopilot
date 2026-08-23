import 'dotenv/config';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { ArtifactStore } from '../packages/artifact-store/src/index.js';
import { AuditLog } from '../packages/audit/src/index.js';
import { systemClock, uuidGenerator } from '../packages/core/src/ports.js';
import { disposeWorkspaceDirectory, ensureDisposableCleanWorkspace, workspaceCheckoutExists } from '../packages/execution-engine/src/index.js';
import { PostgresStateStore } from '../packages/project-registry/src/index.js';
import type { Project, Resource, Run } from '../packages/schemas/src/index.js';
import { materializeSnapshot, readDeploymentSnapshot, type DeploymentSnapshot } from './deployment-state.js';

const databaseUrl=required('DATABASE_URL');
const workspaceRoot=resolve(process.env['AUTOPILOT_WORKSPACE_ROOT']??'/data/workspaces');
const seedPath=resolve(process.env['AUTOPILOT_DEPLOYMENT_SEED']??'deployment/bootstrap-state.json');
const pool=new Pool({connectionString:databaseUrl});

try {
  await migrate(pool);
  const imported=await importSeed(pool,materializeSnapshot(await readDeploymentSnapshot(seedPath),workspaceRoot));
  console.log(JSON.stringify({level:'info',event:'deployment.state_ready',imported}));
} finally {
  await pool.end();
}

if (process.env['AUTOPILOT_RESTORE_WORKSPACES']==='true') {
  const store=new PostgresStateStore(databaseUrl);
  try {
    for (const project of await store.listProjects()) {
      await restoreWorkspace(store,project);
    }
  } finally {
    await store.close();
  }
}

async function migrate(target:Pool) {
  const sql=await readFile(new URL('../packages/project-registry/migrations/0001_initial.sql',import.meta.url),'utf8');
  await target.query(sql);
  console.log(JSON.stringify({level:'info',event:'deployment.migration_complete',migration:'0001_initial'}));
}

async function importSeed(target:Pool,snapshot:DeploymentSnapshot) {
  const client=await target.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('backend-autopilot-deployment-bootstrap'))");
    const existing=await client.query<{count:string}>('SELECT count(*)::text AS count FROM projects');
    if (existing.rows[0]?.count!=='0') {
      await client.query('COMMIT');
      return false;
    }
    for (const value of snapshot.projects) await insert(client,'projects',['id','slug','data','created_at'],[value.id,value.slug,value,value.createdAt]);
    for (const value of snapshot.resources) await insert(client,'resources',['id','project_id','provider','external_reference','data','created_at'],[value.resourceId,value.projectId,value.provider,value.externalReference,value,value.createdAt]);
    for (const value of snapshot.contexts) await insert(client,'project_contexts',['id','project_id','data','created_at'],[value.id,value.projectId,value,value.createdAt]);
    for (const value of snapshot.tasks) await insert(client,'tasks',['id','project_id','external_key','data','created_at'],[value.id,value.projectId,value.externalKey,value,value.createdAt]);
    for (const value of snapshot.artifacts) await insert(client,'artifacts',['id','project_id','task_id','data','created_at'],[value.id,value.projectId,value.taskId??null,value,value.createdAt]);
    for (const value of snapshot.runs) await insert(client,'runs',['id','project_id','task_id','operation_id','data','created_at'],[value.id,value.projectId,value.taskId,value.operationId,value,value.startedAt]);
    for (const value of snapshot.transitions) await insert(client,'task_transitions',['id','task_id','data','created_at'],[value.id,value.taskId,value,value.timestamp]);
    for (const value of snapshot.audit) await insert(client,'audit_events',['id','project_id','data','created_at'],[value.id,value.projectId,value,value.timestamp]);
    await client.query('COMMIT');
    return true;
  } catch(error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function insert(client:PoolClient,table:string,columns:string[],values:unknown[]) {
  const placeholders=values.map((_,index)=>`$${index+1}`).join(',');
  await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`,values);
}

async function restoreWorkspace(store:PostgresStateStore,project:Project) {
  const resources=await store.listResources(project.id);
  const repository=resources.find(resource=>resource.type==='GITHUB_REPOSITORY'&&resource.provider==='github'&&resource.status==='ACTIVE');
  const account=resources.find(resource=>resource.type==='GITHUB_ACCOUNT'&&resource.provider==='github'&&resource.status==='ACTIVE');
  if (!repository||!account) return;
  assertOwnedRepository(account,repository);
  const actual=(await run('gh',['api','user','--jq','.login'],process.cwd())).stdout.trim();
  if (actual.toLowerCase()!==account.externalReference.toLowerCase()) {
    throw new Error(`Configured GitHub identity does not match the registered sandbox account (${actual||'unknown'})`);
  }
  // The restored workspace is disposable. A reused directory left unclean by an interrupted run
  // would otherwise fail ExecutionEngine's clean-tree precondition on the next execution, before
  // the payload is applied. The precondition stays; the dirty tree is captured as evidence, the
  // attempt is quarantined, the directory is deleted and a clean checkout is restored for the
  // same project -- resuming from the persisted task branch checkpoint, repeating no external
  // provisioning step.
  const artifacts=new ArtifactStore(store,uuidGenerator,systemClock);
  const audit=new AuditLog(store,uuidGenerator,systemClock);
  const result=await ensureDisposableCleanWorkspace({
    workspace:project.workspacePath,
    now:()=>systemClock.now(),
    exists:workspaceCheckoutExists,
    create:async()=>{
      await mkdir(dirname(project.workspacePath),{recursive:true});
      await run('gh',['repo','clone',repository.externalReference,project.workspacePath],process.cwd());
      const latest=latestBranch(await store.listRuns(project.id));
      if (latest) await run('git',['switch','--track',`origin/${latest}`],project.workspacePath);
      await run('git',['config','user.email','autopilot@localhost.invalid'],project.workspacePath);
      await run('git',['config','user.name','Backend Autopilot'],project.workspacePath);
      if (await exists(join(project.workspacePath,'pnpm-lock.yaml'))) {
        await run('pnpm',['install','--frozen-lockfile','--ignore-scripts'],project.workspacePath);
      }
      console.log(JSON.stringify({level:'info',event:'deployment.workspace_restored',projectId:project.id,repository:repository.externalReference,branch:latest}));
      return project.workspacePath;
    },
    inspect:async workspace=>{
      const status=await capture(workspace,['status','--porcelain']);
      const diff=await capture(workspace,['diff','HEAD']);
      return {status:status.ok?status.output:`!! git status failed\n${status.output}`,diff:diff.ok?diff.output:''};
    },
    dispose:workspace=>disposeWorkspaceDirectory(workspace,workspaceRoot),
    quarantine:async record=>{
      const artifact=await artifacts.write(project.id,'WORKSPACE_QUARANTINE',{quarantined:true,scope:'DEPLOYMENT_WORKSPACE_RESTORE',...record});
      await audit.record({actor:'deployment-bootstrap',action:'execution.workspace.quarantined',projectId:project.id,resourceId:repository.resourceId,input:{workspace:record.workspace,attempt:record.attempt},result:{artifactId:artifact.id,statusTruncated:record.statusTruncated,diffTruncated:record.diffTruncated},reason:'Interrupted run left an unclean reused workspace; the attempt is quarantined and a clean checkout restored',correlationId:`workspace-quarantine-${project.id}-${record.attempt}`});
      console.log(JSON.stringify({level:'warn',event:'deployment.workspace_quarantined',projectId:project.id,attempt:record.attempt,artifactId:artifact.id}));
    },
  });
  if (!result.created) console.log(JSON.stringify({level:'info',event:'deployment.workspace_reused',projectId:project.id}));
}

async function capture(cwd:string,args:string[]) {
  try {
    return {ok:true,output:(await run('git',args,cwd)).stdout};
  } catch(error) {
    return {ok:false,output:error instanceof Error?error.message:'git command failed'};
  }
}

function assertOwnedRepository(account:Resource,repository:Resource) {
  const [owner,name,...rest]=repository.externalReference.split('/');
  if (!owner||!name||rest.length||owner.toLowerCase()!==account.externalReference.toLowerCase()) {
    throw new Error('Registered GitHub repository does not belong to the registered sandbox account');
  }
}

function latestBranch(runs:Run[]) {
  return runs.filter(run=>run.branch?.startsWith('autopilot/')).sort((a,b)=>a.startedAt.localeCompare(b.startedAt)).at(-1)?.branch;
}

async function run(command:string,args:string[],cwd:string) {
  return new Promise<{stdout:string;stderr:string}>((resolveRun,reject)=>{
    const child=spawn(command,args,{cwd,shell:false,env:process.env});
    let stdout='';let stderr='';
    child.stdout.on('data',(value:Buffer)=>stdout+=value.toString());
    child.stderr.on('data',(value:Buffer)=>stderr+=value.toString());
    child.on('error',reject);
    child.on('close',code=>code===0?resolveRun({stdout,stderr}):reject(new Error(`${command} failed with exit code ${code}: ${stderr.slice(0,500)}`)));
  });
}

async function exists(path:string){try{await access(path);return true;}catch{return false;}}
function required(name:string){const value=process.env[name]?.trim();if(!value)throw new Error(`${name} is required for remote deployment`);return value;}
