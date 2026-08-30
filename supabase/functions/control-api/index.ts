import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { ArtifactStore } from '../../../packages/artifact-store/src/index.ts';
import { AuditLog } from '../../../packages/audit/src/index.ts';
import { systemClock, uuidGenerator } from '../../../packages/core/src/ports.ts';
import { DomainError, NotFound } from '../../../packages/core/src/errors.ts';
import { apiRequestInputSchema } from '../../../packages/schemas/src/index.ts';
import { PolicyEngine } from '../../../packages/policy-engine/src/index.ts';
import { defaultHttpRunnerLimits, resolveHttpApiTarget, resolveStepUrl } from '../../../packages/http-runner/src/index.ts';
import type { SuperadminPrincipal } from '../../../packages/superadmin/src/index.ts';
import { deliveryForProject } from '../../../packages/operator-console/src/delivery.ts';
import { apiView, capabilitiesView, databaseView, lifecycleRail, safeResource, taskSummaryFrom, taskTimeline, validationHistoryView } from '../../../packages/operator-console/src/projections.ts';
import { authenticatedOperator, corsHeaders, createEdgeRuntime, EdgeHttpError, json } from '../_shared/edge-runtime.ts';

Deno.serve(async request=>{const cors=corsHeaders(request);if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});try{return await route(request,cors);}catch(error){if(error instanceof EdgeHttpError)return json({error:{code:error.code,message:error.message,details:error.details}},error.status,cors);if(error instanceof DomainError)return json({error:{code:error.code,message:error.message,details:error.details}},error.code==='NOT_FOUND'?404:error.code==='POLICY_VIOLATION'||error.code==='NOT_SUPPORTED'?403:409,cors);console.error(JSON.stringify({event:'edge.control.error',name:error instanceof Error?error.name:'Unknown'}));return json({error:{code:'INTERNAL',message:'The request could not be completed'}},500,cors);}});

