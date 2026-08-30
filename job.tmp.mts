import "dotenv/config";
const endpoint="https://qtyfdzjzmgxtrarpgcmn.supabase.co/functions/v1/mcp";
const token=process.env["AUTOPILOT_SUPERADMIN_MCP_TOKEN"]!;
const projectId="ac6d68be-272c-4bca-aab1-cd1a442cf960";
const taskId="807dc366-fd09-4176-af4e-92ddb977a865";
async function rpc<T>(m:string,p:unknown):Promise<T>{const r=await fetch(endpoint,{method:"POST",headers:{authorization:`Bearer ${token}`,accept:"application/json, text/event-stream","content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:crypto.randomUUID(),method:m,params:p})});const raw=await r.text();if(!r.ok)throw new Error(`${m} ${r.status}`);const d=raw.split(/\r?\n/).filter(l=>l.startsWith("data:")).map(l=>JSON.parse(l.slice(5).trim())).at(-1)??JSON.parse(raw);if(d.error)throw new Error(d.error.message);return d.result as T;}
async function call<T>(n:string,a:Record<string,unknown>):Promise<T>{const res=await rpc<{isError?:boolean;structuredContent?:{result:T};content?:Array<{text?:string}>}>("tools/call",{name:n,arguments:a});if(res.isError)throw new Error(`${n}: ${res.content?.map(v=>v.text).join("\n")}`);return (res.structuredContent?.result??JSON.parse(res.content![0]!.text!)) as T;}
const jobs=await call<Array<{id:string;kind:string;status:string;attempt:number;error?:unknown;result?:unknown;workflowRunUrl?:string}>>("superadmin_job_list",{projectId,taskId});
for(const j of jobs) console.log(JSON.stringify({kind:j.kind,status:j.status,attempt:j.attempt,url:j.workflowRunUrl,error:j.error}).slice(0,600));
const arts=await call<Array<{id:string;kind:string;createdAt:string}>>("superadmin_artifact_list",{projectId,taskId});
console.log("artifacts:",arts.map(a=>a.kind).join(", "));
const pl=arts.filter(a=>a.kind==="IMPLEMENTATION_PLAN").at(-1)!;
const full=await call<{content:{riskLevel?:string;testsRequired?:string[];databaseChanges?:string[];apiChanges?:string[];securityConsiderations?:string[];rollbackStrategy?:string;requirements?:string[]}}>("superadmin_artifact_get",{projectId,artifactId:pl.id});
const c=full.content;
console.log("riskLevel:",c.riskLevel);
console.log("testsRequired:",JSON.stringify(c.testsRequired));
console.log("databaseChanges:",JSON.stringify(c.databaseChanges));
console.log("apiChanges:",JSON.stringify(c.apiChanges));
console.log("securityConsiderations:",JSON.stringify(c.securityConsiderations,null,1));
console.log("rollbackStrategy:",c.rollbackStrategy);
