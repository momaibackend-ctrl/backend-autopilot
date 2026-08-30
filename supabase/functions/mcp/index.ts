import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { McpServer } from 'npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from 'npm:@modelcontextprotocol/sdk@1.25.3/server/webStandardStreamableHttp.js';
import { z } from 'npm:zod@3.25.76';
import { DomainError, ExecutionFailed, NotFound, PolicyViolation, UnsupportedOperation } from '../../../packages/core/src/errors.ts';
import { requireProjectGithubRepository } from '../../../packages/core/src/repository-guard.ts';
import { autonomyModeSchema, consoleBlockSchema, contextSectionTypeSchema, environmentSchema, epicDimensionSchema, fileChangeSchema, membershipRoleSchema, operatorRoleSchema, relationshipTypeSchema, repositoryIdentitySchema, resourcePermissionSchema, resourceTypeSchema, taskStateSchema, validationScenarioStepSchema, validationSuiteSchema } from '../../../packages/schemas/src/index.ts';
import type { SuperadminPrincipal } from '../../../packages/superadmin/src/index.ts';
import { resolveMergeableCommit } from '../../../packages/superadmin/src/merge-eligibility.ts';
import { scenarioRunToolAnnotations, scenarioRunToolDescription, scenarioRunToolInputSchema, scenarioRunToolName } from '../../../packages/http-runner/src/index.ts';
import { ArtifactStore } from '../../../packages/artifact-store/src/index.ts';
import { systemClock, uuidGenerator } from '../../../packages/core/src/ports.ts';
import { authenticatedOperator, createEdgeRuntime, EdgeHttpError, mcpProjectAllowed, required } from '../_shared/edge-runtime.ts';