async function route(request:Request,cors:HeadersInit){const runtime=createEdgeRuntime();const url=new URL(request.url);const path=url.pathname.replace(/^\/(?:functions\/v1\/)?control-api/,'')||'/';const parts=path.split('/').filter(Boolean);const body=async()=>request.headers.get('content-length')==='0'?{}:request.json();
  if(path==='/health'&&request.method==='GET'){await authenticatedOperator(request);return json(await runtime.service.systemHealth(),200,cors);}
  if(path==='/v1/projects'&&request.method==='GET'){const user=await authenticatedOperator(request);if(user.role==='SUPERADMIN')return json(await runtime.service.projectList(),200,cors);const memberships=await fetch(`${runtime.url}/rest/v1/autopilot_project_memberships?select=project_id&user_id=eq.${user.id}`,{headers:{apikey:runtime.serviceKey,authorization:`Bearer ${runtime.serviceKey}`}}).then(value=>value.json()) as {project_id:string}[];const allowed=new Set(memberships.map(value=>value.project_id));return json((await runtime.service.projectList()).filter(project=>allowed.has(project.id)),200,cors);}
  if(path==='/v1/projects'&&request.method==='POST'){const user=await authenticatedOperator(request);const project=await runtime.service.projectCreate(await body(),user.id);await fetch(`${runtime.url}/rest/v1/autopilot_project_memberships`,{method:'POST',headers:{apikey:runtime.serviceKey,authorization:`Bearer ${runtime.serviceKey}`,'content-type':'application/json'},body:JSON.stringify({user_id:user.id,project_id:project.id,role:'ADMIN'})});return json(project,201,cors);}
  const projectId=parts[1]==='projects'?parts[2]:parts[1]==='console'&&parts[2]==='projects'?parts[3]:undefined;const viewer=projectId?await authenticatedOperator(request,projectId):await authenticatedOperator(request);
  if(parts[1]==='projects'&&parts.length===3&&request.method==='GET')return json(await runtime.service.projectGet(projectId!),200,cors);
  if(parts[1]==='projects'&&parts[3]==='snapshot'&&request.method==='GET')return json(await runtime.service.projectSnapshot(projectId!),200,cors);
  if(parts[1]==='projects'&&parts[3]==='resources'&&request.method==='GET')return json(await runtime.service.resourceList(projectId!),200,cors);
  if(parts[1]==='projects'&&parts[3]==='resources'&&request.method==='POST')return json(await runtime.service.resourceRegister({...await body() as object,projectId},'edge-operator'),201,cors);
  if(parts[1]==='projects'&&parts[3]==='tasks'&&parts.length===4&&request.method==='GET')return json(await runtime.service.taskList(projectId!),200,cors);
  if(parts[1]==='projects'&&parts[3]==='tasks'&&parts.length===4&&request.method==='POST')return json(await runtime.service.taskCreate({...await body() as object,projectId},'edge-operator'),201,cors);
  const taskId=parts[3]==='tasks'?parts[4]:undefined;
  if(taskId&&parts.length===5&&request.method==='GET')return json(await runtime.service.taskGet(projectId!,taskId),200,cors);
  if(taskId&&parts[5]==='analyze'&&request.method==='POST')return json(await runtime.service.taskAnalyze(projectId!,taskId,'edge-operator'),200,cors);
  if(taskId&&parts[5]==='plan'&&request.method==='POST')return json(await runtime.service.taskPlan(projectId!,taskId,'edge-operator'),200,cors);
  if(taskId&&parts[5]==='execute'&&request.method==='POST'){const value=await body() as {resourceId:string;operationId:string;changes:unknown[]};return json(await runtime.asyncExecution.enqueueImplementation({projectId,taskId,operationId:value.operationId,changes:value.changes},value.resourceId,'edge-operator'),202,cors);}
  if(taskId&&parts[5]==='review'&&request.method==='POST')return json(await runtime.service.taskReview(projectId!,taskId,'edge-operator'),200,cors);
  if(taskId&&parts[5]==='retry'&&request.method==='POST')return json(await runtime.service.taskRetry(projectId!,taskId,'edge-operator'),200,cors);
  if(taskId&&parts[5]==='status'&&request.method==='GET'){const status=await runtime.service.taskStatus(projectId!,taskId);return json({...status,jobs:await runtime.asyncExecution.list(projectId!,taskId)},200,cors);}
  if(parts[1]==='projects'&&parts[3]==='jobs'&&request.method==='GET')return json(await runtime.asyncExecution.list(projectId!,url.searchParams.get('taskId')??undefined),200,cors);
  if(parts[1]==='projects'&&parts[3]==='jobs'&&parts[4]&&request.method==='GET')return json(await runtime.asyncExecution.get(projectId!,parts[4]),200,cors);
  if(parts[1]==='projects'&&parts[3]==='artifacts'&&request.method==='GET')return json(await runtime.service.artifactList(projectId!,url.searchParams.get('taskId')??undefined),200,cors);
  if(parts[1]==='projects'&&parts[3]==='artifacts'&&parts[4]&&request.method==='GET')return json(await runtime.service.artifactRead(projectId!,parts[4]),200,cors);
  if(parts[1]==='projects'&&parts[3]==='runs'&&request.method==='GET')return json(await runtime.service.runList(projectId!,url.searchParams.get('taskId')??undefined),200,cors);
  if(parts[1]==='projects'&&parts[3]==='runs'&&parts[4]&&request.method==='GET')return json(await runtime.service.runGet(projectId!,parts[4]),200,cors);
  if(parts[1]==='projects'&&parts[3]==='audit'&&request.method==='GET')return json(await runtime.store.listAudit(projectId!),200,cors);
  // Epic-level verification, published on the same authenticated surface as everything else it
  // aggregates. Verify is a read: it evaluates evidence, it never runs anything, so a plain
  // operator may ask what the epic still owes. Recording evidence is a write and carries the
  // operator's own identity into the provenance, which is what keeps OPERATOR distinguishable
  // from TRUSTED_CI.
  if(parts[1]==='projects'&&parts[3]==='epic'&&parts[4]==='verify'&&request.method==='POST')
    return json(await runtime.service.epicVerification({...await body() as object,projectId},`edge-operator:${viewer.id}`),200,cors);
  if(parts[1]==='projects'&&parts[3]==='epic'&&parts[4]==='evidence'&&request.method==='POST')
    return json(await runtime.service.epicEvidenceRecord({...await body() as object,projectId},`edge-operator:${viewer.id}`),201,cors);
  if(path==='/v1/console/overview'&&request.method==='GET')return json(await overview(runtime,viewer),200,cors);
  if(path==='/v1/console/screens'&&request.method==='GET')return json(await runtime.store.listConsoleScreens(),200,cors);
  if(parts[1]==='console'&&parts[2]==='screens'&&parts[3]&&request.method==='GET'){const screen=await runtime.store.getConsoleScreen(parts[3]);if(!screen)throw new NotFound('Console screen not found');return json(screen,200,cors);}
  if(path==='/v1/console/settings'&&request.method==='GET')return json((await runtime.store.listSystemSettings()).filter(value=>value.visibility!=='SUPERADMIN'),200,cors);
  if(parts[1]==='console'&&parts[2]==='projects'&&parts.length===4&&request.method==='GET')return json(await projectView(runtime,parts[3]),200,cors);
  if(parts[1]==='console'&&parts[2]==='projects'&&parts[4]==='delivery'&&request.method==='GET'){const snapshot=await runtime.service.projectSnapshot(parts[3]!);return json({project:{id:snapshot.project.id,name:snapshot.project.name},...deliveryForProject({tasks:snapshot.tasks,runs:snapshot.runs,artifacts:snapshot.artifacts,jobs:await runtime.asyncExecution.list(parts[3]!),audit:snapshot.audit})},200,cors);}
  if(parts[1]==='console'&&parts[2]==='projects'&&parts[4]==='tasks'&&parts[5]&&request.method==='GET')return json(await taskView(runtime,parts[3],parts[5]),200,cors);
  // Validation + scenarios. These four routes existed only on the node dev server, so on the
  // deployed console every one of them 404'd: history stayed permanently empty (the UI swallows a
  // failed GET) and both action buttons reported "Edge Control API route not found". The write
  // paths delegate to the same SuperadminService methods the MCP function already runs on this
  // runtime, so no new execution or auth surface is introduced -- a non-SUPERADMIN operator now
  // gets an explicit policy error instead of a misleading 404.
  if(parts[1]==='console'&&parts[2]==='projects'&&parts[4]==='validation'&&request.method==='GET')
    return json(validationHistoryView(await runtime.store.listArtifacts(parts[3]!,url.searchParams.get('taskId')??undefined)),200,cors);
  if(parts[1]==='console'&&parts[2]==='projects'&&parts[4]==='validation'&&request.method==='POST'){
    const value=await body() as {taskId:string;suite:string;operationId:string};
    const outcome=await runtime.superadmin.validationRun(consolePrincipal(viewer),parts[3]!,value);
    return json({report:outcome.value,idempotentReplay:outcome.idempotentReplay},200,cors);
  }
  if(parts[1]==='console'&&parts[2]==='projects'&&parts[4]==='scenarios'&&parts.length===5&&request.method==='POST'){
    const value=await body() as {operationId:string};
    const outcome=await runtime.superadmin.scenarioCreate(consolePrincipal(viewer),parts[3]!,value,value.operationId);
    return json({report:outcome.value,idempotentReplay:outcome.idempotentReplay},200,cors);
  }
  if(parts[1]==='console'&&parts[2]==='projects'&&parts[4]==='scenarios'&&parts[5]==='run'&&request.method==='POST'){
    // The console names the field scenarioArtifactId; the service takes scenarioId. Same artifact.
    const value=await body() as {scenarioArtifactId?:string;scenarioId?:string;operationId:string};
    const scenarioId=value.scenarioId??value.scenarioArtifactId;
    if(!scenarioId)throw new NotFound('A scenario identifier is required');
    const outcome=await runtime.superadmin.scenarioRun(consolePrincipal(viewer),parts[3]!,{scenarioId,operationId:value.operationId});
    return json({report:outcome.value,idempotentReplay:outcome.idempotentReplay},200,cors);
  }
  if(parts[1]==='console'&&parts[2]==='projects'&&parts[4]==='api-request'&&request.method==='POST')return json(await apiRequest(runtime,parts[3],await body()),200,cors);
  throw new NotFound('Edge Control API route not found');}

