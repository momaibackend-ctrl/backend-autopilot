import 'dotenv/config';
// Record job of autopilot-http-e2e.yml: validate the environment job's evidence and bind it to the
// commit. Only the run that holds the job's lease may record; a missing, oversized or malformed
// evidence file is recorded as NOT_PROVEN (INFRASTRUCTURE_UNAVAILABLE), never as a pass.
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { createArtifactBlobStore } from '../packages/adapters/artifact-storage/src/wiring.js';
import { ArtifactStore } from '../packages/artifact-store/src/index.js';
import { systemClock, uuidGenerator } from '../packages/core/src/ports.js';
import { MAX_EVIDENCE_BYTES, recordHttpE2eEvidence } from '../packages/ephemeral-environment/src/http-e2e-job.js';
import { PostgresStateStore } from '../packages/project-registry/src/postgres-store.js';
import { AutopilotService } from '../packages/core/src/application.js';
import { UnsupportedOperation } from '../packages/core/src/errors.js';

function argument(name:string){const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:undefined;}
function required(name:string){const value=process.env[name];if(!value)throw new Error(`${name} is required`);return value;}

const jobId=argument('--job')??process.env['AUTOPILOT_JOB_ID'];
const evidencePath=argument('--evidence');
if(!jobId||!z.string().uuid().safeParse(jobId).success)throw new Error('A valid --job identifier is required');
const store=new PostgresStateStore(required('DATABASE_URL'));
const blobs=createArtifactBlobStore({get:name=>process.env[name],requireCurrentSupabase:()=>({url:required('SUPABASE_URL'),serviceRoleKey:required('SUPABASE_SERVICE_ROLE_KEY')})});
const artifacts=new ArtifactStore(store,uuidGenerator,systemClock,blobs);
const owner=`github-actions:${process.env['GITHUB_RUN_ID']??crypto.randomUUID()}:${process.env['GITHUB_RUN_ATTEMPT']??'1'}`;

// The file is read only after its size is known, so an oversized artifact is refused, not buffered.
let evidenceText:string|undefined;
let evidenceOversized=false;
if(evidencePath){
  const size=await stat(evidencePath).then(value=>value.size).catch(()=>undefined);
  if(size!==undefined&&size>MAX_EVIDENCE_BYTES)evidenceOversized=true;
  else if(size!==undefined)evidenceText=await readFile(evidencePath,'utf8');
}
const recorded=await recordHttpE2eEvidence({store,clock:systemClock,ids:uuidGenerator,artifacts},{jobId,owner,evidenceOversized,...(evidenceText===undefined?{}:{evidenceText})});
console.log(JSON.stringify({level:'info',event:'http_e2e.recorded',jobId,verdict:recorded.verdict,accepted:recorded.accepted,artifactId:recorded.artifactId,status:recorded.job.status}));
// A task resting in VERIFYING for exactly this commit becomes READY now -- through the full gate,
// re-evaluated, never by trusting this verdict alone. A failure here leaves the task in VERIFYING,
// where superadmin_task_complete_verification can finish it.
if(recorded.verdict==='PROVEN'){
  const task=await store.getTask(recorded.job.projectId,recorded.job.taskId);
  const runs=await store.listRuns(recorded.job.projectId,recorded.job.taskId);
  if(task?.state==='VERIFYING'&&runs.at(-1)?.commitSha===recorded.job.baseCommitSha){
    const unavailable=async():Promise<never>=>{throw new UnsupportedOperation('Not available in the record job');};
    const service=new AutopilotService({store,execution:{execute:unavailable},tests:{run:unavailable},git:{snapshot:unavailable,branch:unavailable,stage:unavailable,diff:unavailable,commit:unavailable},commands:{drain:()=>[]},artifactBlobs:blobs});
    try{const completed=await service.taskCompleteVerification(task.projectId,task.id,owner,recorded.job.operationId);console.log(JSON.stringify({level:'info',event:'http_e2e.task_ready',taskId:task.id,state:completed.task.state}));}
    catch(error){console.error(JSON.stringify({level:'warn',event:'http_e2e.task_ready_failed',taskId:task.id,message:error instanceof Error?error.message:String(error)}));}
  }
}
await store.close();