type Principal=SuperadminPrincipal&{projectScoped:boolean};
type ToolResult={content:Array<{type:'text';text:string}>;structuredContent?:Record<string,unknown>;isError?:boolean};
const ro={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const mut={readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const destructive={readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false};
const operationId=z.string().min(8).max(200),projectId=z.string().uuid(),entityId=z.string().uuid();
const deleteInput={operationId,reason:z.string().min(8).max(500)};
const contextItems=z.array(z.object({type:contextSectionTypeSchema,content:z.unknown(),sourceType:z.enum(['TASK_SOURCE','FILE','MCP','USER','REPOSITORY','DECISION']),sourceRef:z.string()}));
const taskFields={projectId,externalKey:z.string().min(1),title:z.string().min(1),description:z.string(),requirements:z.array(z.string()),relationships:z.array(z.object({type:relationshipTypeSchema,targetTaskId:entityId})).default([])};
const resourceFields={projectId,type:resourceTypeSchema,provider:z.string().min(1),externalReference:z.string().min(1),environment:environmentSchema,permissions:z.array(resourcePermissionSchema).min(1),secretRefs:z.array(z.string()).default([]),status:z.enum(['ACTIVE','DISABLED']).default('ACTIVE')};
const scenarioFields={taskId:entityId.optional(),resourceId:entityId,name:z.string().min(1).max(120),description:z.string().max(1000).default(''),steps:z.array(validationScenarioStepSchema).min(1).max(20)};

Deno.serve(async request=>{
  const url=new URL(request.url);
  if(request.method==='GET'&&url.pathname.endsWith('/.well-known/oauth-protected-resource'))return protectedResourceMetadata();
  // A CORS preflight never carries Authorization, so it must be answered before authenticate()
  // or every browser-side MCP client fails discovery with 401 on the preflight itself.
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...mcpCorsHeaders(request),'access-control-max-age':'86400'}});
  const principal=await authenticate(request);
  if(!principal)return new Response(JSON.stringify({error:'unauthorized'}),{status:401,headers:{'content-type':'application/json','www-authenticate':`Bearer resource_metadata="${required('SUPABASE_URL')}/functions/v1/mcp/.well-known/oauth-protected-resource"`}});
  // This server is stateless (sessionIdGenerator:undefined) and never emits a server-initiated
  // message, so the standalone GET SSE stream the Streamable HTTP transport would open has nothing
  // to write. Supabase Edge does not flush response headers until the first body byte, so handing
  // GET to the transport leaves the client blocked with no status line at all until the isolate is
  // torn down (observed: >75s with no headers, then 500 "Network connection lost"). Connectors read
  // that as a dead session and drop the whole server mid-conversation. 405 is the spec's answer for
  // a server that does not offer a server->client stream, and clients handle it without retrying.
  if(request.method==='GET')return new Response(JSON.stringify({jsonrpc:'2.0',error:{code:-32000,message:'Method Not Allowed: this MCP server is stateless and offers no server-initiated SSE stream'},id:null}),{status:405,headers:{'content-type':'application/json',allow:'POST, DELETE, OPTIONS',...mcpCorsHeaders(request)}});
  const runtime=createEdgeRuntime();
  const server=new McpServer({name:'backend-autopilot',version:'0.5.0'});
  const result=(value:unknown):ToolResult=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:{result:value}});
  const safe=<T>(fn:(value:T)=>Promise<unknown>)=>async(value:T):Promise<ToolResult>=>{try{return result(await fn(value));}catch(error){if(error instanceof DomainError)return {isError:true,content:[{type:'text',text:JSON.stringify({error:{code:error.code,message:error.message,details:error.details}})}]};throw error;}};
  const scoped=(id:string)=>{if(principal.role!=='SUPERADMIN'&&!mcpProjectAllowed(id))throw new PolicyViolation('MCP token is not authorized for this project');};
  const admin=()=>{if(principal.role!=='SUPERADMIN')throw new PolicyViolation('SUPERADMIN role is required');return runtime.superadmin;};

  server.registerTool('system_health',{description:'Return remote control-plane health',inputSchema:{},annotations:ro},safe(async()=>runtime.service.systemHealth()));
  server.registerTool('runtime_status',{description:'Return immutable runtime composition and safety state',inputSchema:{},annotations:ro},safe(async()=>({controlPlane:'SUPABASE',execution:'GITHUB_ACTIONS',console:'GITHUB_PAGES',alwaysOnServer:false,arbitraryShell:false,productionWrites:'NOT_SUPPORTED'})));
  server.registerTool('project_list',{description:'List projects visible to this principal',inputSchema:{},annotations:ro},safe(async()=>{const values=await runtime.service.projectList();return principal.role==='SUPERADMIN'?values:values.filter(value=>mcpProjectAllowed(value.id));}));
  server.registerTool('project_get',{description:'Read one project',inputSchema:{projectId},annotations:ro},safe(async({projectId})=>{scoped(projectId);return runtime.service.projectGet(projectId);}));
  server.registerTool('resource_list',{description:'List project resources',inputSchema:{projectId},annotations:ro},safe(async({projectId})=>{scoped(projectId);return runtime.service.resourceList(projectId);}));
  server.registerTool('context_get',{description:'Read latest structured context',inputSchema:{projectId},annotations:ro},safe(async({projectId})=>{scoped(projectId);return runtime.service.contextGet(projectId);}));
  server.registerTool('task_list',{description:'List project tasks',inputSchema:{projectId},annotations:ro},safe(async({projectId})=>{scoped(projectId);return runtime.service.taskList(projectId);}));
  server.registerTool('task_get',{description:'Read one task',inputSchema:{projectId,taskId:entityId},annotations:ro},safe(async({projectId,taskId})=>{scoped(projectId);return runtime.service.taskGet(projectId,taskId);}));
  server.registerTool('task_status',{description:'Read lifecycle, jobs, runs and artifacts',inputSchema:{projectId,taskId:entityId},annotations:ro},safe(async({projectId,taskId})=>{scoped(projectId);return {...await runtime.service.taskStatus(projectId,taskId),jobs:await runtime.asyncExecution.list(projectId,taskId),readiness:await runtime.service.taskReadiness(projectId,taskId)};}));
  server.registerTool('artifact_list',{description:'List artifact metadata',inputSchema:{projectId,taskId:entityId.optional()},annotations:ro},safe(async({projectId,taskId})=>{scoped(projectId);return runtime.service.artifactList(projectId,taskId);}));
  server.registerTool('artifact_read',{description:'Read and hydrate one artifact',inputSchema:{projectId,artifactId:entityId},annotations:ro},safe(async({projectId,artifactId})=>{scoped(projectId);return runtime.service.artifactRead(projectId,artifactId);}));
  server.registerTool('run_list',{description:'List task runs',inputSchema:{projectId,taskId:entityId.optional()},annotations:ro},safe(async({projectId,taskId})=>{scoped(projectId);return runtime.service.runList(projectId,taskId);}));
  server.registerTool('run_get',{description:'Read one run',inputSchema:{projectId,runId:entityId},annotations:ro},safe(async({projectId,runId})=>{scoped(projectId);return runtime.service.runGet(projectId,runId);}));
  server.registerTool('job_list',{description:'List asynchronous execution jobs',inputSchema:{projectId,taskId:entityId.optional()},annotations:ro},safe(async({projectId,taskId})=>{scoped(projectId);return runtime.asyncExecution.list(projectId,taskId);}));
  server.registerTool('job_get',{description:'Read one asynchronous execution job',inputSchema:{projectId,jobId:entityId},annotations:ro},safe(async({projectId,jobId})=>{scoped(projectId);return runtime.asyncExecution.get(projectId,jobId);}));
  server.registerTool('project_snapshot',{description:'Read reproducible project snapshot',inputSchema:{projectId},annotations:ro},safe(async({projectId})=>{scoped(projectId);return runtime.service.projectSnapshot(projectId);}));

  server.registerTool('superadmin_system_overview',{description:'Return projects, tasks, jobs, failed gates, errors, capabilities, migrations, Edge deployment and Actions runs',inputSchema:{},annotations:ro},safe(async()=>admin().systemOverview(principal)));
  server.registerTool('superadmin_project_list',{description:'List every project regardless of membership',inputSchema:{},annotations:ro},safe(async()=>admin().projectList(principal)));
  server.registerTool('superadmin_project_get',{description:'Read any project',inputSchema:{projectId},annotations:ro},safe(async({projectId})=>admin().projectGet(principal,projectId)));
  server.registerTool('superadmin_project_create',{description:'Create a non-production project',inputSchema:{operationId,name:z.string().min(1),slug:z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),sourceType:z.string().min(1),environment:environmentSchema,autonomyMode:autonomyModeSchema},annotations:mut},safe(async value=>admin().projectCreate(principal,{...value,workspacePath:''},value.operationId)));
  server.registerTool('superadmin_project_update',{description:'Update safe project metadata, autonomy mode, or the canonical registered repository',inputSchema:{operationId,projectId,name:z.string().min(1).optional(),status:z.enum(['ACTIVE','SUSPENDED','ARCHIVED']).optional(),autonomyMode:autonomyModeSchema.optional(),sourceType:z.string().min(1).optional(),repository:repositoryIdentitySchema.optional()},annotations:mut},safe(async({operationId,projectId,...patch})=>admin().projectUpdate(principal,projectId,patch,operationId)));
  server.registerTool('superadmin_project_delete',{description:'Archive a project after exact slug confirmation; history remains auditable',inputSchema:{...deleteInput,projectId,expectedSlug:z.string(),confirmation:z.literal('ARCHIVE_PROJECT')},annotations:destructive},safe(async({projectId,expectedSlug,...input})=>admin().projectDelete(principal,projectId,expectedSlug,input)));

  server.registerTool('superadmin_resource_list',{description:'List resources for any project',inputSchema:{projectId},annotations:ro},safe(async({projectId})=>admin().resourceList(principal,projectId)));
  server.registerTool('superadmin_resource_get',{description:'Read one project-owned resource',inputSchema:{projectId,resourceId:entityId},annotations:ro},safe(async({projectId,resourceId})=>admin().resourceGet(principal,projectId,resourceId)));
  server.registerTool('superadmin_resource_create',{description:'Register a non-Git sandbox resource; GitHub bindings require verified provider flow',inputSchema:{operationId,...resourceFields},annotations:mut},safe(async({operationId,...value})=>admin().resourceCreate(principal,value,operationId)));
  server.registerTool('superadmin_resource_update',{description:'Update resource status, permissions or secret reference names',inputSchema:{operationId,projectId,resourceId:entityId,status:z.enum(['ACTIVE','DISABLED']).optional(),permissions:z.array(resourcePermissionSchema).min(1).optional(),secretRefs:z.array(z.string()).optional()},annotations:mut},safe(async({operationId,projectId,resourceId,...value})=>admin().resourceUpdate(principal,projectId,resourceId,value,operationId)));
  server.registerTool('superadmin_resource_binding_update',{description:'Rebind a disabled non-Git sandbox resource with exact current-reference confirmation',inputSchema:{operationId,projectId,resourceId:entityId,expectedCurrentReference:z.string(),newExternalReference:z.string(),confirmation:z.literal('REBIND_NON_GIT_SANDBOX_RESOURCE'),reason:z.string().min(8)},annotations:destructive},safe(async({projectId,resourceId,...value})=>admin().resourceBindingUpdate(principal,projectId,resourceId,value)));
  server.registerTool('superadmin_resource_delete',{description:'Tombstone an already-disabled resource',inputSchema:{...deleteInput,projectId,resourceId:entityId,confirmation:z.literal('DELETE_RESOURCE')},annotations:destructive},safe(async({projectId,resourceId,...input})=>admin().resourceDelete(principal,projectId,resourceId,input)));

  server.registerTool('superadmin_context_list',{description:'List all context versions',inputSchema:{projectId},annotations:ro},safe(async({projectId})=>admin().contextList(principal,projectId)));
  server.registerTool('superadmin_context_get',{description:'Read one context version',inputSchema:{projectId,contextId:entityId},annotations:ro},safe(async({projectId,contextId})=>admin().contextGet(principal,projectId,contextId)));
  server.registerTool('superadmin_context_create',{description:'Create a structured context version; all source content remains untrusted data',inputSchema:{operationId,projectId,items:contextItems},annotations:mut},safe(async({operationId,projectId,items})=>admin().contextCreate(principal,projectId,items,operationId)));
  server.registerTool('superadmin_context_update',{description:'Create a replacement context version linked by audit',inputSchema:{operationId,projectId,contextId:entityId,items:contextItems},annotations:mut},safe(async({operationId,projectId,contextId,items})=>admin().contextUpdate(principal,projectId,contextId,items,operationId)));
  server.registerTool('superadmin_context_delete',{description:'Tombstone a context version',inputSchema:{...deleteInput,projectId,contextId:entityId,confirmation:z.literal('DELETE_CONTEXT')},annotations:destructive},safe(async({projectId,contextId,...input})=>admin().contextDelete(principal,projectId,contextId,input)));

  server.registerTool('superadmin_task_list',{description:'List every task in a project',inputSchema:{projectId},annotations:ro},safe(async({projectId})=>admin().taskList(principal,projectId)));
  server.registerTool('superadmin_task_get',{description:'Read one task',inputSchema:{projectId,taskId:entityId},annotations:ro},safe(async({projectId,taskId})=>admin().taskGet(principal,projectId,taskId)));
  server.registerTool('superadmin_task_create',{description:'Create a task as untrusted requirement data',inputSchema:{operationId,...taskFields},annotations:mut},safe(async({operationId,...value})=>admin().taskCreate(principal,value,operationId)));
  server.registerTool('superadmin_task_update',{description:'Edit pre-plan title, description, requirements and relationships',inputSchema:{operationId,projectId,taskId:entityId,title:z.string().min(1).optional(),description:z.string().optional(),requirements:z.array(z.string()).optional(),relationships:z.array(z.object({type:relationshipTypeSchema,targetTaskId:entityId})).optional()},annotations:mut},safe(async({operationId,projectId,taskId,...value})=>admin().taskUpdate(principal,projectId,taskId,value,operationId)));
  server.registerTool('superadmin_task_transition',{description:'Perform only an allowed lifecycle transition; READY remains formal-gate-only',inputSchema:{operationId,projectId,taskId:entityId,to:taskStateSchema,reason:z.string().min(8)},annotations:mut},safe(async value=>admin().taskTransition(principal,value.projectId,value.taskId,value.to,value.reason,value.operationId)));
  // The preflight an agent should call whenever it is unsure what to do next. Answers from the
  // same functions the READY gate enforces, so guidance and gate cannot disagree.
  server.registerTool('superadmin_task_readiness',{description:'Report what a task still needs to reach READY: the next tool to call, every blocker with concrete remediation, which formal gate artifacts are present or missing, and the verification matrix the approved plan decided on (which test layers are REQUIRED, which are NOT_APPLICABLE, and why). Safe to call at any point, including before any work has run.',inputSchema:{projectId,taskId:entityId},annotations:ro},safe(async({projectId,taskId})=>{admin();return runtime.service.taskReadiness(projectId,taskId);}));
  // Twenty-one green tasks never meant a green epic: each verdict was true about the commit that
  // task ran on, and none of them ran on the commit the epic is released from. These two answer the
  // aggregate question instead -- see packages/core/src/epic-verification.ts.
  server.registerTool('superadmin_epic_verify',{description:'Judge a whole epic at ONE named head commit rather than as the union of its members past verdicts. Aggregates contracts, consumers, invariants, integration dependencies, security/privacy, migrations and cross-module journeys into one matrix; every dimension resolves to PASS, NOT_APPLICABLE with a reason, or BLOCKED with a remediation, and member evidence produced at an earlier commit counts as stale rather than as a pass. Read-only unless persist is true.',inputSchema:{projectId,epicKey:z.string().min(1),headSha:z.string().regex(/^[0-9a-f]{40}$/),repository:z.string().min(1).optional(),taskIds:z.array(entityId).optional(),externalKeyPrefix:z.string().min(1).optional(),persist:z.boolean().optional(),operationId:z.string().min(8).optional()},annotations:ro},safe(async value=>{admin();return runtime.service.epicVerification(value,principal.actor);}));
  // Starts the run that PRODUCES epic evidence, from one immutable checkout of the named commit.
  // It cannot decide the verdict: it records what ran and hands judgment back to superadmin_epic_verify.
  server.registerTool('superadmin_epic_run',{description:'Dispatch the epic verification workflow for one named commit. Checks out exactly that SHA (detached, verified by rev-parse), brings up real disposable PostgreSQL/Redis/object-storage, runs the target suite once, attributes results to the dimensions the members declared, records TRUSTED_CI evidence bound to that commit, and finally calls superadmin_epic_verify to produce the EPIC_VERIFICATION_REPORT. serviceEnv maps the target project own integration variable names onto the disposable services, so no project-specific names live in the control plane.',inputSchema:{operationId,projectId,epicKey:z.string().min(1),headSha:z.string().regex(/^[0-9a-f]{40}$/),resourceId:entityId,externalKeyPrefix:z.string().min(1).optional(),taskIds:z.array(entityId).optional(),serviceEnv:z.record(z.enum(['POSTGRES_URL','REDIS_URL','S3_ENDPOINT','S3_ACCESS_KEY','S3_SECRET_KEY','S3_BUCKET'])).optional()},annotations:{...mut,openWorldHint:true}},safe(async value=>admin().executeMutation(principal,'epic_run',value.projectId,value.operationId,{epicKey:value.epicKey,headSha:value.headSha},async()=>{
    await requireProjectGithubRepository(runtime.store,value.projectId,value.resourceId);
    if(!value.taskIds?.length&&!value.externalKeyPrefix)throw new PolicyViolation('Either taskIds or externalKeyPrefix must select the epic members');
    const payload={projectId:value.projectId,epicKey:value.epicKey,headSha:value.headSha,resourceId:value.resourceId,...(value.taskIds?.length?{taskIds:value.taskIds}:{externalKeyPrefix:value.externalKeyPrefix}),serviceEnv:value.serviceEnv??{}};
    return runtime.dispatcher.dispatchWorkflow(Deno.env.get('AUTOPILOT_EPIC_WORKFLOW')??'autopilot-epic-verification.yml',{epic_input:JSON.stringify(payload)});
  })));
  server.registerTool('superadmin_epic_evidence_record',{description:'Record one epic dimension result from a run that actually happened, bound to the exact commit and repository it ran against. Provenance is structured and the trust level is decided by the server from the recording actor, never accepted from the caller: evidence from the CI runner is TRUSTED_CI, everything else is OPERATOR. Manual evidence is allowed but can never masquerade as a CI run, and evidence is never reusable for a later head commit.',inputSchema:{operationId,projectId,epicKey:z.string().min(1),dimension:epicDimensionSchema,commitSha:z.string().regex(/^[0-9a-f]{40}$/),passed:z.boolean(),repository:z.string().min(1),detail:z.string().optional(),workflowRunId:z.string().optional(),workflowRunUrl:z.string().optional(),artifactHash:z.string().optional(),runnerVersion:z.string().optional()},annotations:mut},safe(async value=>admin().executeMutation(principal,'epic_evidence_record',value.projectId,value.operationId,value,()=>runtime.service.epicEvidenceRecord(value,principal.actor))));
  server.registerTool('superadmin_task_analyze',{description:'Run dependency analysis and requirements snapshot',inputSchema:{operationId,projectId,taskId:entityId},annotations:mut},safe(async value=>admin().executeMutation(principal,'task_analyze',value.projectId,value.operationId,value,()=>runtime.service.taskAnalyze(value.projectId,value.taskId,principal.actor,value.operationId))));
  server.registerTool('superadmin_task_plan',{description:'Create and ArchitectureGuard-check the implementation plan',inputSchema:{operationId,projectId,taskId:entityId},annotations:mut},safe(async value=>admin().executeMutation(principal,'task_plan',value.projectId,value.operationId,value,()=>runtime.service.taskPlan(value.projectId,value.taskId,principal.actor,value.operationId))));
  server.registerTool('superadmin_task_execute',{description:'Queue a fixed GitHub Actions execution using only a registered resource ID and semantic file changes',inputSchema:{operationId,projectId,taskId:entityId,resourceId:entityId,changes:z.array(fileChangeSchema).min(1)},annotations:{...mut,openWorldHint:true}},safe(async value=>admin().executeMutation(principal,'task_execute',value.projectId,value.operationId,{...value,changes:value.changes.map(change=>({path:change.path,operation:change.operation}))},()=>runtime.asyncExecution.enqueueImplementation(value,value.resourceId,principal.actor))));
  server.registerTool('superadmin_task_retry',{description:'Retry a BLOCKED or FAILED task within bounded repair policy',inputSchema:{operationId,projectId,taskId:entityId},annotations:mut},safe(async value=>admin().executeMutation(principal,'task_retry',value.projectId,value.operationId,value,()=>runtime.service.taskRetry(value.projectId,value.taskId,principal.actor))));
  server.registerTool('superadmin_task_review',{description:'Run independent review; READY still requires every formal artifact gate',inputSchema:{operationId,projectId,taskId:entityId},annotations:mut},safe(async value=>admin().executeMutation(principal,'task_review',value.projectId,value.operationId,value,()=>runtime.service.taskReview(value.projectId,value.taskId,principal.actor,value.operationId))));
  // Transfers an already-verified task onto the repository's CURRENT base branch after its
  // dependency was merged and its pull request went stale, instead of redoing the task. Branch,
  // verified commit, original base and manifest are all resolved server-side from durable
  // evidence -- the caller supplies none of them and cannot retarget the transfer. The replay is
  // a real 3-way cherry-pick of the task's own commit range: never a file copy, never ours/theirs.
  // A first call with no `resolutions` reports any genuine semantic conflict with three-sided
  // evidence; a second call carries the resolutions for exactly those paths, and the full
  // build/test/contract/migration/security/regression pipeline then re-verifies the result.
  server.registerTool('superadmin_task_rebase_onto_current_base',{description:'Transfer an already-verified READY task onto the current base branch of its registered repository after a dependency merge made the existing pull request conflict: replays the commit range of the task itself with a real 3-way cherry-pick, reports genuine semantic conflicts with base/current/task evidence, accepts resolutions for exactly those paths, re-runs the whole verification pipeline, then opens a fresh pull request and supersedes the stale one',inputSchema:{operationId,projectId,taskId:entityId,resourceId:entityId,resolutions:z.array(z.object({path:z.string().min(1).max(400),content:z.string().max(400000)})).max(50).default([])},annotations:{...mut,openWorldHint:true}},safe(async value=>admin().taskRebaseOntoCurrentBase(principal,value)));
  server.registerTool('superadmin_task_delete',{description:'Tombstone an unexecuted non-ready task',inputSchema:{...deleteInput,projectId,taskId:entityId,confirmation:z.literal('DELETE_TASK')},annotations:destructive},safe(async({projectId,taskId,...input})=>admin().taskDelete(principal,projectId,taskId,input)));

  server.registerTool('superadmin_job_list',{description:'List execution jobs',inputSchema:{projectId,taskId:entityId.optional()},annotations:ro},safe(async({projectId,taskId})=>admin().jobList(principal,projectId,taskId)));
  server.registerTool('superadmin_job_get',{description:'Read one execution job',inputSchema:{projectId,jobId:entityId},annotations:ro},safe(async({projectId,jobId})=>admin().jobGet(principal,projectId,jobId)));
  server.registerTool('superadmin_job_create',{description:'Create and dispatch a task execution job from structured file changes',inputSchema:{operationId,projectId,taskId:entityId,resourceId:entityId,changes:z.array(fileChangeSchema).min(1)},annotations:{...mut,openWorldHint:true}},safe(async value=>admin().jobCreate(principal,value,value.resourceId,value.operationId)));
  server.registerTool('superadmin_job_cancel',{description:'Cancel a non-terminal job with a structured reason',inputSchema:{...deleteInput,projectId,jobId:entityId,confirmation:z.literal('CANCEL_JOB')},annotations:destructive},safe(async({projectId,jobId,...input})=>admin().jobCancel(principal,projectId,jobId,input)));
  server.registerTool('superadmin_run_list',{description:'List runs',inputSchema:{projectId,taskId:entityId.optional()},annotations:ro},safe(async({projectId,taskId})=>admin().runList(principal,projectId,taskId)));
  server.registerTool('superadmin_run_get',{description:'Read one run',inputSchema:{projectId,runId:entityId},annotations:ro},safe(async({projectId,runId})=>admin().runGet(principal,projectId,runId)));
  server.registerTool('superadmin_run_delete',{description:'Tombstone a terminal run while preserving evidence',inputSchema:{...deleteInput,projectId,runId:entityId,confirmation:z.literal('DELETE_RUN')},annotations:destructive},safe(async({projectId,runId,...input})=>admin().runDelete(principal,projectId,runId,input)));

  server.registerTool('superadmin_artifact_list',{description:'List every artifact including tombstones',inputSchema:{projectId,taskId:entityId.optional()},annotations:ro},safe(async({projectId,taskId})=>admin().artifactList(principal,projectId,taskId)));
  server.registerTool('superadmin_artifact_get',{description:'Read one artifact, including blob-backed content over the externalization threshold',inputSchema:{projectId,artifactId:entityId},annotations:ro},safe(async({projectId,artifactId})=>admin().artifactRead(principal,projectId,artifactId)));
  server.registerTool('superadmin_artifact_create',{description:'Create only ADMIN_NOTE or CONSOLE_SNAPSHOT artifacts; formal gates cannot be forged',inputSchema:{operationId,projectId,taskId:entityId.optional(),kind:z.enum(['ADMIN_NOTE','CONSOLE_SNAPSHOT']),content:z.unknown()},annotations:mut},safe(async({operationId,projectId,...value})=>admin().artifactCreate(principal,projectId,value,operationId)));
  server.registerTool('superadmin_artifact_update',{description:'Update only administrative artifact content',inputSchema:{operationId,projectId,artifactId:entityId,content:z.unknown()},annotations:mut},safe(async value=>admin().artifactUpdate(principal,value.projectId,value.artifactId,value.content,value.operationId)));
  server.registerTool('superadmin_artifact_delete',{description:'Tombstone an artifact; audit remains immutable',inputSchema:{...deleteInput,projectId,artifactId:entityId,confirmation:z.literal('DELETE_ARTIFACT')},annotations:destructive},safe(async({projectId,artifactId,...input})=>admin().artifactDelete(principal,projectId,artifactId,input)));

  server.registerTool('superadmin_scenario_list',{description:'List validation scenarios',inputSchema:{projectId},annotations:ro},safe(async({projectId})=>admin().scenarioList(principal,projectId)));
  server.registerTool('superadmin_scenario_get',{description:'Read one validation scenario',inputSchema:{projectId,scenarioId:entityId},annotations:ro},safe(async({projectId,scenarioId})=>admin().scenarioGet(principal,projectId,scenarioId)));
  server.registerTool('superadmin_scenario_create',{description:'Create a structured validation scenario bound to a registered HTTP_API resource',inputSchema:{operationId,projectId,...scenarioFields},annotations:mut},safe(async({operationId,projectId,...value})=>admin().scenarioCreate(principal,projectId,{...value,operationId},operationId)));
  server.registerTool('superadmin_scenario_update',{description:'Update a structured validation scenario',inputSchema:{operationId,projectId,scenarioId:entityId,...scenarioFields},annotations:mut},safe(async({operationId,projectId,scenarioId,...value})=>admin().scenarioUpdate(principal,projectId,scenarioId,{...value,operationId},operationId)));
  server.registerTool('superadmin_scenario_delete',{description:'Tombstone a validation scenario',inputSchema:{...deleteInput,projectId,scenarioId:entityId,confirmation:z.literal('DELETE_SCENARIO')},annotations:destructive},safe(async({projectId,scenarioId,...input})=>admin().scenarioDelete(principal,projectId,scenarioId,input)));
  // Executable Postman-style HTTP runner for a saved scenario. Distinct from
  // superadmin_validation_run, which stays a semantic control-state check and is unchanged.
  // Only the persisted scenario ID is accepted: the HTTP_API resource, base URL, steps and
  // credentials are all resolved server-side, so this can never become an arbitrary-URL fetch.
  server.registerTool(scenarioRunToolName,{description:scenarioRunToolDescription,inputSchema:scenarioRunToolInputSchema,annotations:scenarioRunToolAnnotations},safe(async({operationId,projectId,scenarioId})=>admin().scenarioRun(principal,projectId,{scenarioId,operationId})));
  server.registerTool('superadmin_validation_list',{description:'List validation results',inputSchema:{projectId,taskId:entityId.optional()},annotations:ro},safe(async({projectId,taskId})=>admin().validationList(principal,projectId,taskId)));
  server.registerTool('superadmin_validation_get',{description:'Read one validation result',inputSchema:{projectId,validationId:entityId},annotations:ro},safe(async({projectId,validationId})=>admin().validationGet(principal,projectId,validationId)));
  server.registerTool('superadmin_validation_run',{description:'Run semantic control-state validation and persist a report',inputSchema:{operationId,projectId,taskId:entityId,suite:validationSuiteSchema},annotations:mut},safe(async value=>admin().validationRun(principal,value.projectId,value)));
  server.registerTool('superadmin_validation_delete',{description:'Tombstone a validation result',inputSchema:{...deleteInput,projectId,validationId:entityId,confirmation:z.literal('DELETE_VALIDATION')},annotations:destructive},safe(async({projectId,validationId,...input})=>admin().validationDelete(principal,projectId,validationId,input)));

  server.registerTool('superadmin_setting_list',{description:'List system settings',inputSchema:{},annotations:ro},safe(async()=>admin().settingsList(principal)));
  server.registerTool('superadmin_setting_get',{description:'Read one system setting',inputSchema:{key:z.string()},annotations:ro},safe(async({key})=>admin().settingGet(principal,key)));
  server.registerTool('superadmin_setting_upsert',{description:'Create or update a typed setting; production write safety cannot be changed',inputSchema:{operationId,key:z.string(),value:z.unknown(),description:z.string().max(500).default(''),visibility:z.enum(['PUBLIC','OPERATOR','SUPERADMIN'])},annotations:mut},safe(async({operationId,...value})=>admin().settingUpsert(principal,value,operationId)));
  server.registerTool('superadmin_setting_delete',{description:'Delete a non-safety setting',inputSchema:{...deleteInput,key:z.string(),confirmation:z.literal('DELETE_SETTING')},annotations:destructive},safe(async({key,...input})=>admin().settingDelete(principal,key,input)));
  server.registerTool('superadmin_screen_list',{description:'List server-driven Console screen configurations',inputSchema:{},annotations:ro},safe(async()=>admin().screenList(principal)));
  server.registerTool('superadmin_screen_get',{description:'Read one Console screen configuration',inputSchema:{screenId:z.string()},annotations:ro},safe(async({screenId})=>admin().screenGet(principal,screenId)));
  server.registerTool('superadmin_screen_upsert',{description:'Create or update safe Console title, navigation and typed content blocks',inputSchema:{operationId,screenId:z.string(),navigationLabel:z.string(),title:z.string(),description:z.string().default(''),enabled:z.boolean(),navigationOrder:z.number().int(),blocks:z.array(consoleBlockSchema).max(50)},annotations:mut},safe(async({operationId,...value})=>admin().screenUpsert(principal,value,operationId)));
  server.registerTool('superadmin_screen_delete',{description:'Delete a non-core screen configuration',inputSchema:{...deleteInput,screenId:z.string(),confirmation:z.literal('DELETE_SCREEN')},annotations:destructive},safe(async({screenId,...input})=>admin().screenDelete(principal,screenId,input)));

  server.registerTool('superadmin_operator_list',{description:'List operators and global roles',inputSchema:{},annotations:ro},safe(async()=>admin().operatorList(principal)));
  server.registerTool('superadmin_operator_get',{description:'Read one operator',inputSchema:{userId:entityId},annotations:ro},safe(async({userId})=>admin().operatorGet(principal,userId)));
  server.registerTool('superadmin_operator_upsert',{description:'Create or update an OPERATOR or SUPERADMIN record',inputSchema:{operationId,userId:entityId,email:z.string().email(),role:operatorRoleSchema,status:z.enum(['ACTIVE','DISABLED'])},annotations:destructive},safe(async({operationId,...value})=>admin().operatorUpsert(principal,value,operationId)));
  server.registerTool('superadmin_operator_delete',{description:'Delete an operator, never the last active SUPERADMIN',inputSchema:{...deleteInput,userId:entityId,confirmation:z.literal('DELETE_OPERATOR')},annotations:destructive},safe(async({userId,...input})=>admin().operatorDelete(principal,userId,input)));
  server.registerTool('superadmin_membership_list',{description:'List project memberships',inputSchema:{projectId:projectId.optional(),userId:entityId.optional()},annotations:ro},safe(async({projectId,userId})=>admin().membershipList(principal,projectId,userId)));
  server.registerTool('superadmin_membership_get',{description:'Read one membership',inputSchema:{projectId,userId:entityId},annotations:ro},safe(async({projectId,userId})=>admin().membershipGet(principal,userId,projectId)));
  server.registerTool('superadmin_membership_upsert',{description:'Create or update a structured project membership',inputSchema:{operationId,projectId,userId:entityId,role:membershipRoleSchema},annotations:destructive},safe(async({operationId,...value})=>admin().membershipUpsert(principal,value,operationId)));
  server.registerTool('superadmin_membership_delete',{description:'Delete one exact project membership',inputSchema:{...deleteInput,projectId,userId:entityId,confirmation:z.literal('DELETE_MEMBERSHIP')},annotations:destructive},safe(async({projectId,userId,...input})=>admin().membershipDelete(principal,userId,projectId,input)));
  server.registerTool('superadmin_audit_list',{description:'List immutable audit events for any project',inputSchema:{projectId},annotations:ro},safe(async({projectId})=>admin().auditList(principal,projectId)));
  server.registerTool('superadmin_audit_get',{description:'Read one immutable audit event',inputSchema:{projectId,auditId:entityId},annotations:ro},safe(async({projectId,auditId})=>admin().auditGet(principal,projectId,auditId)));

  // Closes the one remaining step of the remote self-repair loop (task_execute already runs
  // fully server-side inside the dispatched GitHub Actions job): opening the pull request for a
  // READY task's autopilot branch. Implemented as a direct GitHub REST call rather than reusing
  // SandboxBootstrapService/LiveGitHubAdapter, because those shell out to the `gh`/`git` CLIs,
  // which Supabase's Deno Edge runtime cannot spawn.
  server.registerTool('superadmin_sandbox_pull_request_open',{description:'Open (or return the existing) pull request for a READY task from its exact autopilot branch; never merges',inputSchema:{operationId,projectId,taskId:entityId,resourceId:entityId,base:z.string().min(1),head:z.string().startsWith('autopilot/'),title:z.string().min(1),body:z.string()},annotations:{...mut,openWorldHint:true}},safe(async value=>admin().executeMutation(principal,'sandbox_pull_request_open',value.projectId,value.operationId,value,()=>openSandboxPullRequest(runtime,value))));

  // Guarded closure of the self-repair loop: merging a READY task's pull request into the
  // registered repository's default branch. This used to be forbidden outright (see git history)
  // so a human always retained that authority; it is now permitted, but only through a narrow,
  // fully server-resolved path -- the caller supplies nothing but projectId/taskId/resourceId.
  // The repository, PR, head branch, and default branch are all determined here, never from
  // caller input. Merge requires the task to already be READY (which itself requires every
  // TEST/SECURITY/REVIEW/CI gate and a FINAL_CHANGE_MANIFEST), the resource to be an ACTIVE,
  // non-production GITHUB_REPOSITORY with both WRITE and ADMIN, and the PR's head SHA to exactly
  // equal both FINAL_CHANGE_MANIFEST.verifiedCommitSha and the latest successful run's commit SHA.
  // The GitHub merge call itself is SHA-pinned (expected-SHA protection), uses the `merge` method
  // so the verified commit becomes a real ancestor of the default branch (not rewritten by
  // squash/rebase), and is followed by an explicit compare-API check that the verified commit is
  // actually reachable from the default branch afterward. Already-merged PRs short-circuit to an
  // idempotent success instead of re-attempting the merge.
  server.registerTool('superadmin_sandbox_pull_request_merge',{description:'Merge a READY task\'s pull request into the registered repository\'s default branch; repository, PR, head and base are resolved entirely server-side and SHA-pinned to the verified FINAL_CHANGE_MANIFEST commit',inputSchema:{operationId,projectId,taskId:entityId,resourceId:entityId},annotations:{...mut,openWorldHint:true}},safe(async value=>admin().executeMutation(principal,'sandbox_pull_request_merge',value.projectId,value.operationId,value,()=>mergeSandboxPullRequest(runtime,value))));

  // Read-only counterpart to task_execute/pull_request_open: without this, a remote caller can
  // only write file changes it can already fully guess or reconstruct -- it never had a way to
  // see what a registered repository's current source actually looks like before proposing a
  // patch, which made real self-repair (fixing a specific existing file correctly, not guessing)
  // impossible through the Superadmin MCP alone. Reads directly from the GitHub REST Contents
  // API (Edge-compatible; no gh/git subprocess), gated by the exact same READ permission already
  // required elsewhere, and cannot escape the registered repository (path is scoped server-side
  // to that resource's externalReference, never an arbitrary URL the caller supplies).
  server.registerTool('superadmin_sandbox_repository_read',{description:'Read a file (returns text content) or list a directory (returns entries) from a registered GitHub repository at an exact ref, defaulting to the repository default branch',inputSchema:{projectId,resourceId:entityId,path:z.string().default(''),ref:z.string().optional()},annotations:ro},safe(async({projectId,resourceId,path,ref})=>{admin();return readSandboxRepository(runtime,{projectId,resourceId,path,ref});}));

  const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined});
  await server.connect(transport);
  const response=await transport.handleRequest(request);
  for(const [key,value] of Object.entries(mcpCorsHeaders(request)))response.headers.set(key,value);
  return response;
});