async function overview(runtime:ReturnType<typeof createEdgeRuntime>,viewer:Awaited<ReturnType<typeof authenticatedOperator>>){const allProjects=await runtime.service.projectList();let projects=allProjects;if(viewer.role!=='SUPERADMIN'){const memberships=await fetch(`${runtime.url}/rest/v1/autopilot_project_memberships?select=project_id&user_id=eq.${encodeURIComponent(viewer.id)}`,{headers:{apikey:runtime.serviceKey,authorization:`Bearer ${runtime.serviceKey}`}}).then(value=>value.json()) as {project_id:string}[];const allowed=new Set(memberships.map(value=>value.project_id));projects=allProjects.filter(project=>allowed.has(project.id));}const cards=await Promise.all(projects.map(async project=>{const snapshot=await runtime.service.projectSnapshot(project.id);const repository=snapshot.resources.find(value=>value.type==='GITHUB_REPOSITORY');const database=snapshot.resources.find(value=>value.type==='DATABASE');const events=snapshot.audit.slice(-5).reverse();return {id:project.id,name:project.name,environment:project.environment,autonomyMode:project.autonomyMode,status:project.status,repository:repository?.externalReference,databaseProvider:database?.provider,databaseProject:database?.externalReference,taskSource:project.sourceType,createdAt:project.createdAt,lastActivity:events[0]?.timestamp,tasks:snapshot.tasks.map(task=>({...task,artifactCount:snapshot.artifacts.filter(value=>value.taskId===task.id).length,branch:snapshot.runs.filter(value=>value.taskId===task.id).at(-1)?.branch,commitSha:snapshot.runs.filter(value=>value.taskId===task.id).at(-1)?.commitSha})),runs:snapshot.runs,latestCi:snapshot.artifacts.filter(value=>value.kind==='CI_REPORT').at(-1)?.content,warningCount:snapshot.tasks.filter(value=>['BLOCKED','FAILED'].includes(value.state)).length,recentEvents:events};}));const tasks=cards.flatMap(value=>value.tasks),runs=cards.flatMap(value=>value.runs),events=cards.flatMap(value=>value.recentEvents).sort((a,b)=>b.timestamp.localeCompare(a.timestamp)).slice(0,12);return {generatedAt:new Date().toISOString(),summary:{projects:cards.length,activeTasks:tasks.filter(value=>!['READY','FAILED','BLOCKED'].includes(value.state)).length,blocked:tasks.filter(value=>value.state==='BLOCKED').length,failed:tasks.filter(value=>value.state==='FAILED').length,ready:tasks.filter(value=>value.state==='READY').length,runningRuns:runs.filter(value=>value.status==='RUNNING').length,warnings:cards.reduce((sum,value)=>sum+value.warningCount,0)},projects:cards,events};}

