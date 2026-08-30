import "dotenv/config";

const endpoint=process.env["AUTOPILOT_REMOTE_MCP_URL"]??"https://qtyfdzjzmgxtrarpgcmn.supabase.co/functions/v1/mcp";
const token=required("AUTOPILOT_SUPERADMIN_MCP_TOKEN");
const githubToken=required("AUTOPILOT_GITHUB_TOKEN");
const projectId=process.env["AUTOPILOT_KOTLIN_E2E_PROJECT_ID"]??"ac6d68be-272c-4bca-aab1-cd1a442cf960";
const resourceId=process.env["AUTOPILOT_KOTLIN_E2E_RESOURCE_ID"]??"b6cb5344-cc45-46a1-bff7-d8520a7b69b8";
const repository=process.env["AUTOPILOT_KOTLIN_E2E_REPOSITORY"]??"momaibackend-ctrl/momna-backend";
if(repository!=="momaibackend-ctrl/momna-backend")throw new Error("Kotlin E2E is restricted to the explicit registered Momna backend repository");

const suffix=Date.now().toString(36).toLowerCase();
let taskId:string|undefined;
let branch:string|undefined;
const cleanupErrors:string[]=[];
let proof:Record<string,unknown>|undefined;
let primaryError:unknown;

const greetingSource=`package com.backendautopilot.sandbox\n\nfun greet(name: String): String = "Hello, $name!"\n`;
const failingTest=`package com.backendautopilot.sandbox\n\nimport kotlin.test.Test\nimport kotlin.test.assertEquals\n\nclass GreetingTest {\n    @Test\n    fun greetsByName() {\n        assertEquals("Hi, Autopilot!", greet("Autopilot"))\n    }\n}\n`;
const fixedTest=`package com.backendautopilot.sandbox\n\nimport kotlin.test.Test\nimport kotlin.test.assertEquals\n\nclass GreetingTest {\n    @Test\n    fun greetsByName() {\n        assertEquals("Hello, Autopilot!", greet("Autopilot"))\n    }\n}\n`;

try{
  const created=await call<Envelope<{id:string}>>("superadmin_task_create",{operationId:`kotlin-create-${suffix}`,projectId,externalKey:`KOTLIN-${suffix.toUpperCase()}`,title:"Kotlin sandbox greeting proof",description:"Add a small Kotlin/Gradle greeting function verified through the real Gradle Wrapper test and build tasks",requirements:["Compile with Kotlin/JVM 21 via Gradle Wrapper","Pass real ./gradlew test and ./gradlew build"],relationships:[]});
  taskId=created.value.id;
  await call("superadmin_task_analyze",{operationId:`kotlin-analyze-${suffix}`,projectId,taskId});
  await call("superadmin_task_plan",{operationId:`kotlin-plan-${suffix}`,projectId,taskId});

  const failing=await call<Envelope<{job:{id:string}}>>("superadmin_task_execute",{operationId:`kotlin-execute-${suffix}`,projectId,taskId,resourceId,changes:[
    {path:"src/main/kotlin/Greeting.kt",content:greetingSource,operation:"CREATE"},
    {path:"src/test/kotlin/GreetingTest.kt",content:failingTest,operation:"CREATE"},
  ]});
  const failedJob=await waitForJob(failing.value.job.id);
  branch=failedJob.branch;
  if(failedJob.status!=="FAILED")throw new Error(`Expected the intentionally-failing Kotlin job to end FAILED, got ${failedJob.status}`);
  const afterFailure=await call<{task:{state:string;repairAttempts:number}}>("task_status",{projectId,taskId});
  if(afterFailure.task.state!=="IMPLEMENTING")throw new Error(`Expected task to fall back to IMPLEMENTING after Gradle test failure, got ${afterFailure.task.state}`);
  if(afterFailure.task.repairAttempts<1)throw new Error("Expected repairAttempts to increment after Gradle test failure");

  const repaired=await call<Envelope<{job:{id:string}}>>("superadmin_task_execute",{operationId:`kotlin-repair-${suffix}`,projectId,taskId,resourceId,changes:[
    {path:"src/test/kotlin/GreetingTest.kt",content:fixedTest,operation:"UPDATE"},
  ]});
  const repairedJob=await waitForJob(repaired.value.job.id);
  if(repairedJob.status!=="SUCCEEDED")throw new Error(`Expected the repaired Kotlin job to end SUCCEEDED, got ${repairedJob.status}`);
  if(repairedJob.branch!==branch)throw new Error("Repair job landed on a different branch than the original execution");

  const status=await call<{task:{state:string};runs:Array<{id:string}>;artifacts:Array<{id:string;kind:string;content:unknown}>}>("task_status",{projectId,taskId});
  if(status.task.state!=="READY")throw new Error(`Kotlin lifecycle did not reach READY (${status.task.state})`);
  const ciReport=status.artifacts.find(value=>value.kind==="CI_REPORT");
  if(!ciReport)throw new Error("CI_REPORT artifact is missing");
  const ciContent=ciReport.content as {detectedStack?:string;toolchain?:{gradle?:string;kotlin?:string;jvm?:string}};
  if(ciContent.detectedStack!=="KOTLIN_GRADLE")throw new Error(`CI_REPORT.detectedStack was not KOTLIN_GRADLE (${ciContent.detectedStack})`);
  const finalManifest=status.artifacts.find(value=>value.kind==="FINAL_CHANGE_MANIFEST");
  if(!finalManifest)throw new Error("FINAL_CHANGE_MANIFEST artifact is missing");

  const audit=await call<Array<{action:string}>>("superadmin_audit_list",{projectId});
  if(!audit.some(value=>value.action==="mcp.task_execute"))throw new Error("MCP task_execute audit event is missing");

  proof={success:true,remoteOnly:true,taskId,branch,repository,detectedStack:ciContent.detectedStack,toolchain:ciContent.toolchain,failedJobId:failing.value.job.id,repairedJobId:repaired.value.job.id,artifactCount:status.artifacts.length};
}catch(error){
  primaryError=error;
}finally{
  if(taskId)await cleanupTask(projectId,taskId,`kotlin-clean-${suffix}`);
  if(branch)await deleteBranch(branch);
}
if(cleanupErrors.length)throw new Error(`Kotlin E2E cleanup failed: ${cleanupErrors.join('; ')}`);
if(primaryError)throw primaryError;
if(!proof)throw new Error("Kotlin E2E produced no proof");
console.log(JSON.stringify(proof));