async function openSandboxPullRequest(runtime:ReturnType<typeof createEdgeRuntime>,input:{projectId:string;taskId:string;resourceId:string;base:string;head:string;title:string;body:string}){
  const task=await runtime.store.getTask(input.projectId,input.taskId);
  if(!task)throw new NotFound('Task not found');
  if(task.state!=='READY')throw new PolicyViolation('Pull request creation requires a task that passed all READY gates');
  const resource=await requireProjectGithubRepository(runtime.store,input.projectId,input.resourceId);
  if(resource.environment==='PRODUCTION')throw new UnsupportedOperation('Production resource mutation is not supported');
  if(!resource.permissions.includes('WRITE'))throw new PolicyViolation('Resource permission denied',{required:'WRITE'});
  const runs=await runtime.store.listRuns(input.projectId,input.taskId);
  const latest=runs.at(-1);
  if(!latest?.branch||latest.branch!==input.head)throw new PolicyViolation('Pull request head must equal the latest task run branch',{expected:latest?.branch,actual:input.head});
  const response=await fetch(`https://api.github.com/repos/${resource.externalReference}/pulls`,{method:'POST',headers:{authorization:`Bearer ${required('AUTOPILOT_GITHUB_DISPATCH_TOKEN')}`,accept:'application/vnd.github+json','content-type':'application/json','user-agent':'backend-autopilot','x-github-api-version':'2022-11-28'},body:JSON.stringify({title:input.title,body:input.body,base:input.base,head:input.head})});
  if(response.status===422){
    const existing=await fetch(`https://api.github.com/repos/${resource.externalReference}/pulls?state=open&base=${encodeURIComponent(input.base)}&head=${encodeURIComponent(`${resource.externalReference.split('/')[0]}:${input.head}`)}`,{headers:{authorization:`Bearer ${required('AUTOPILOT_GITHUB_DISPATCH_TOKEN')}`,accept:'application/vnd.github+json','user-agent':'backend-autopilot'}});
    const matches=existing.ok?await existing.json() as Array<{html_url:string;number:number}>:[];
    if(matches[0]){const pullRequest={url:matches[0].html_url,number:matches[0].number};await recordPullRequestEvidence(runtime,input,{repository:resource.externalReference,base:input.base,head:input.head,pullRequest,merged:false});return {pullRequest,idempotentReplay:true};}
  }
  if(!response.ok)throw new ExecutionFailed('GitHub pull request creation failed',{status:response.status,body:(await response.text()).slice(0,300)});
  const created=await response.json() as {html_url:string;number:number};
  const pullRequest={url:created.html_url,number:created.number};
  await recordPullRequestEvidence(runtime,input,{repository:resource.externalReference,base:input.base,head:input.head,pullRequest,merged:false});
  return {pullRequest,idempotentReplay:false};
}

