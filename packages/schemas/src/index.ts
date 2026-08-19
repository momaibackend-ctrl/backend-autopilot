import { z } from 'zod';

export const PlatformVersions = {
  platform: '0.1.0', workflow: '1', policy: '1', context: '1', artifact: '1'
} as const;

export const autonomyModeSchema = z.enum(['OBSERVE', 'GUARDED', 'AUTONOMOUS_STAGING', 'AUTONOMOUS_PRODUCTION']);
export type AutonomyMode = z.infer<typeof autonomyModeSchema>;
export const environmentSchema = z.enum(['LOCAL', 'SANDBOX', 'STAGING', 'PRODUCTION']);
export type Environment = z.infer<typeof environmentSchema>;

export const projectSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  sourceType: z.string().min(1), environment: environmentSchema, autonomyMode: autonomyModeSchema,
  status: z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED']), workspacePath: z.string().min(1),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime()
});
export type Project = z.infer<typeof projectSchema>;
export const projectCreateSchema = projectSchema.pick({name:true,slug:true,sourceType:true,environment:true,autonomyMode:true,workspacePath:true});
export type ProjectCreate = z.infer<typeof projectCreateSchema>;

export const resourceTypeSchema = z.enum(['GIT_REPOSITORY','GITHUB_REPOSITORY','SUPABASE_PROJECT','DATABASE','TASK_SOURCE','OBJECT_STORAGE']);
export const resourcePermissionSchema = z.enum(['READ','WRITE','ADMIN','MIGRATE']);
export type ResourcePermission = z.infer<typeof resourcePermissionSchema>;
export const secretRefSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,127}$/,'Secret references must be environment/vault-style names, never values');
export const resourceSchema = z.object({
  resourceId: z.string().uuid(), type: resourceTypeSchema, provider: z.string().min(1), externalReference: z.string().min(1),
  projectId: z.string().uuid(), environment: environmentSchema, permissions: z.array(resourcePermissionSchema).min(1),
  status: z.enum(['ACTIVE','DISABLED']), secretRefs: z.array(secretRefSchema).default([]), createdAt: z.string().datetime()
});
export type Resource = z.infer<typeof resourceSchema>;
export const resourceRegisterSchema = resourceSchema.omit({resourceId:true,createdAt:true,status:true}).extend({status: z.enum(['ACTIVE','DISABLED']).default('ACTIVE')});
export type ResourceRegister = z.infer<typeof resourceRegisterSchema>;

export const provenanceSchema = z.object({
  sourceType: z.enum(['TASK_SOURCE','FILE','MCP','USER','REPOSITORY','DECISION']), sourceRef: z.string(),
  importedAt: z.string().datetime(), contentHash: z.string(), trustedAsInstructions: z.literal(false).default(false)
});
export const contextSectionTypeSchema = z.enum(['PRODUCT_VISION','ARCHITECTURE_CANON','DOMAIN_RULES','DATA_OWNERSHIP_RULES','API_CONTRACTS','TASK_GRAPH','EXISTING_IMPLEMENTATION_STATE','KNOWN_DECISIONS','KNOWN_RISKS','OPEN_QUESTIONS']);
export type ContextSectionType = z.infer<typeof contextSectionTypeSchema>;
export const contextSectionSchema = z.object({id:z.string().uuid(),type:contextSectionTypeSchema,content:z.unknown(),provenance:provenanceSchema});
export const projectContextSchema = z.object({id:z.string().uuid(),projectId:z.string().uuid(),version:z.string(),sections:z.array(contextSectionSchema),createdAt:z.string().datetime()});
export type ProjectContext = z.infer<typeof projectContextSchema>;

export const taskStateSchema = z.enum(['INGESTED','ANALYZING','BLOCKED','PLANNED','IMPLEMENTING','TESTING','REVIEWING','READY','FAILED']);
export type TaskState = z.infer<typeof taskStateSchema>;
export const relationshipTypeSchema = z.enum(['DEPENDS_ON','BLOCKS','RELATED_TO','IMPLEMENTS','SUPERSEDES','CONFLICTS_WITH']);
export const taskRelationshipSchema = z.object({type:relationshipTypeSchema,targetTaskId:z.string().uuid()});
export const taskSchema = z.object({
  id:z.string().uuid(),projectId:z.string().uuid(),externalKey:z.string().min(1),title:z.string().min(1),description:z.string(),
  requirements:z.array(z.string()),state:taskStateSchema,relationships:z.array(taskRelationshipSchema),repairAttempts:z.number().int().nonnegative(),
  createdAt:z.string().datetime(),updatedAt:z.string().datetime()
});
export type Task = z.infer<typeof taskSchema>;
export const taskCreateSchema = taskSchema.pick({projectId:true,externalKey:true,title:true,description:true,requirements:true,relationships:true});
export type TaskCreate = z.infer<typeof taskCreateSchema>;

export const implementationPlanSchema = z.object({
  taskId:z.string().uuid(),goal:z.string().min(1),requirements:z.array(z.string()).min(1),affectedDomains:z.array(z.string()),dataOwners:z.array(z.string()),
  filesExpectedToChange:z.array(z.string()),databaseChanges:z.array(z.string()),apiChanges:z.array(z.string()),events:z.array(z.string()),
  securityConsiderations:z.array(z.string()),dependencies:z.array(z.string().uuid()),testsRequired:z.array(z.enum(['UNIT','INTEGRATION','CONTRACT','MIGRATION','SECURITY','REGRESSION'])),
  rollbackStrategy:z.string().min(1),openQuestions:z.array(z.string()),riskLevel:z.enum(['LOW','MEDIUM','HIGH']),approved:z.boolean(),
  createdAt:z.string().datetime()
});
export type ImplementationPlan = z.infer<typeof implementationPlanSchema>;

