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
await store.close();