// Maps an authenticated console operator onto the principal SuperadminService expects. Role is
// carried through unchanged, so the service's own SUPERADMIN gate still decides what is allowed.
function consolePrincipal(viewer:Awaited<ReturnType<typeof authenticatedOperator>>):SuperadminPrincipal{
  // The auth layer and the domain use different names for the same non-superadmin role
  // ('OPERATOR' vs PrincipalRole's 'PROJECT_OPERATOR'), so translate rather than widen the domain
  // type. Behaviour is unchanged either way -- SuperadminService gates on role === 'SUPERADMIN' --
  // but leaving the mismatch in place made this a value TypeScript could not check.
  return {actor:viewer.email??viewer.id,role:viewer.role==='SUPERADMIN'?'SUPERADMIN':'PROJECT_OPERATOR',authMethod:'OAUTH'};
}

async function projectView(runtime:ReturnType<typeof createEdgeRuntime>,projectId:string){
  const snapshot=await runtime.service.projectSnapshot(projectId);
  const jobs=await runtime.asyncExecution.list(projectId);
  return {
    project:snapshot.project,
    resources:snapshot.resources.map(safeResource),
    context:snapshot.context,
    // Enriched from the snapshot already in hand -- never one taskStatus call per task, which on
    // PostgREST would be three HTTP round-trips per task on every five-second console poll.
    tasks:snapshot.tasks.map(task=>taskSummaryFrom({task,artifacts:snapshot.artifacts,runs:snapshot.runs})),
    runs:snapshot.runs,
    artifacts:snapshot.artifacts,
    audit:snapshot.audit,
    capabilities:capabilitiesView({audit:snapshot.audit,artifacts:snapshot.artifacts,runtime:{controlPlane:'SUPABASE',execution:'GITHUB_ACTIONS',console:'GITHUB_PAGES',productionWrites:'NOT_SUPPORTED'}}),
    database:databaseView(snapshot.resources,snapshot.artifacts),
    api:apiView(snapshot.artifacts),
    validation:validationHistoryView(snapshot.artifacts),
    delivery:deliveryForProject({tasks:snapshot.tasks,runs:snapshot.runs,artifacts:snapshot.artifacts,jobs,audit:snapshot.audit}),
  };
}
async function taskView(runtime:ReturnType<typeof createEdgeRuntime>,projectId:string,taskId:string){
  const status=await runtime.service.taskStatus(projectId,taskId),artifacts=status.artifacts,latest=(kind:string)=>artifacts.filter(value=>value.kind===kind).at(-1)?.content;
  const rail=lifecycleRail(status.task.state);
  return {
    task:status.task,
    lifecycle:rail.rungs,
    lifecycleState:rail,
    currentRun:status.runs.at(-1),
    branch:status.runs.at(-1)?.branch,
    commitSha:status.runs.at(-1)?.commitSha,
    ci:latest('CI_REPORT'),
    review:latest('REVIEW_REPORT'),
    plan:latest('IMPLEMENTATION_PLAN'),
    architecture:latest('ARCHITECTURE_REVIEW'),
    requirements:latest('REQUIREMENTS_SNAPSHOT'),
    codeChanges:latest('CODE_DIFF'),
    databaseChanges:artifacts.filter(value=>value.kind==='MIGRATION_MANIFEST'),
    apiChanges:artifacts.filter(value=>value.kind==='API_CONTRACT'),
    tests:artifacts.filter(value=>value.kind==='TEST_REPORT'),
    security:artifacts.filter(value=>value.kind==='SECURITY_REPORT'),
    repairHistory:status.runs.slice(1),
    finalManifest:latest('FINAL_CHANGE_MANIFEST'),
    artifacts,
    // Merged transitions+runs, every event carrying a `status`. Handing the console raw Transition
    // rows (which have from/to but no status) made tone(event.status) throw and blanked the page.
    timeline:taskTimeline(status.transitions,status.runs),
    validation:validationHistoryView(artifacts),
    jobs:await runtime.asyncExecution.list(projectId,taskId),
  };
}
async function apiRequest(runtime:ReturnType<typeof createEdgeRuntime>,projectId:string,input:unknown){const data=apiRequestInputSchema.parse(input),project=await runtime.service.projectGet(projectId),resource=await runtime.store.getResource(data.resourceId);if(!resource||resource.projectId!==projectId||resource.type!=='HTTP_API')throw new NotFound('Registered project API resource not found');await new PolicyEngine(runtime.store).authorize({project,action:'NETWORK',resourceId:resource.resourceId,requiredPermission:'READ',actor:'edge-api-runner'});const base=resolveHttpApiTarget(resource);const target=resolveStepUrl(base,data.path,data.query);const response=await fetch(target,{method:data.method,headers:data.headers,...(data.body===undefined?{}:{body:JSON.stringify(data.body)}),redirect:'manual',signal:AbortSignal.timeout(defaultHttpRunnerLimits.requestTimeoutMs)});const raw=await response.text();let responseBody:unknown=raw;try{responseBody=JSON.parse(raw);}catch{/* plain response */}const content={operationId:data.operationId,projectId,taskId:data.taskId,request:{method:data.method,url:`${base.origin}${target.pathname}${target.search}`},response:{status:response.status,body:responseBody},validation:{passed:data.expectedStatus===undefined||data.expectedStatus===response.status}};const artifact=await new ArtifactStore(runtime.store,uuidGenerator,systemClock,runtime.blobs).write(projectId,'API_REQUEST_RESULT',content,data.taskId);await new AuditLog(runtime.store,uuidGenerator,systemClock).record({actor:'edge-operator',action:'validation.api_request',projectId,...(data.taskId?{taskId:data.taskId}:{}),resourceId:resource.resourceId,input:{method:data.method,path:data.path},result:{status:response.status,artifactId:artifact.id},reason:'Authenticated operator invoked allowlisted API',correlationId:data.operationId});return {result:artifact};}
