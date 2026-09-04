import "dotenv/config";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The endpoint is required rather than defaulted. This previously fell back to a hardcoded project
// URL, which is how a retired project ref outlives a cutover: the script keeps running green
// against whatever was baked in, or -- once that project is suspended -- fails with a transport
// error that says nothing about the real cause. Set AUTOPILOT_REMOTE_MCP_URL (the canonical deploy
// derives the same value from AUTOPILOT_NEXT_SUPABASE_URL).
const endpoint=requiredEndpoint();
const token=required("AUTOPILOT_SUPERADMIN_MCP_TOKEN");
const githubToken=required("AUTOPILOT_GITHUB_TOKEN");
const projectId=process.env["AUTOPILOT_REMOTE_E2E_PROJECT_ID"]??"ac6d68be-272c-4bca-aab1-cd1a442cf960";
const resourceId=process.env["AUTOPILOT_REMOTE_E2E_RESOURCE_ID"]??"ea5c3e1e-0b0d-46ff-b0ed-dd931a6d7b14";
const repository=process.env["AUTOPILOT_REMOTE_E2E_REPOSITORY"]??"momaibackend-ctrl/momnabackend";
if(repository!=="momaibackend-ctrl/momnabackend")throw new Error("SUPERADMIN E2E is restricted to the explicit sandbox repository");

const suffix=Date.now().toString(36).toLowerCase();
let temporaryProject:{id:string;slug:string}|undefined;
let temporaryTaskId:string|undefined;
let lifecycleTaskId:string|undefined;
let lifecycleBranch:string|undefined;
let originalDashboard:Screen|undefined;
let screenChanged=false;
const cleanupErrors:string[]=[];
let proof:Record<string,unknown>|undefined;
let primaryError:unknown;