async function mergeSandboxPullRequest(runtime:ReturnType<typeof createEdgeRuntime>,input:{projectId:string;taskId:string;resourceId:string}){
  const [task,resource]=await Promise.all([runtime.store.getTask(input.projectId,input.taskId),requireProjectGithubRepository(runtime.store,input.projectId,input.resourceId)]);
  const [runs,artifacts]=await Promise.all([runtime.store.listRuns(input.projectId,input.taskId),runtime.store.listArtifacts(input.projectId,input.taskId)]);
  const {branch,commitSha}=resolveMergeableCommit({task,resource,runs,artifacts});
  const repository=resource.externalReference;
  const githubHeaders={authorization:`Bearer ${required('AUTOPILOT_GITHUB_DISPATCH_TOKEN')}`,accept:'application/vnd.github+json','user-agent':'backend-autopilot','x-github-api-version':'2022-11-28'};
  const repoResponse=await fetch(`https://api.github.com/repos/${repository}`,{headers:githubHeaders});
  if(!repoResponse.ok)throw new ExecutionFailed('GitHub repository metadata lookup failed',{status:repoResponse.status,body:(await repoResponse.text()).slice(0,300)});
  const defaultBranch=(await repoResponse.json() as {default_branch:string}).default_branch;
  const owner=repository.split('/')[0];
  const pullsResponse=await fetch(`https://api.github.com/repos/${repository}/pulls?state=all&base=${encodeURIComponent(defaultBranch)}&head=${encodeURIComponent(`${owner}:${branch}`)}&sort=created&direction=desc&per_page=1`,{headers:githubHeaders});
  if(!pullsResponse.ok)throw new ExecutionFailed('GitHub pull request lookup failed',{status:pullsResponse.status,body:(await pullsResponse.text()).slice(0,300)});
  const [pull]=await pullsResponse.json() as Array<{number:number;html_url:string;merged_at:string|null;state:string;head:{sha:string}}>;
  if(!pull)throw new NotFound('No pull request found for the task\'s verified branch',{branch,base:defaultBranch});
  if(pull.head.sha!==commitSha)throw new PolicyViolation('Pull request head SHA no longer matches the verified commit',{expected:commitSha,actual:pull.head.sha});
  if(!pull.merged_at){
    if(pull.state==='closed')throw new PolicyViolation('Pull request was closed without merging; human review required',{number:pull.number});
    const mergeResponse=await fetch(`https://api.github.com/repos/${repository}/pulls/${pull.number}/merge`,{method:'PUT',headers:{...githubHeaders,'content-type':'application/json'},body:JSON.stringify({sha:commitSha,merge_method:'merge'})});
    if(!mergeResponse.ok)throw new ExecutionFailed('GitHub pull request merge failed',{status:mergeResponse.status,body:(await mergeResponse.text()).slice(0,300)});
  }
  const compareResponse=await fetch(`https://api.github.com/repos/${repository}/compare/${encodeURIComponent(defaultBranch)}...${commitSha}`,{headers:githubHeaders});
  if(!compareResponse.ok)throw new ExecutionFailed('Post-merge verification lookup failed',{status:compareResponse.status,body:(await compareResponse.text()).slice(0,300)});
  const compare=await compareResponse.json() as {status:string};
  if(compare.status!=='identical'&&compare.status!=='behind')throw new ExecutionFailed('Verified commit is not present on the default branch after merge',{defaultBranch,commitSha,compareStatus:compare.status});
  const outcome={merged:true,pullRequest:{url:pull.html_url,number:pull.number},defaultBranch,verifiedCommitSha:commitSha,idempotentReplay:Boolean(pull.merged_at)};
  await recordPullRequestEvidence(runtime,input,{repository,base:defaultBranch,head:branch,pullRequest:outcome.pullRequest,merged:true,defaultBranch,verifiedCommitSha:commitSha});
  return outcome;
}