async function cleanupTask(targetProjectId:string,id:string,prefix:string){try{const task=await call<{state:string;deletedAt?:string}>("superadmin_task_get",{projectId:targetProjectId,taskId:id});if(task.deletedAt)return;if(!["INGESTED","BLOCKED","FAILED","READY"].includes(task.state))await call("superadmin_task_transition",{operationId:`${prefix}-block`,projectId:targetProjectId,taskId:id,to:"BLOCKED",reason:"Prepare temporary Kotlin E2E task for tombstone cleanup"});await call("superadmin_task_delete",{operationId:`${prefix}-delete`,projectId:targetProjectId,taskId:id,confirmation:"DELETE_TASK",reason:"Remove temporary Kotlin E2E task"});}catch(error){cleanupErrors.push(error instanceof Error?error.message:"task cleanup failed");}}
async function waitForJob(jobId:string){for(let attempt=0;attempt<90;attempt++){const job=await call<{status:string;branch?:string;commitSha?:string}>("superadmin_job_get",{projectId,jobId});if(["SUCCEEDED","FAILED","CANCELLED","TIMED_OUT","BLOCKED"].includes(job.status))return job;await new Promise(resolve=>setTimeout(resolve,10_000));}throw new Error(`Timed out waiting for Kotlin remote job ${jobId}`);}
async function deleteBranch(name:string){const response=await fetch(`https://api.github.com/repos/${repository}/git/refs/heads/${encodeURIComponent(name)}`,{method:"DELETE",headers:{authorization:`Bearer ${githubToken}`,accept:"application/vnd.github+json","user-agent":"backend-autopilot-kotlin-e2e","x-github-api-version":"2022-11-28"}});if(!response.ok&&response.status!==422&&response.status!==404)cleanupErrors.push(`branch cleanup failed (${response.status})`);}
async function call<T=unknown>(name:string,args:Record<string,unknown>):Promise<T>{const response=await fetch(endpoint,{method:"POST",headers:{authorization:`Bearer ${token}`,accept:"application/json, text/event-stream","content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:crypto.randomUUID(),method:"tools/call",params:{name,arguments:args}})});const raw=await response.text();if(!response.ok)throw new Error(`Remote MCP ${name} failed (${response.status})`);const data=raw.split(/\r?\n/).filter(line=>line.startsWith("data:")).map(line=>JSON.parse(line.slice(5).trim()) as McpResponse<T>).at(-1)??JSON.parse(raw) as McpResponse<T>;if(data.error)throw new Error(data.error.message??`Remote MCP ${name} returned an error`);if(data.result?.isError)throw new Error(data.result.content?.map(value=>value.text).join("\n")??`Remote MCP ${name} tool failed`);const structured=data.result?.structuredContent?.result;if(structured!==undefined)return structured;const text=data.result?.content?.[0]?.text;if(!text)throw new Error(`Remote MCP ${name} returned no result`);return JSON.parse(text) as T;}
function required(name:string){const value=process.env[name];if(!value)throw new Error(`${name} is required`);return value;}
type Envelope<T>={value:T;idempotentReplay:boolean};
type McpResponse<T>={result?:{isError?:boolean;structuredContent?:{result:T};content?:Array<{text?:string}>};error?:{message?:string}};