try{
  const overview=await call<{capabilities:{superadminMcp:string};safety:{productionWrites:string}}>("superadmin_system_overview",{});
  if(overview.capabilities.superadminMcp!=="FULL_SYSTEM_CONTROL"||overview.safety.productionWrites!=="NOT_SUPPORTED")throw new Error("Superadmin overview safety/capability mismatch");

  originalDashboard=await call<Screen>("superadmin_screen_get",{screenId:"dashboard"});
  await call("superadmin_screen_upsert",{operationId:`screen-set-${suffix}`,screenId:"dashboard",navigationLabel:"Dashboard",title:"SUPERADMIN MCP E2E",description:"Remote semantic configuration proof",enabled:true,navigationOrder:10,blocks:[{id:"remote-proof",type:"TEXT",title:"Remote MCP proof",content:`v0.5 remote proof ${suffix}`}]});
  screenChanged=true;

  const projectEnvelope=await call<Envelope<{id:string;slug:string}>>("superadmin_project_create",{operationId:`project-create-${suffix}`,name:"Remote SUPERADMIN E2E",slug:`remote-superadmin-${suffix}`,sourceType:"MCP",environment:"SANDBOX",autonomyMode:"AUTONOMOUS_STAGING"});
  temporaryProject=projectEnvelope.value;
  await call("superadmin_project_update",{operationId:`project-update-${suffix}`,projectId:temporaryProject.id,name:"Remote SUPERADMIN E2E Updated",status:"ACTIVE"});
  const taskEnvelope=await call<Envelope<{id:string}>>("superadmin_task_create",{operationId:`task-create-${suffix}`,projectId:temporaryProject.id,externalKey:`ADMIN-${suffix.toUpperCase()}`,title:"Initial admin task",description:"Remote-only semantic CRUD",requirements:["Create and update through MCP"],relationships:[]});
  temporaryTaskId=taskEnvelope.value.id;
  await call("superadmin_task_update",{operationId:`task-update-${suffix}`,projectId:temporaryProject.id,taskId:temporaryTaskId,title:"Updated admin task",requirements:["Create through MCP","Update through MCP","Validate through MCP"]});
  await call("superadmin_task_analyze",{operationId:`task-analyze-${suffix}`,projectId:temporaryProject.id,taskId:temporaryTaskId});
  await call("superadmin_task_plan",{operationId:`task-plan-${suffix}`,projectId:temporaryProject.id,taskId:temporaryTaskId});
  await call("superadmin_validation_run",{operationId:`validation-${suffix}`,projectId:temporaryProject.id,taskId:temporaryTaskId,suite:"SMOKE"});
  const note=await call<Envelope<{id:string}>>("superadmin_artifact_create",{operationId:`artifact-create-${suffix}`,projectId:temporaryProject.id,taskId:temporaryTaskId,kind:"ADMIN_NOTE",content:{proof:"created"}});
  await call("superadmin_artifact_update",{operationId:`artifact-update-${suffix}`,projectId:temporaryProject.id,artifactId:note.value.id,content:{proof:"updated"}});
  const readNote=await call<{content:{proof:string} }>("superadmin_artifact_get",{projectId:temporaryProject.id,artifactId:note.value.id});
  if(readNote.content.proof!=="updated")throw new Error("Artifact CRUD update was not persisted");
  await call("superadmin_artifact_delete",{operationId:`artifact-delete-${suffix}`,projectId:temporaryProject.id,artifactId:note.value.id,confirmation:"DELETE_ARTIFACT",reason:"Remove temporary admin note"});

  const lifecycle=await call<Envelope<{id:string}>>("superadmin_task_create",{operationId:`lifecycle-create-${suffix}`,projectId,externalKey:`SUPERADMIN-${suffix.toUpperCase()}`,title:"Remote SUPERADMIN MCP lifecycle proof",description:"Execute the complete sandbox lifecycle through authenticated HTTP MCP",requirements:["Use registered sandbox repository","Run real tests","Reach READY through formal gates"],relationships:[]});
  lifecycleTaskId=lifecycle.value.id;
  await call("superadmin_task_update",{operationId:`lifecycle-update-${suffix}`,projectId,taskId:lifecycleTaskId,description:"Updated before planning; remote execution must remain policy controlled"});
  await call("superadmin_task_analyze",{operationId:`lifecycle-analyze-${suffix}`,projectId,taskId:lifecycleTaskId});
  await call("superadmin_task_plan",{operationId:`lifecycle-plan-${suffix}`,projectId,taskId:lifecycleTaskId});
  const fixtureRef="autopilot/LIVE-1-live-notes-crud-rest-api";
  const fixturePaths=["src/notes.js","tests/helpers.js","tests/unit.test.js","tests/integration.test.js","tests/security.test.js","tests/regression.test.js"];
  const changes=await Promise.all(fixturePaths.map(async path=>({path,content:await githubFile(path,fixtureRef)})));
  changes.push({path:`src/superadmin-mcp-${suffix}.js`,content:`export const superadminMcpProof = ${JSON.stringify(suffix)};\n`});
  const execution=await call<Envelope<{job:{id:string}}>>("superadmin_task_execute",{operationId:`lifecycle-execute-${suffix}`,projectId,taskId:lifecycleTaskId,resourceId,changes});
  const job=await waitForJob(execution.value.job.id);
  if(job.status!=="SUCCEEDED")throw new Error(`Remote lifecycle job ended as ${job.status}`);
  lifecycleBranch=job.branch;
  const status=await call<{task:{state:string};runs:Array<{id:string}>;artifacts:Array<{id:string;kind:string}>;jobs:Array<{id:string}>}>("task_status",{projectId,taskId:lifecycleTaskId});
  if(status.task.state!=="READY")throw new Error(`Remote lifecycle did not reach READY (${status.task.state})`);
  const run=status.runs.at(-1);if(!run)throw new Error("Lifecycle run is missing");
  await call("superadmin_job_get",{projectId,jobId:execution.value.job.id});
  await call("superadmin_run_get",{projectId,runId:run.id});
  const finalArtifact=status.artifacts.find(value=>value.kind==="FINAL_CHANGE_MANIFEST");if(!finalArtifact)throw new Error("Final change manifest is missing");
  await call("superadmin_artifact_get",{projectId,artifactId:finalArtifact.id});
  const audit=await call<Array<{action:string;actor:string}>>("superadmin_audit_list",{projectId});
  if(!audit.some(value=>value.action==="mcp.task_execute"&&value.actor==="momaibackend-ctrl-superadmin"))throw new Error("MCP task_execute audit event is missing");

  runPagesCheck(`v0.5 remote proof ${suffix}`);
  proof={success:true,remoteOnly:true,temporaryProjectId:temporaryProject.id,lifecycleTaskId,jobId:execution.value.job.id,runId:run.id,branch:job.branch,commitSha:job.commitSha,artifactCount:status.artifacts.length,screenProof:`v0.5 remote proof ${suffix}`};
}catch(error){
  primaryError=error;
}finally{
  if(screenChanged&&originalDashboard)await cleanupCall("superadmin_screen_upsert",{operationId:`screen-restore-${suffix}`,screenId:originalDashboard.screenId,navigationLabel:originalDashboard.navigationLabel,title:originalDashboard.title,description:originalDashboard.description,enabled:originalDashboard.enabled,navigationOrder:originalDashboard.navigationOrder,blocks:originalDashboard.blocks});
  if(lifecycleTaskId)await cleanupTask(projectId,lifecycleTaskId,`lifecycle-clean-${suffix}`);
  if(temporaryProject&&temporaryTaskId){await cleanupTask(temporaryProject.id,temporaryTaskId,`temp-task-clean-${suffix}`);await cleanupCall("superadmin_project_delete",{operationId:`project-delete-${suffix}`,projectId:temporaryProject.id,expectedSlug:temporaryProject.slug,confirmation:"ARCHIVE_PROJECT",reason:"Remove temporary remote E2E project"});}
  if(lifecycleBranch)await deleteBranch(lifecycleBranch);
}
if(cleanupErrors.length)throw new Error(`SUPERADMIN E2E cleanup failed: ${cleanupErrors.join('; ')}`);
if(primaryError)throw primaryError;
if(!proof)throw new Error("SUPERADMIN E2E produced no proof");
console.log(JSON.stringify(proof));