// Durable, per-task record of what reached the repository. The MCP delivery path previously left
// this only in the audit log, which PostgREST caps at 1000 rows per project -- an active project
// outruns that in days and silently drops its OLDEST merges first, so the console could not answer
// "did this epic reach main?" for exactly the work that had been done longest ago. A
// PULL_REQUEST_REPORT artifact is scoped to the task and never rolls off.
async function recordPullRequestEvidence(runtime:ReturnType<typeof createEdgeRuntime>,input:{projectId:string;taskId:string;resourceId:string},value:{repository:string;base:string;head:string;pullRequest:{url:string;number:number};merged:boolean;defaultBranch?:string;verifiedCommitSha?:string}){
  try{
    const artifacts=new ArtifactStore(runtime.store,uuidGenerator,systemClock,runtime.blobs);
    const existing=await runtime.store.listArtifacts(input.projectId,input.taskId);
    // Re-running open/merge for the same pull request must not pile up duplicate evidence.
    const duplicate=existing.some(artifact=>artifact.kind==='PULL_REQUEST_REPORT'&&artifact.status==='AVAILABLE'&&(artifact.content as {pullRequest?:{number?:number};merged?:boolean})?.pullRequest?.number===value.pullRequest.number&&Boolean((artifact.content as {merged?:boolean}).merged)===value.merged);
    if(duplicate)return;
    await artifacts.write(input.projectId,'PULL_REQUEST_REPORT',{provider:'github',resourceId:input.resourceId,...value},input.taskId);
  }catch(error){
    // Evidence is a projection of an action that already succeeded against GitHub. Failing the
    // tool call here would report a merge as failed when it actually landed, which is a far worse
    // lie than a missing artifact; the audit record still carries the outcome either way.
    console.error(JSON.stringify({event:'mcp.pull_request_evidence.failed',taskId:input.taskId,name:error instanceof Error?error.name:'Unknown'}));
  }
}