export const architectureRuleSchema = z.discriminatedUnion('type',[
  z.object({id:z.string(),type:z.literal('FORBID_PATH'),pattern:z.string(),message:z.string()}),
  z.object({id:z.string(),type:z.literal('REQUIRE_TEST'),test:z.enum(['UNIT','INTEGRATION','CONTRACT','MIGRATION','SECURITY','REGRESSION']),message:z.string()}),
  z.object({id:z.string(),type:z.literal('FORBID_DEPENDENCY'),dependency:z.string(),message:z.string()}),
  z.object({id:z.string(),type:z.literal('REQUIRE_SECURITY_CONSIDERATION'),term:z.string(),message:z.string()})
]);
export type ArchitectureRule = z.infer<typeof architectureRuleSchema>;
export const architectureReviewSchema = z.object({passed:z.boolean(),violations:z.array(z.object({ruleId:z.string(),message:z.string()})),policyVersion:z.string()});

export const fileChangeSchema = z.object({path:z.string().min(1),content:z.string(),operation:z.enum(['CREATE','UPDATE']).default('CREATE')});
export type FileChange = z.infer<typeof fileChangeSchema>;
export const executeInputSchema = z.object({projectId:z.string().uuid(),taskId:z.string().uuid(),operationId:z.string().min(8),changes:z.array(fileChangeSchema).min(1)});
export type ExecuteInput = z.infer<typeof executeInputSchema>;

export const commandCategorySchema = z.enum(['READ','BUILD','TEST','MIGRATION','NETWORK','DESTRUCTIVE','UNKNOWN']);
export type CommandCategory = z.infer<typeof commandCategorySchema>;
export const commandRecordSchema = z.object({command:z.array(z.string()),cwd:z.string(),startedAt:z.string().datetime(),finishedAt:z.string().datetime(),exitCode:z.number().int(),stdoutRef:z.string().optional(),stderrRef:z.string().optional(),taskId:z.string().uuid(),category:commandCategorySchema});
export type CommandRecord = z.infer<typeof commandRecordSchema>;

export const testReportSchema = z.object({passed:z.boolean(),suites:z.array(z.object({type:z.string(),command:z.array(z.string()),passed:z.boolean(),exitCode:z.number().int()})),finishedAt:z.string().datetime()});
export type TestReport = z.infer<typeof testReportSchema>;
export const reviewResultSchema = z.enum(['PASS','PASS_WITH_WARNINGS','FAIL']);
export const independentReviewSchema = z.object({result:reviewResultSchema,checks:z.record(z.boolean()),warnings:z.array(z.string()),failures:z.array(z.string()),reviewedAt:z.string().datetime()});
export type IndependentReview = z.infer<typeof independentReviewSchema>;

export const artifactKindSchema = z.enum(['REQUIREMENTS_SNAPSHOT','IMPLEMENTATION_PLAN','ARCHITECTURE_REVIEW','CODE_DIFF','MIGRATION_MANIFEST','API_CONTRACT','TEST_REPORT','SECURITY_REPORT','REVIEW_REPORT','FINAL_CHANGE_MANIFEST','COMMAND_LOG','COMMAND_STDOUT','COMMAND_STDERR']);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;
export const artifactSchema = z.object({id:z.string().uuid(),projectId:z.string().uuid(),taskId:z.string().uuid().optional(),runId:z.string().uuid().optional(),kind:artifactKindSchema,schemaVersion:z.string(),content:z.unknown(),contentHash:z.string(),createdAt:z.string().datetime()});
export type Artifact = z.infer<typeof artifactSchema>;

export const runSchema = z.object({id:z.string().uuid(),projectId:z.string().uuid(),taskId:z.string().uuid(),operationId:z.string(),status:z.enum(['RUNNING','SUCCEEDED','FAILED','BLOCKED']),baseCommit:z.string().optional(),commitSha:z.string().optional(),branch:z.string().optional(),platformVersion:z.string(),workflowVersion:z.string(),policyVersion:z.string(),contextVersion:z.string().optional(),startedAt:z.string().datetime(),finishedAt:z.string().datetime().optional()});
export type Run = z.infer<typeof runSchema>;
export const transitionSchema = z.object({id:z.string().uuid(),taskId:z.string().uuid(),from:taskStateSchema,to:taskStateSchema,reason:z.string(),actor:z.string(),inputArtifactIds:z.array(z.string().uuid()),outputArtifactIds:z.array(z.string().uuid()),timestamp:z.string().datetime()});
export type Transition = z.infer<typeof transitionSchema>;
export const auditEventSchema = z.object({id:z.string().uuid(),actor:z.string(),action:z.string(),projectId:z.string().uuid(),taskId:z.string().uuid().optional(),resourceId:z.string().uuid().optional(),timestamp:z.string().datetime(),input:z.unknown(),result:z.unknown(),reason:z.string(),correlationId:z.string()});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const taskSourceSnapshotSchema = z.object({vision:z.string(),canon:z.array(z.string()),epics:z.array(z.unknown()),tasks:z.array(z.unknown()),attachments:z.array(z.unknown()),relationships:z.array(z.unknown()),comments:z.array(z.unknown()),questions:z.array(z.unknown())});
export type TaskSourceSnapshot = z.infer<typeof taskSourceSnapshotSchema>;
