import "dotenv/config";
const endpoint="https://qtyfdzjzmgxtrarpgcmn.supabase.co/functions/v1/mcp";
const token=process.env["AUTOPILOT_SUPERADMIN_MCP_TOKEN"]!;
const projectId="ac6d68be-272c-4bca-aab1-cd1a442cf960";
const taskId="807dc366-fd09-4176-af4e-92ddb977a865";
async function rpc<T>(m:string,p:unknown):Promise<T>{const r=await fetch(endpoint,{method:"POST",headers:{authorization:`Bearer ${token}`,accept:"application/json, text/event-stream","content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:crypto.randomUUID(),method:m,params:p})});const raw=await r.text();if(!r.ok)throw new Error(`${m} ${r.status}: ${raw.slice(0,300)}`);const d=raw.split(/\r?\n/).filter(l=>l.startsWith("data:")).map(l=>JSON.parse(l.slice(5).trim())).at(-1)??JSON.parse(raw);if(d.error)throw new Error(d.error.message);return d.result as T;}
async function call<T>(n:string,a:Record<string,unknown>):Promise<T>{const res=await rpc<{isError?:boolean;structuredContent?:{result:T};content?:Array<{text?:string}>}>("tools/call",{name:n,arguments:a});if(res.isError)throw new Error(`${n}: ${res.content?.map(v=>v.text).join("\n")}`);return (res.structuredContent?.result??JSON.parse(res.content![0]!.text!)) as T;}
try{ console.log("review:",JSON.stringify(await call("superadmin_task_review",{operationId:"momna-qa-testdb-01-review2",projectId,taskId})).slice(0,400)); }
catch(e){ console.log("review error:",(e as Error).message.slice(0,400)); }
const s=await call<{task:{state:string}}>("superadmin_task_status",{projectId,taskId});
console.log("state:",s.task.state);