async function readSandboxRepository(runtime:ReturnType<typeof createEdgeRuntime>,input:{projectId:string;resourceId:string;path:string;ref?:string}){
  const resource=await requireProjectGithubRepository(runtime.store,input.projectId,input.resourceId);
  if(resource.environment==='PRODUCTION')throw new UnsupportedOperation('Production resource access is not supported');
  if(!resource.permissions.includes('READ'))throw new PolicyViolation('Resource permission denied',{required:'READ'});
  const cleanPath=input.path.replace(/^\/+|\/+$/g,'');
  const pathSegment=cleanPath?`/${cleanPath.split('/').map(encodeURIComponent).join('/')}`:'';
  const query=input.ref?`?ref=${encodeURIComponent(input.ref)}`:'';
  const response=await fetch(`https://api.github.com/repos/${resource.externalReference}/contents${pathSegment}${query}`,{headers:{authorization:`Bearer ${required('AUTOPILOT_GITHUB_DISPATCH_TOKEN')}`,accept:'application/vnd.github+json','user-agent':'backend-autopilot','x-github-api-version':'2022-11-28'}});
  if(response.status===404)throw new NotFound('Path not found in repository',{path:input.path});
  if(!response.ok)throw new ExecutionFailed('GitHub repository content read failed',{status:response.status,body:(await response.text()).slice(0,300)});
  const body=await response.json() as {type:string;name:string;path:string;sha?:string;size?:number;content?:string;encoding?:string;download_url?:string}|Array<{name:string;path:string;type:string;size:number}>;
  if(Array.isArray(body))return {type:'directory',path:cleanPath,entries:body.map(entry=>({name:entry.name,path:entry.path,type:entry.type,size:entry.size}))};
  if(body.type!=='file')return {type:body.type,path:body.path,name:body.name};
  let content:string;
  if(body.content&&body.encoding==='base64'){
    content=new TextDecoder().decode(Uint8Array.from(atob(body.content.replace(/\n/g,'')),character=>character.charCodeAt(0)));
  }else if(body.download_url){
    const raw=await fetch(body.download_url,{headers:{authorization:`Bearer ${required('AUTOPILOT_GITHUB_DISPATCH_TOKEN')}`,'user-agent':'backend-autopilot'}});
    if(!raw.ok)throw new ExecutionFailed('GitHub raw content download failed',{status:raw.status});
    content=await raw.text();
  }else{
    throw new ExecutionFailed('GitHub repository content read returned no readable content',{path:body.path});
  }
  return {type:'file',path:body.path,sha:body.sha,size:body.size,content};
}

