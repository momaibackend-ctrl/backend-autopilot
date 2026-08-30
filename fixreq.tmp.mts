import "dotenv/config";
const endpoint="https://qtyfdzjzmgxtrarpgcmn.supabase.co/functions/v1/mcp";
const token=process.env["AUTOPILOT_SUPERADMIN_MCP_TOKEN"]!;
const projectId="ac6d68be-272c-4bca-aab1-cd1a442cf960";
const taskId="807dc366-fd09-4176-af4e-92ddb977a865";
async function rpc<T>(m:string,p:unknown):Promise<T>{const r=await fetch(endpoint,{method:"POST",headers:{authorization:`Bearer ${token}`,accept:"application/json, text/event-stream","content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:crypto.randomUUID(),method:m,params:p})});const raw=await r.text();if(!r.ok)throw new Error(`${m} ${r.status}: ${raw.slice(0,300)}`);const d=raw.split(/\r?\n/).filter(l=>l.startsWith("data:")).map(l=>JSON.parse(l.slice(5).trim())).at(-1)??JSON.parse(raw);if(d.error)throw new Error(d.error.message);return d.result as T;}
async function call<T>(n:string,a:Record<string,unknown>):Promise<T>{const res=await rpc<{isError?:boolean;structuredContent?:{result:T};content?:Array<{text?:string}>}>("tools/call",{name:n,arguments:a});if(res.isError)throw new Error(`${n}: ${res.content?.map(v=>v.text).join("\n")}`);return (res.structuredContent?.result??JSON.parse(res.content![0]!.text!)) as T;}
const brief=(l:string,v:unknown)=>console.log(l,JSON.stringify(v).slice(0,200));
brief("blocked:",await call("superadmin_task_transition",{operationId:"momna-qa-testdb-01-block",projectId,taskId,to:"BLOCKED",reason:"Independent review failed on the observability check: the change alters what CI reports about skipped test layers, and the requirements never said so."}));
brief("updated:",await call("superadmin_task_update",{operationId:"momna-qa-testdb-01-req",projectId,taskId,requirements:[
 "Introduce one resolver that is the single place deciding where the test database is and whether the PostgreSQL suite runs.",
 "Make TEST_DATABASE_URL canonical and keep POSTGRES_TEST_URL working as a deprecated alias, so the two can never again gate different test classes.",
 "Where the suite is declared mandatory, an absent or placeholder database must fail the tests rather than return early.",
 "Where it is not declared mandatory, the tests must remain skippable and be reported as skipped rather than as passed.",
 "Improve the observability of the test suite itself: a skipped PostgreSQL layer must be visible as skipped in the JUnit report and in the CI log output, so that what actually ran is no longer ambiguous to anyone reading the result.",
 "CI must set both variables from the same disposable PostgreSQL and declare the suite mandatory.",
 "CI must log per-class evidence and fail unless every required PostgreSQL test class produced executed, non-skipped, non-failing cases.",
 "Cover the resolver itself with unit tests that need no database.",
 "Change no Kotlin main source, no migration, no contract registry file and no product behaviour.",
]}));
brief("analyzed:",await call("superadmin_task_analyze",{operationId:"momna-qa-testdb-01-analyze2",projectId,taskId}));
brief("planned:",await call("superadmin_task_plan",{operationId:"momna-qa-testdb-01-plan2",projectId,taskId}));
