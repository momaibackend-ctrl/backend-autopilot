import 'dotenv/config';

const endpoint=process.env['AUTOPILOT_REMOTE_MCP_URL']??'https://qtyfdzjzmgxtrarpgcmn.supabase.co/functions/v1/mcp';
const token=required('AUTOPILOT_MCP_TOKEN');
const githubToken=required('AUTOPILOT_GITHUB_TOKEN');
const projectId=process.env['AUTOPILOT_REMOTE_E2E_PROJECT_ID']??'ac6d68be-272c-4bca-aab1-cd1a442cf960';
const resourceId=process.env['AUTOPILOT_REMOTE_E2E_RESOURCE_ID']??'ea5c3e1e-0b0d-46ff-b0ed-dd931a6d7b14';
const targetRepository=process.env['AUTOPILOT_REMOTE_E2E_REPOSITORY']??'momaibackend-ctrl/momnabackend';
if(targetRepository!=='momaibackend-ctrl/momnabackend')throw new Error('Remote E2E is restricted to the explicit sandbox repository');

const originalRegression=await fetch(`https://api.github.com/repos/${targetRepository}/contents/tests/regression.test.js?ref=main`,{headers:{accept:'application/vnd.github.raw+json',authorization:`Bearer ${githubToken}`,'user-agent':'backend-autopilot-remote-e2e','x-github-api-version':'2022-11-28'}}).then(async response=>{if(!response.ok)throw new Error(`Unable to read sandbox regression fixture (${response.status})`);return response.text();});
const suffix=Date.now().toString(36).toUpperCase();
const task=await call<{id:string}>('task_create',{projectId,externalKey:`REMOTE-${suffix}`,title:'Remote repair lifecycle proof',description:'Prove asynchronous GitHub Actions execution, durable failure and exact-SHA repair',requirements:['Apply and verify one isolated sandbox source change'],relationships:[]});
await call('task_analyze',{projectId,taskId:task.id});
await call('task_plan',{projectId,taskId:task.id});
const failingOperation=`remote-fail-${suffix.toLowerCase()}`;
const first=await call<{job:{id:string}}>('task_execute',{projectId,taskId:task.id,resourceId,operationId:failingOperation,changes:[{path:'tests/regression.test.js',content:"import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('intentional remote repair probe',()=>assert.equal(1,2));\n"}]});
const failed=await waitForJob(first.job.id);
if(failed.status!=='FAILED')throw new Error(`Expected first remote job to fail, received ${failed.status}`);
const failedTask=await call<{state:string;repairAttempts:number}>('task_get',{projectId,taskId:task.id});
if(failedTask.state!=='IMPLEMENTING'||failedTask.repairAttempts!==1)throw new Error(`Repair lifecycle was not persisted after failure (${failedTask.state}/${failedTask.repairAttempts})`);
const repairOperation=`remote-repair-${suffix.toLowerCase()}`;
const second=await call<{job:{id:string}}>('task_execute',{projectId,taskId:task.id,resourceId,operationId:repairOperation,changes:[{path:'tests/regression.test.js',content:originalRegression}]});
const succeeded=await waitForJob(second.job.id);
if(succeeded.status!=='SUCCEEDED')throw new Error(`Expected repair job to succeed, received ${succeeded.status}`);
const ready=await call<{task:{state:string;repairAttempts:number};artifacts:Array<{kind:string}>}>('task_status',{projectId,taskId:task.id});
if(ready.task.state!=='READY')throw new Error(`Remote task did not reach READY (${ready.task.state})`);
const replay=await call<{job:{id:string};idempotentReplay:boolean}>('task_execute',{projectId,taskId:task.id,resourceId,operationId:repairOperation,changes:[{path:'tests/regression.test.js',content:originalRegression}]});
if(!replay.idempotentReplay||replay.job.id!==second.job.id)throw new Error('Remote execution idempotency replay failed');
const kinds=new Set(ready.artifacts.map(value=>value.kind));
for(const requiredKind of ['IMPLEMENTATION_PLAN','ARCHITECTURE_REVIEW','CODE_DIFF','TEST_REPORT','SECURITY_REPORT','CI_REPORT','REVIEW_REPORT','FINAL_CHANGE_MANIFEST'])if(!kinds.has(requiredKind))throw new Error(`READY artifact missing: ${requiredKind}`);
console.log(JSON.stringify({success:true,projectId,taskId:task.id,failedJobId:first.job.id,repairJobId:second.job.id,repairAttempts:ready.task.repairAttempts,state:ready.task.state,branch:succeeded.branch,commitSha:succeeded.commitSha,artifactKinds:[...kinds].sort()}));

async function waitForJob(jobId:string){for(let attempt=0;attempt<90;attempt++){const job=await call<{status:string;branch?:string;commitSha?:string}>('job_get',{projectId,jobId});if(['SUCCEEDED','FAILED','CANCELLED','TIMED_OUT','BLOCKED'].includes(job.status))return job;await new Promise(resolve=>setTimeout(resolve,10_000));}throw new Error(`Timed out waiting for remote job ${jobId}`);}
async function call<T=unknown>(name:string,args:Record<string,unknown>):Promise<T>{const response=await fetch(endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,accept:'application/json, text/event-stream','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/call',params:{name,arguments:args}})});const raw=await response.text();if(!response.ok)throw new Error(`Remote MCP ${name} failed (${response.status})`);const data=raw.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5).trim()) as {result?:{isError?:boolean;structuredContent?:{result:T};content?:Array<{text?:string}>};error?:{message?:string}}).at(-1)??JSON.parse(raw) as {result?:{isError?:boolean;structuredContent?:{result:T};content?:Array<{text?:string}>};error?:{message?:string}};if(data.error)throw new Error(data.error.message??`Remote MCP ${name} returned an error`);if(data.result?.isError)throw new Error(data.result.content?.map(value=>value.text).join('\n')??`Remote MCP ${name} tool failed`);const structured=data.result?.structuredContent?.result;if(structured!==undefined)return structured;const text=data.result?.content?.[0]?.text;if(!text)throw new Error(`Remote MCP ${name} returned no result`);return JSON.parse(text) as T;}
function required(name:string){const value=process.env[name];if(!value)throw new Error(`${name} is required`);return value;}