function protectedResourceMetadata():Response{
  // Supabase's edge runtime rewrites request.url to an internal representation (wrong scheme/host/path),
  // so the public resource identity is derived from the known public project URL, not the incoming request.
  const publicUrl=required('SUPABASE_URL');
  return new Response(JSON.stringify({
    resource:`${publicUrl}/functions/v1/mcp`,
    authorization_servers:[`${publicUrl}/auth/v1`],
    bearer_methods_supported:['header'],
  }),{status:200,headers:{'content-type':'application/json','cache-control':'public, max-age=300'}});
}

function mcpCorsHeaders(request:Request){return {'access-control-allow-origin':request.headers.get('origin')??'*','access-control-allow-headers':'authorization,content-type,accept,apikey,x-client-info,mcp-session-id,mcp-protocol-version,last-event-id','access-control-allow-methods':'POST,DELETE,OPTIONS','access-control-expose-headers':'mcp-session-id','vary':'origin'};}

async function authenticate(request:Request):Promise<Principal|undefined>{
  const supplied=request.headers.get('authorization')?.replace(/^Bearer\s+/i,'')??'';
  if(!supplied)return undefined;
  const superToken=Deno.env.get('AUTOPILOT_SUPERADMIN_MCP_TOKEN');
  if(superToken&&await equalToken(supplied,superToken))return {actor:required('AUTOPILOT_SUPERADMIN_MCP_ACTOR'),role:'SUPERADMIN',projectScoped:false,authMethod:'STATIC_TOKEN'};
  if(await equalToken(supplied,required('AUTOPILOT_MCP_TOKEN')))return {actor:'remote-mcp-project-operator',role:'PROJECT_OPERATOR',projectScoped:true,authMethod:'STATIC_TOKEN'};
  return authenticateOauthSuperadmin(request);
}

async function authenticateOauthSuperadmin(request:Request):Promise<Principal|undefined>{
  try{
    const operator=await authenticatedOperator(request);
    if(operator.role!=='SUPERADMIN')return undefined;
    return {actor:operator.email??operator.id,role:'SUPERADMIN',projectScoped:false,authMethod:'OAUTH'};
  }catch(error){
    if(error instanceof EdgeHttpError)return undefined;
    throw error;
  }
}
async function equalToken(left:string,right:string){const [a,b]=await Promise.all([digest(left),digest(right)]);if(a.length!==b.length)return false;let difference=0;for(let index=0;index<a.length;index++)difference|=a[index]!^b[index]!;return difference===0;}
async function digest(value:string){return new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));}