async function cleanupTask(targetProjectId:string,taskId:string,prefix:string){try{const task=await call<{state:string;deletedAt?:string}>("superadmin_task_get",{projectId:targetProjectId,taskId});if(task.deletedAt)return;if(!["INGESTED","BLOCKED","FAILED","READY"].includes(task.state))await call("superadmin_task_transition",{operationId:`${prefix}-block`,projectId:targetProjectId,taskId,to:"BLOCKED",reason:"Prepare temporary E2E task for tombstone cleanup"});await call("superadmin_task_delete",{operationId:`${prefix}-delete`,projectId:targetProjectId,taskId,confirmation:"DELETE_TASK",reason:"Remove temporary remote E2E task"});}catch(error){cleanupErrors.push(error instanceof Error?error.message:"task cleanup failed");}}
async function cleanupCall(name:string,args:Record<string,unknown>){try{await call(name,args);}catch(error){cleanupErrors.push(error instanceof Error?error.message:`${name} cleanup failed`);}}
async function waitForJob(jobId:string){for(let attempt=0;attempt<90;attempt++){const job=await call<{status:string;branch?:string;commitSha?:string}>("superadmin_job_get",{projectId,jobId});if(["SUCCEEDED","FAILED","CANCELLED","TIMED_OUT","BLOCKED"].includes(job.status))return job;await new Promise(resolve=>setTimeout(resolve,10_000));}throw new Error(`Timed out waiting for remote job ${jobId}`);}
function runPagesCheck(expectedText:string){const tsxCli=fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs",import.meta.url));const script=fileURLToPath(new URL("./pages-e2e.ts",import.meta.url));execFileSync(process.execPath,[tsxCli,script],{env:{...process.env,AUTOPILOT_PAGES_E2E_OPERATOR_EMAILS:"momaibackend@gmail.com",AUTOPILOT_PAGES_E2E_URL:"https://momaibackend-ctrl.github.io/backend-autopilot",AUTOPILOT_PAGES_E2E_EXPECT_TEXT:expectedText},stdio:"inherit"});}
async function githubFile(path:string,ref:string){const response=await fetch(`https://api.github.com/repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`,{headers:{accept:"application/vnd.github.raw+json",authorization:`Bearer ${githubToken}`,"user-agent":"backend-autopilot-superadmin-e2e","x-github-api-version":"2022-11-28"}});if(!response.ok)throw new Error(`Unable to read sandbox fixture ${path} (${response.status})`);return response.text();}
async function deleteBranch(branch:string){const response=await fetch(`https://api.github.com/repos/${repository}/git/refs/heads/${encodeURIComponent(branch)}`,{method:"DELETE",headers:{authorization:`Bearer ${githubToken}`,accept:"application/vnd.github+json","user-agent":"backend-autopilot-superadmin-e2e","x-github-api-version":"2022-11-28"}});if(!response.ok&&response.status!==422&&response.status!==404)cleanupErrors.push(`branch cleanup failed (${response.status})`);}
async function call<T=unknown>(name:string,args:Record<string,unknown>):Promise<T>{const response=await fetch(endpoint,{method:"POST",headers:{authorization:`Bearer ${token}`,accept:"application/json, text/event-stream","content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:crypto.randomUUID(),method:"tools/call",params:{name,arguments:args}})});const raw=await response.text();if(!response.ok)throw new Error(`Remote MCP ${name} failed (${response.status})`);const data=raw.split(/\r?\n/).filter(line=>line.startsWith("data:")).map(line=>JSON.parse(line.slice(5).trim()) as McpResponse<T>).at(-1)??JSON.parse(raw) as McpResponse<T>;if(data.error)throw new Error(data.error.message??`Remote MCP ${name} returned an error`);if(data.result?.isError)throw new Error(data.result.content?.map(value=>value.text).join("\n")??`Remote MCP ${name} tool failed`);const structured=data.result?.structuredContent?.result;if(structured!==undefined)return structured;const text=data.result?.content?.[0]?.text;if(!text)throw new Error(`Remote MCP ${name} returned no result`);return JSON.parse(text) as T;}
function required(name:string){const value=process.env[name];if(!value)throw new Error(`${name} is required`);return value;}
type Envelope<T>={value:T;idempotentReplay:boolean};
type Screen={screenId:string;navigationLabel:string;title:string;description:string;enabled:boolean;navigationOrder:number;blocks:unknown[]};
type McpResponse<T>={result?:{isError?:boolean;structuredContent?:{result:T};content?:Array<{text?:string}>};error?:{message?:string}};

function requiredEndpoint():string{
  const value=process.env['AUTOPILOT_REMOTE_MCP_URL'];
  if(!value)throw new Error('AUTOPILOT_REMOTE_MCP_URL is required (e.g. https://<project-ref>.supabase.co/functions/v1/mcp)');
  return value;
}
