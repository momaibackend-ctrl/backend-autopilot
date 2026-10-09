import 'dotenv/config';
// Prepare job of autopilot-http-e2e.yml: claim the HTTP_E2E job for this workflow run, re-authorize
// the repository, and hand the environment job what it needs. It never executes project code.
//
// Writes step outputs `repository` (owner/name) and `sha` (40 hex) for the checkout step -- both
// validated server-side values, never caller input -- and <out>/input.json for the environment job.
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createArtifactBlobStore } from '../packages/adapters/artifact-storage/src/wiring.js';
import { ArtifactStore } from '../packages/artifact-store/src/index.js';
import { systemClock, uuidGenerator } from '../packages/core/src/ports.js';
import { prepareHttpE2eJob } from '../packages/ephemeral-environment/src/http-e2e-job.js';
import { PostgresStateStore } from '../packages/project-registry/src/postgres-store.js';

function argument(name:string){const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:undefined;}
function required(name:string){const value=process.env[name];if(!value)throw new Error(`${name} is required`);return value;}

const jobId=argument('--job')??process.env['AUTOPILOT_JOB_ID'];
const out=argument('--out');
if(!jobId||!z.string().uuid().safeParse(jobId).success)throw new Error('A valid --job identifier is required');
if(!out)throw new Error('--out is required');
const store=new PostgresStateStore(required('DATABASE_URL'));
const blobs=createArtifactBlobStore({get:name=>process.env[name],requireCurrentSupabase:()=>({url:required('SUPABASE_URL'),serviceRoleKey:required('SUPABASE_SERVICE_ROLE_KEY')})});
const artifacts=new ArtifactStore(store,uuidGenerator,systemClock,blobs);
const runId=process.env['GITHUB_RUN_ID'];
const owner=`github-actions:${runId??crypto.randomUUID()}:${process.env['GITHUB_RUN_ATTEMPT']??'1'}`;
const workflowRunUrl=process.env['GITHUB_SERVER_URL']&&process.env['GITHUB_REPOSITORY']&&runId?`${process.env['GITHUB_SERVER_URL']}/${process.env['GITHUB_REPOSITORY']}/actions/runs/${runId}`:undefined;

const prepared=await prepareHttpE2eJob({store,clock:systemClock,ids:uuidGenerator,artifacts},{jobId,owner,...(runId?{workflowRunId:runId}:{}),...(workflowRunUrl?{workflowRunUrl}:{})});
const validTarget=(repository:string,sha:string)=>/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)&&/^[0-9a-f]{40}$/.test(sha);
if(!validTarget(prepared.repository,prepared.commitSha)||(prepared.counterpart&&!validTarget(prepared.counterpart.repository,prepared.counterpart.commitSha)))throw new Error('Prepared target failed validation');
await mkdir(out,{recursive:true});
await writeFile(join(out,'input.json'),JSON.stringify({jobId,commitSha:prepared.commitSha,...(prepared.root===undefined?{}:{root:prepared.root}),...(prepared.stripPathPrefix?{stripPathPrefix:prepared.stripPathPrefix}:{}),...(prepared.scenarios?{scenarios:prepared.scenarios}:{}),...(prepared.counterpart?{counterpart:{commitSha:prepared.counterpart.commitSha,label:prepared.counterpart.label,...(prepared.counterpart.root===undefined?{}:{root:prepared.counterpart.root})}}:{})}));
const outputs=process.env['GITHUB_OUTPUT'];
if(outputs)await appendFile(outputs,`repository=${prepared.repository}\nsha=${prepared.commitSha}\ncounterpart_repository=${prepared.counterpart?.repository??''}\ncounterpart_sha=${prepared.counterpart?.commitSha??''}\n`);
console.log(JSON.stringify({level:'info',event:'http_e2e.prepared',jobId,repository:prepared.repository,commitSha:prepared.commitSha,scenarioSource:prepared.scenarios?'SAVED':'REPOSITORY'}));
await store.close();
