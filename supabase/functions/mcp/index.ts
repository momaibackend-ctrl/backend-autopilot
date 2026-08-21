import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { McpServer } from 'npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from 'npm:@modelcontextprotocol/sdk@1.25.3/server/webStandardStreamableHttp.js';
import { z } from 'npm:zod@3.25.76';
import { DomainError, ExecutionFailed, NotFound, PolicyViolation, UnsupportedOperation } from '../../../packages/core/src/errors.ts';
import { autonomyModeSchema, consoleBlockSchema, contextSectionTypeSchema, environmentSchema, fileChangeSchema, membershipRoleSchema, operatorRoleSchema, relationshipTypeSchema, resourcePermissionSchema, resourceTypeSchema, taskStateSchema, validationScenarioStepSchema, validationSuiteSchema } from '../../../packages/schemas/src/index.ts';
import type { SuperadminPrincipal } from '../../../packages/superadmin/src/index.ts';
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
  const principal=await authenticate(request);
  if(!principal)return new Response(JSON.stringify({error:'unauthorized'}),{status:401,headers:{'content-type':'application/json','www-authenticate':`Bearer resource_metadata="${required('SUPABASE_URL')}/functions/v1/mcp/.well-known/oauth-protected-resource"`}});
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
  server.registerTool('task_status',{description:'Read lifecycle, jobs, runs and artifacts',inputSchema:{projectId,taskId:entityId},annotations:ro},safe(async({projectId,taskId})=>{scoped(projectId);return {...await runtime.service.taskStatus(projectId,taskId),jobs:await runtime.asyncExecution.list(projectId,taskId)};}));
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
  server.registerTool('superadmin_project_update',{description:'Update safe project metadata or autonomy mode',inputSchema:{operationId,projectId,name:z.string().min(1).optional(),status:z.enum(['ACTIVE','SUSPENDED','ARCHIVED']).optional(),autonomyMode:autonomyModeSchema.optional(),sourceType:z.string().min(1).optional()},annotations:mut},safe(async({operationId,projectId,...patch})=>admin().projectUpdate(principal,projectId,patch,operationId)));
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
  server.registerTool('superadmin_task_analyze',{description:'Run dependency analysis and requirements snapshot',inputSchema:{operationId,projectId,taskId:entityId},annotations:mut},safe(async value=>admin().executeMutation(principal,'task_analyze',value.projectId,value.operationId,value,()=>runtime.service.taskAnalyze(value.projectId,value.taskId,principal.actor,value.operationId))));
  server.registerTool('superadmin_task_plan',{description:'Create and ArchitectureGuard-check the implementation plan',inputSchema:{operationId,projectId,taskId:entityId},annotations:mut},safe(async value=>admin().executeMutation(principal,'task_plan',value.projectId,value.operationId,value,()=>runtime.service.taskPlan(value.projectId,value.taskId,principal.actor,value.operationId))));
  server.registerTool('superadmin_task_execute',{description:'Queue a fixed GitHub Actions execution using only a registered resource ID and semantic file changes',inputSchema:{operationId,projectId,taskId:entityId,resourceId:entityId,changes:z.array(fileChangeSchema).min(1)},annotations:{...mut,openWorldHint:true}},safe(async value=>admin().executeMutation(principal,'task_execute',value.projectId,value.operationId,{...value,changes:value.changes.map(change=>({path:change.path,operation:change.operation}))},()=>runtime.asyncExecution.enqueueImplementation(value,value.resourceId,principal.actor))));
  server.registerTool('superadmin_task_retry',{description:'Retry a BLOCKED or FAILED task within bounded repair policy',inputSchema:{operationId,projectId,taskId:entityId},annotations:mut},safe(async value=>admin().executeMutation(principal,'task_retry',value.projectId,value.operationId,value,()=>runtime.service.taskRetry(value.projectId,value.taskId,principal.actor))));
  server.registerTool('superadmin_task_review',{description:'Run independent review; READY still requires every formal artifact gate',inputSchema:{operationId,projectId,taskId:entityId},annotations:mut},safe(async value=>admin().executeMutation(principal,'task_review',value.projectId,value.operationId,value,()=>runtime.service.taskReview(value.projectId,value.taskId,principal.actor,value.operationId))));
  server.registerTool('superadmin_task_delete',{description:'Tombstone an unexecuted non-ready task',inputSchema:{...deleteInput,projectId,taskId:entityId,confirmation:z.literal('DELETE_TASK')},annotations:destructive},safe(async({projectId,taskId,...input})=>admin().taskDelete(principal,projectId,taskId,input)));

  server.registerTool('superadmin_job_list',{description:'List execution jobs',inputSchema:{projectId,taskId:entityId.optional()},annotations:ro},safe(async({projectId,taskId})=>admin().jobList(principal,projectId,taskId)));
  server.registerTool('superadmin_job_get',{description:'Read one execution job',inputSchema:{projectId,jobId:entityId},annotations:ro},safe(async({projectId,jobId})=>admin().jobGet(principal,projectId,jobId)));
  server.registerTool('superadmin_job_create',{description:'Create and dispatch a task execution job from structured file changes',inputSchema:{operationId,projectId,taskId:entityId,resourceId:entityId,changes:z.array(fileChangeSchema).min(1)},annotations:{...mut,openWorldHint:true}},safe(async value=>admin().jobCreate(principal,value,value.resourceId,value.operationId)));
  server.registerTool('superadmin_job_cancel',{description:'Cancel a non-terminal job with a structured reason',inputSchema:{...deleteInput,projectId,jobId:entityId,confirmation:z.literal('CANCEL_JOB')},annotations:destructive},safe(async({projectId,jobId,...input})=>admin().jobCancel(principal,projectId,jobId,input)));
  server.registerTool('superadmin_run_list',{description:'List runs',inputSchema:{projectId,taskId:entityId.optional()},annotations:ro},safe(async({projectId,taskId})=>admin().runList(principal,projectId,taskId)));
  server.registerTool('superadmin_run_get',{description:'Read one run',inputSchema:{projectId,runId:entityId},annotations:ro},safe(async({projectId,runId})=>admin().runGet(principal,projectId,runId)));
  server.registerTool('superadmin_run_delete',{description:'Tombstone a terminal run while preserving evidence',inputSchema:{...deleteInput,projectId,runId:entityId,confirmation:z.literal('DELETE_RUN')},annotations:destructive},safe(async({projectId,runId,...input})=>admin().runDelete(principal,projectId,runId,input)));

  server.registerTool('superadmin_artifact_list',{description:'List every artifact including tombstones',inputSchema:{projectId,taskId:entityId.optional()},annotations:ro},safe(async({projectId,taskId})=>admin().artifactList(principal,projectId,taskId)));
  server.registerTool('superadmin_artifact_get',{description:'Read one artifact',inputSchema:{projectId,artifactId:entityId},annotations:ro},safe(async({projectId,artifactId})=>admin().artifactGet(principal,projectId,artifactId)));
  server.registerTool('superadmin_artifact_create',{description:'Create only ADMIN_NOTE or CONSOLE_SNAPSHOT artifacts; formal gates cannot be forged',inputSchema:{operationId,projectId,taskId:entityId.optional(),kind:z.enum(['ADMIN_NOTE','CONSOLE_SNAPSHOT']),content:z.unknown()},annotations:mut},safe(async({operationId,projectId,...value})=>admin().artifactCreate(principal,projectId,value,operationId)));
  server.registerTool('superadmin_artifact_update',{description:'Update only administrative artifact content',inputSchema:{operationId,projectId,artifactId:entityId,content:z.unknown()},annotations:mut},safe(async value=>admin().artifactUpdate(principal,value.projectId,value.artifactId,value.content,value.operationId)));
  server.registerTool('superadmin_artifact_delete',{description:'Tombstone an artifact; audit remains immutable',inputSchema:{...deleteInput,projectId,artifactId:entityId,confirmation:z.literal('DELETE_ARTIFACT')},annotations:destructive},safe(async({projectId,artifactId,...input})=>admin().artifactDelete(principal,projectId,artifactId,input)));

  server.registerTool('superadmin_scenario_list',{description:'List validation scenarios',inputSchema:{projectId},annotations:ro},safe(async({projectId})=>admin().scenarioList(principal,projectId)));
  server.registerTool('superadmin_scenario_get',{description:'Read one validation scenario',inputSchema:{projectId,scenarioId:entityId},annotations:ro},safe(async({projectId,scenarioId})=>admin().scenarioGet(principal,projectId,scenarioId)));
  server.registerTool('superadmin_scenario_create',{description:'Create a structured validation scenario bound to a registered HTTP_API resource',inputSchema:{operationId,projectId,...scenarioFields},annotations:mut},safe(async({operationId,projectId,...value})=>admin().scenarioCreate(principal,projectId,{...value,operationId},operationId)));
  server.registerTool('superadmin_scenario_update',{description:'Update a structured validation scenario',inputSchema:{operationId,projectId,scenarioId:entityId,...scenarioFields},annotations:mut},safe(async({operationId,projectId,scenarioId,...value})=>admin().scenarioUpdate(principal,projectId,scenarioId,{...value,operationId},operationId)));
  server.registerTool('superadmin_scenario_delete',{description:'Tombstone a validation scenario',inputSchema:{...deleteInput,projectId,scenarioId:entityId,confirmation:z.literal('DELETE_SCENARIO')},annotations:destructive},safe(async({projectId,scenarioId,...input})=>admin().scenarioDelete(principal,projectId,scenarioId,input)));
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
  // which Supabase's Deno Edge runtime cannot spawn. No tool ever merges a pull request -- a
  // human (or branch protection) retains that authority, so self-repair can reach a proposed fix
  // but never apply it to the protected branch unattended.
  server.registerTool('superadmin_sandbox_pull_request_open',{description:'Open (or return the existing) pull request for a READY task from its exact autopilot branch; never merges',inputSchema:{operationId,projectId,taskId:entityId,resourceId:entityId,base:z.string().min(1),head:z.string().startsWith('autopilot/'),title:z.string().min(1),body:z.string()},annotations:{...mut,openWorldHint:true}},safe(async value=>admin().executeMutation(principal,'sandbox_pull_request_open',value.projectId,value.operationId,value,()=>openSandboxPullRequest(runtime,value))));

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
  return transport.handleRequest(request);
});

async function openSandboxPullRequest(runtime:ReturnType<typeof createEdgeRuntime>,input:{projectId:string;taskId:string;resourceId:string;base:string;head:string;title:string;body:string}){
  const task=await runtime.store.getTask(input.projectId,input.taskId);
  if(!task)throw new NotFound('Task not found');
  if(task.state!=='READY')throw new PolicyViolation('Pull request creation requires a task that passed all READY gates');
  const resource=await runtime.store.getResource(input.resourceId);
  if(!resource||resource.projectId!==input.projectId)throw new NotFound('Resource not found');
  if(resource.type!=='GITHUB_REPOSITORY'||resource.provider!=='github'||resource.status!=='ACTIVE')throw new PolicyViolation('An active registered GitHub repository is required for pull request creation');
  if(resource.environment==='PRODUCTION')throw new UnsupportedOperation('Production resource mutation is not supported');
  if(!resource.permissions.includes('WRITE'))throw new PolicyViolation('Resource permission denied',{required:'WRITE'});
  const runs=await runtime.store.listRuns(input.projectId,input.taskId);
  const latest=runs.at(-1);
  if(!latest?.branch||latest.branch!==input.head)throw new PolicyViolation('Pull request head must equal the latest task run branch',{expected:latest?.branch,actual:input.head});
  const response=await fetch(`https://api.github.com/repos/${resource.externalReference}/pulls`,{method:'POST',headers:{authorization:`Bearer ${required('AUTOPILOT_GITHUB_DISPATCH_TOKEN')}`,accept:'application/vnd.github+json','content-type':'application/json','user-agent':'backend-autopilot','x-github-api-version':'2022-11-28'},body:JSON.stringify({title:input.title,body:input.body,base:input.base,head:input.head})});
  if(response.status===422){
    const existing=await fetch(`https://api.github.com/repos/${resource.externalReference}/pulls?state=open&base=${encodeURIComponent(input.base)}&head=${encodeURIComponent(`${resource.externalReference.split('/')[0]}:${input.head}`)}`,{headers:{authorization:`Bearer ${required('AUTOPILOT_GITHUB_DISPATCH_TOKEN')}`,accept:'application/vnd.github+json','user-agent':'backend-autopilot'}});
    const matches=existing.ok?await existing.json() as Array<{html_url:string;number:number}>:[];
    if(matches[0])return {pullRequest:{url:matches[0].html_url,number:matches[0].number},idempotentReplay:true};
  }
  if(!response.ok)throw new ExecutionFailed('GitHub pull request creation failed',{status:response.status,body:(await response.text()).slice(0,300)});
  const created=await response.json() as {html_url:string;number:number};
  return {pullRequest:{url:created.html_url,number:created.number},idempotentReplay:false};
}

async function readSandboxRepository(runtime:ReturnType<typeof createEdgeRuntime>,input:{projectId:string;resourceId:string;path:string;ref?:string}){
  const resource=await runtime.store.getResource(input.resourceId);
  if(!resource||resource.projectId!==input.projectId)throw new NotFound('Resource not found');
  if(resource.type!=='GITHUB_REPOSITORY'||resource.provider!=='github'||resource.status!=='ACTIVE')throw new PolicyViolation('An active registered GitHub repository is required');
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
