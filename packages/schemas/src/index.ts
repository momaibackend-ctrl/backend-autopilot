import { z } from "zod";

export const PlatformVersions = {
  platform: "0.5.0",
  workflow: "4",
  policy: "4",
  context: "1",
  artifact: "5",
} as const;

export const autonomyModeSchema = z.enum([
  "OBSERVE",
  "GUARDED",
  "AUTONOMOUS_STAGING",
  "AUTONOMOUS_PRODUCTION",
]);
export type AutonomyMode = z.infer<typeof autonomyModeSchema>;
export const environmentSchema = z.enum([
  "LOCAL",
  "SANDBOX",
  "STAGING",
  "PRODUCTION",
]);
export type Environment = z.infer<typeof environmentSchema>;

export const repositoryIdentitySchema = z.object({
  owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  name: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  defaultBranch: z.string().min(1),
  resourceId: z.string().uuid(),
  metadata: z.record(z.unknown()).optional(),
});
export type RepositoryIdentity = z.infer<typeof repositoryIdentitySchema>;

export const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  sourceType: z.string().min(1),
  environment: environmentSchema,
  autonomyMode: autonomyModeSchema,
  status: z.enum(["ACTIVE", "SUSPENDED", "ARCHIVED"]),
  workspacePath: z.string(),
  repository: repositoryIdentitySchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().optional(),
});
export type Project = z.infer<typeof projectSchema>;
export const projectCreateSchema = projectSchema.pick({
  name: true,
  slug: true,
  sourceType: true,
  environment: true,
  autonomyMode: true,
  repository: true,
}).extend({workspacePath:z.string().optional().default("")});
export type ProjectCreate = z.infer<typeof projectCreateSchema>;

export const resourceTypeSchema = z.enum([
  "GIT_REPOSITORY",
  "GITHUB_ACCOUNT",
  "GITHUB_REPOSITORY",
  "SUPABASE_ORGANIZATION",
  "SUPABASE_PROJECT",
  "DATABASE",
  "HTTP_API",
  "TASK_SOURCE",
  "OBJECT_STORAGE",
]);
export const resourcePermissionSchema = z.enum([
  "READ",
  "WRITE",
  "ADMIN",
  "MIGRATE",
]);
export type ResourcePermission = z.infer<typeof resourcePermissionSchema>;
export const secretRefSchema = z
  .string()
  .regex(
    /^[A-Z][A-Z0-9_]{2,127}$/,
    "Secret references must be environment/vault-style names, never values",
  );
export const resourceSchema = z.object({
  resourceId: z.string().uuid(),
  type: resourceTypeSchema,
  provider: z.string().min(1),
  externalReference: z.string().min(1),
  projectId: z.string().uuid(),
  environment: environmentSchema,
  permissions: z.array(resourcePermissionSchema).min(1),
  status: z.enum(["ACTIVE", "DISABLED", "DELETED"]),
  secretRefs: z.array(secretRefSchema).default([]),
  createdAt: z.string().datetime(),
});
export type Resource = z.infer<typeof resourceSchema>;
export const resourceRegisterSchema = resourceSchema
  .omit({ resourceId: true, createdAt: true, status: true })
  .extend({ status: z.enum(["ACTIVE", "DISABLED"]).default("ACTIVE") });
export type ResourceRegister = z.infer<typeof resourceRegisterSchema>;

export const provenanceSchema = z.object({
  sourceType: z.enum([
    "TASK_SOURCE",
    "FILE",
    "MCP",
    "USER",
    "REPOSITORY",
    "DECISION",
  ]),
  sourceRef: z.string(),
  importedAt: z.string().datetime(),
  contentHash: z.string(),
  trustedAsInstructions: z.literal(false).default(false),
});
export const contextSectionTypeSchema = z.enum([
  "PRODUCT_VISION",
  "ARCHITECTURE_CANON",
  "DOMAIN_RULES",
  "DATA_OWNERSHIP_RULES",
  "API_CONTRACTS",
  "TASK_GRAPH",
  "EXISTING_IMPLEMENTATION_STATE",
  "KNOWN_DECISIONS",
  "KNOWN_RISKS",
  "OPEN_QUESTIONS",
]);
export type ContextSectionType = z.infer<typeof contextSectionTypeSchema>;
export const contextSectionSchema = z.object({
  id: z.string().uuid(),
  type: contextSectionTypeSchema,
  content: z.unknown(),
  provenance: provenanceSchema,
});
export const projectContextSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  version: z.string(),
  sections: z.array(contextSectionSchema),
  createdAt: z.string().datetime(),
  deletedAt: z.string().datetime().optional(),
});
export type ProjectContext = z.infer<typeof projectContextSchema>;

export const taskStateSchema = z.enum([
  "INGESTED",
  "ANALYZING",
  "BLOCKED",
  "PLANNED",
  "IMPLEMENTING",
  "TESTING",
  "REVIEWING",
  "READY",
  "FAILED",
]);
export type TaskState = z.infer<typeof taskStateSchema>;
export const relationshipTypeSchema = z.enum([
  "DEPENDS_ON",
  "BLOCKS",
  "RELATED_TO",
  "IMPLEMENTS",
  "SUPERSEDES",
  "CONFLICTS_WITH",
]);
export const taskRelationshipSchema = z.object({
  type: relationshipTypeSchema,
  targetTaskId: z.string().uuid(),
});
export const taskSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  externalKey: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  requirements: z.array(z.string()),
  state: taskStateSchema,
  relationships: z.array(taskRelationshipSchema),
  repairAttempts: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().optional(),
});
export type Task = z.infer<typeof taskSchema>;
export const taskCreateSchema = taskSchema.pick({
  projectId: true,
  externalKey: true,
  title: true,
  description: true,
  requirements: true,
  relationships: true,
});
export type TaskCreate = z.infer<typeof taskCreateSchema>;

export const implementationPlanSchema = z.object({
  taskId: z.string().uuid(),
  goal: z.string().min(1),
  requirements: z.array(z.string()).min(1),
  affectedDomains: z.array(z.string()),
  dataOwners: z.array(z.string()),
  filesExpectedToChange: z.array(z.string()),
  databaseChanges: z.array(z.string()),
  apiChanges: z.array(z.string()),
  events: z.array(z.string()),
  securityConsiderations: z.array(z.string()),
  dependencies: z.array(z.string().uuid()),
  testsRequired: z.array(
    z.enum([
      "UNIT",
      "INTEGRATION",
      "CONTRACT",
      "MIGRATION",
      "SECURITY",
      "REGRESSION",
    ]),
  ),
  rollbackStrategy: z.string().min(1),
  openQuestions: z.array(z.string()),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]),
  approved: z.boolean(),
  createdAt: z.string().datetime(),
});
export type ImplementationPlan = z.infer<typeof implementationPlanSchema>;

export const architectureRuleSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("FORBID_PATH"),
    pattern: z.string(),
    message: z.string(),
  }),
  z.object({
    id: z.string(),
    type: z.literal("REQUIRE_TEST"),
    test: z.enum([
      "UNIT",
      "INTEGRATION",
      "CONTRACT",
      "MIGRATION",
      "SECURITY",
      "REGRESSION",
    ]),
    message: z.string(),
  }),
  z.object({
    id: z.string(),
    type: z.literal("FORBID_DEPENDENCY"),
    dependency: z.string(),
    message: z.string(),
  }),
  z.object({
    id: z.string(),
    type: z.literal("REQUIRE_SECURITY_CONSIDERATION"),
    term: z.string(),
    message: z.string(),
  }),
]);
export type ArchitectureRule = z.infer<typeof architectureRuleSchema>;
export const architectureReviewSchema = z.object({
  passed: z.boolean(),
  violations: z.array(z.object({ ruleId: z.string(), message: z.string() })),
  policyVersion: z.string(),
});

export const fileChangeSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  operation: z.enum(["CREATE", "UPDATE"]).default("CREATE"),
});
export type FileChange = z.infer<typeof fileChangeSchema>;
export const executeInputSchema = z.object({
  projectId: z.string().uuid(),
  taskId: z.string().uuid(),
  operationId: z.string().min(8),
  changes: z.array(fileChangeSchema).min(1),
});
export type ExecuteInput = z.infer<typeof executeInputSchema>;

export const commandCategorySchema = z.enum([
  "READ",
  "BUILD",
  "TEST",
  "MIGRATION",
  "NETWORK",
  "DESTRUCTIVE",
  "UNKNOWN",
]);
export type CommandCategory = z.infer<typeof commandCategorySchema>;
export const commandRecordSchema = z.object({
  command: z.array(z.string()),
  cwd: z.string(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  exitCode: z.number().int(),
  stdoutRef: z.string().optional(),
  stderrRef: z.string().optional(),
  taskId: z.string().uuid(),
  category: commandCategorySchema,
});
export type CommandRecord = z.infer<typeof commandRecordSchema>;

export const testReportSchema = z.object({
  passed: z.boolean(),
  suites: z.array(
    z.object({
      type: z.string(),
      command: z.array(z.string()),
      passed: z.boolean(),
      exitCode: z.number().int(),
    }),
  ),
  finishedAt: z.string().datetime(),
});
export type TestReport = z.infer<typeof testReportSchema>;
export const reviewResultSchema = z.enum([
  "PASS",
  "PASS_WITH_WARNINGS",
  "FAIL",
]);
export const independentReviewSchema = z.object({
  result: reviewResultSchema,
  checks: z.record(z.boolean()),
  warnings: z.array(z.string()),
  failures: z.array(z.string()),
  reviewedAt: z.string().datetime(),
});
export type IndependentReview = z.infer<typeof independentReviewSchema>;

export const validationSuiteSchema = z.enum([
  "SMOKE",
  "CRUD",
  "AUTHENTICATION",
  "AUTHORIZATION",
  "RLS",
  "REGRESSION",
  "FULL",
]);
export type ValidationSuite = z.infer<typeof validationSuiteSchema>;
export const validationResultSchema = z.enum(["PASS", "FAIL", "PARTIAL"]);
export const validationRunInputSchema = z.object({
  taskId: z.string().uuid(),
  suite: validationSuiteSchema,
  operationId: z.string().min(8),
});
export const apiRequestInputSchema = z.object({
  taskId: z.string().uuid().optional(),
  resourceId: z.string().uuid(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
  path: z.string().startsWith("/"),
  headers: z.record(z.string()).default({}),
  query: z.record(z.string()).default({}),
  body: z.unknown().optional(),
  expectedStatus: z.number().int().min(100).max(599).optional(),
  operationId: z.string().min(8),
});
export type ApiRequestInput = z.infer<typeof apiRequestInputSchema>;
const scenarioVariableNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const responseBodyPathSchema = z
  .string()
  .regex(/^response\.body(?:\.[a-zA-Z0-9_-]+)+$/);
// Additive, always-optional step assertions for the executable HTTP validation runner.
// `expectedStatus` remains the primary assertion; these are evaluated in addition to it.
export const validationAssertionSchema = z.object({
  type: z.enum([
    "HEADER_EQUALS",
    "HEADER_EXISTS",
    "BODY_FIELD_EQUALS",
    "BODY_FIELD_EXISTS",
    "MAX_DURATION_MS",
  ]),
  header: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,64}$/)
    .optional(),
  path: responseBodyPathSchema.optional(),
  value: z.unknown().optional(),
  maxDurationMs: z.number().int().positive().max(600_000).optional(),
});
export type ValidationAssertion = z.infer<typeof validationAssertionSchema>;
export const validationScenarioStepSchema = z.object({
  name: z.string().min(1).max(120),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
  path: z.string().startsWith("/"),
  headers: z.record(z.string()).default({}),
  query: z.record(z.string()).default({}),
  body: z.unknown().optional(),
  expectedStatus: z.number().int().min(100).max(599).optional(),
  extract: z
    .record(
      z.object({
        path: responseBodyPathSchema,
        sensitive: z.boolean().default(false),
      }),
    )
    .default({})
    .refine(
      (value) =>
        Object.keys(value).every(
          (name) => scenarioVariableNameSchema.safeParse(name).success,
        ),
      "Invalid extracted variable name",
    ),
  bearerFrom: scenarioVariableNameSchema.optional(),
  assertions: z.array(validationAssertionSchema).max(20).default([]),
});
export type ValidationScenarioStep = z.infer<typeof validationScenarioStepSchema>;
export const validationScenarioSaveInputSchema = z.object({
  taskId: z.string().uuid().optional(),
  resourceId: z.string().uuid(),
  name: z.string().min(1).max(120),
  description: z.string().max(1_000).default(""),
  steps: z.array(validationScenarioStepSchema).min(1).max(20),
  operationId: z.string().min(8),
});
export const validationScenarioRunInputSchema = z.object({
  scenarioArtifactId: z.string().uuid(),
  operationId: z.string().min(8),
});
export type ValidationScenarioSaveInput = z.infer<
  typeof validationScenarioSaveInputSchema
>;
// Transfer of an already-verified task onto the current base branch after its dependency was
// merged. The caller never supplies a branch, base, commit or manifest: all of it is resolved
// from durable task/run/artifact evidence. `resolutions` carries the agent's semantic conflict
// resolutions for the exact paths a previous attempt reported as conflicted, and nothing else.
export const rebaseConflictResolutionSchema = z.object({
  path: z.string().min(1).max(400),
  content: z.string().max(400_000),
});
export type RebaseConflictResolution = z.infer<
  typeof rebaseConflictResolutionSchema
>;
export const taskRebaseInputSchema = z.object({
  projectId: z.string().uuid(),
  taskId: z.string().uuid(),
  operationId: z.string().min(8),
  resolutions: z.array(rebaseConflictResolutionSchema).max(50).default([]),
});
export type TaskRebaseInput = z.infer<typeof taskRebaseInputSchema>;
export const rebaseStatusSchema = z.enum([
  "REBASED",
  "CONFLICTS_REQUIRE_RESOLUTION",
  "FAILED",
]);
export type RebaseStatus = z.infer<typeof rebaseStatusSchema>;

export const artifactKindSchema = z.enum([
  "REQUIREMENTS_SNAPSHOT",
  "IMPLEMENTATION_PLAN",
  "ARCHITECTURE_REVIEW",
  "CODE_DIFF",
  "MIGRATION_MANIFEST",
  "API_CONTRACT",
  "TEST_REPORT",
  "SECURITY_REPORT",
  "CI_REPORT",
  "REVIEW_REPORT",
  "FINAL_CHANGE_MANIFEST",
  "PULL_REQUEST_REPORT",
  "VALIDATION_REPORT",
  "API_REQUEST_RESULT",
  "VALIDATION_SCENARIO",
  "COMMAND_LOG",
  "COMMAND_STDOUT",
  "COMMAND_STDERR",
  "CAPABILITY_SNAPSHOT",
  "SECRETS_MANIFEST",
  "INFRASTRUCTURE_MANIFEST",
  "BOOTSTRAP_REPORT",
  "ADMIN_NOTE",
  "CONSOLE_SNAPSHOT",
  "WORKSPACE_QUARANTINE",
  "REBASE_REPORT",
]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;
export const artifactSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  kind: artifactKindSchema,
  schemaVersion: z.string(),
  content: z.unknown(),
  contentHash: z.string(),
  status: z.enum(["AVAILABLE", "FAILED", "DELETED"]).default("AVAILABLE"),
  storage: z.object({
    provider: z.string().min(1),
    bucket: z.string().min(1),
    path: z.string().min(1),
    contentType: z.string().min(1),
    size: z.number().int().nonnegative(),
  }).optional(),
  createdAt: z.string().datetime(),
});
export type Artifact = z.infer<typeof artifactSchema>;

export const runSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  taskId: z.string().uuid(),
  operationId: z.string(),
  status: z.enum(["RUNNING", "SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"]),
  baseCommit: z.string().optional(),
  commitSha: z.string().optional(),
  branch: z.string().optional(),
  platformVersion: z.string(),
  workflowVersion: z.string(),
  policyVersion: z.string(),
  contextVersion: z.string().optional(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  deletedAt: z.string().datetime().optional(),
});
export type Run = z.infer<typeof runSchema>;

export const executionJobKindSchema = z.enum([
  "IMPLEMENTATION",
  "TEST",
  "VALIDATION",
  "REPAIR",
  "RECONCILIATION",
  "REBASE",
]);
export const executionJobStatusSchema = z.enum([
  "QUEUED",
  "DISPATCHING",
  "DISPATCHED",
  "CLAIMED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "BLOCKED",
]);
export const executionJobSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  taskId: z.string().uuid(),
  resourceId: z.string().uuid(),
  runId: z.string().uuid().optional(),
  operationId: z.string().min(8),
  kind: executionJobKindSchema,
  status: executionJobStatusSchema,
  payload: z.unknown(),
  workflowRunId: z.string().optional(),
  workflowRunUrl: z.string().url().optional(),
  branch: z.string().optional(),
  baseCommit: z.string().optional(),
  baseBranch: z.string().optional(),
  baseCommitSha: z.string().optional(),
  commitSha: z.string().optional(),
  attempt: z.number().int().nonnegative(),
  leaseOwner: z.string().optional(),
  leaseExpiresAt: z.string().datetime().optional(),
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime(),
  error: z.unknown().optional(),
  result: z.unknown().optional(),
});
export type ExecutionJob = z.infer<typeof executionJobSchema>;
export const transitionSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  from: taskStateSchema,
  to: taskStateSchema,
  reason: z.string(),
  actor: z.string(),
  inputArtifactIds: z.array(z.string().uuid()),
  outputArtifactIds: z.array(z.string().uuid()),
  timestamp: z.string().datetime(),
});
export type Transition = z.infer<typeof transitionSchema>;
export const auditEventSchema = z.object({
  id: z.string().uuid(),
  actor: z.string(),
  action: z.string(),
  projectId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  resourceId: z.string().uuid().optional(),
  timestamp: z.string().datetime(),
  input: z.unknown(),
  result: z.unknown(),
  reason: z.string(),
  correlationId: z.string(),
  authMethod: z.enum(['STATIC_TOKEN', 'OAUTH']).optional(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const taskSourceSnapshotSchema = z.object({
  vision: z.string(),
  canon: z.array(z.string()),
  epics: z.array(z.unknown()),
  tasks: z.array(z.unknown()),
  attachments: z.array(z.unknown()),
  relationships: z.array(z.unknown()),
  comments: z.array(z.unknown()),
  questions: z.array(z.unknown()),
});
export type TaskSourceSnapshot = z.infer<typeof taskSourceSnapshotSchema>;

export const capabilityStatusSchema = z.enum([
  "SUPPORTED",
  "CONFIGURED",
  "LIVE_TESTED",
  "MOCK",
  "NOT_CONFIGURED",
  "NOT_SUPPORTED",
]);
export type CapabilityStatus = z.infer<typeof capabilityStatusSchema>;
export const capabilitySchema = z.object({
  status: capabilityStatusSchema,
  detail: z.string(),
  lastTestedAt: z.string().datetime().optional(),
});
export const runtimeCapabilitiesSchema = z.object({
  capturedAt: z.string().datetime(),
  git: z.object({
    local: capabilitySchema,
    githubAuthentication: capabilitySchema,
    remoteWrite: capabilitySchema,
    ci: capabilitySchema,
  }),
  database: z.object({
    externalPostgres: capabilitySchema,
    migrations: capabilitySchema,
  }),
  supabase: z.object({
    adapter: capabilitySchema,
    authentication: capabilitySchema,
    projectCreation: capabilitySchema,
    rlsManagement: capabilitySchema,
    authManagement: capabilitySchema,
    storageManagement: capabilitySchema,
  }),
  providers: z.object({ neon: capabilitySchema, cloudflare: capabilitySchema }),
});
export type RuntimeCapabilities = z.infer<typeof runtimeCapabilitiesSchema>;
export const credentialManifestEntrySchema = z.object({
  credentialName: secretRefSchema,
  provider: z.string(),
  purpose: z.string(),
  projectId: z.string().uuid(),
  scope: z.string(),
  createdAt: z.string().datetime(),
  whereStored: z.string(),
  rotationMethod: z.string(),
  revocationMethod: z.string(),
  status: z.enum(["ACTIVE", "ROTATED", "REVOKED"]),
});
export type CredentialManifestEntry = z.infer<
  typeof credentialManifestEntrySchema
>;
export const infrastructureManifestEntrySchema = z.object({
  provider: z.string(),
  account: z.string(),
  organization: z.string().optional(),
  resourceType: resourceTypeSchema,
  externalId: z.string(),
  projectId: z.string().uuid(),
  environment: environmentSchema,
  urls: z.array(z.string()),
  createdAt: z.string().datetime(),
  purpose: z.string(),
  deletionProcedure: z.string(),
  status: z.enum(["ACTIVE", "DELETED", "FAILED"]),
});
export type InfrastructureManifestEntry = z.infer<
  typeof infrastructureManifestEntrySchema
>;
export const destructiveAuthorizationSchema = z.object({
  operationId: z.string().min(8),
  confirmation: z.enum([
    "DELETE_SANDBOX_REPOSITORY",
    "DELETE_SANDBOX_DATABASE",
    "RESET_SANDBOX_DATABASE",
    "ROTATE_CREDENTIAL",
    "REVOKE_CREDENTIAL",
  ]),
  resourceId: z.string().uuid(),
});
export type DestructiveAuthorization = z.infer<
  typeof destructiveAuthorizationSchema
>;

export const principalRoleSchema = z.enum(["PROJECT_OPERATOR", "SUPERADMIN"]);
export type PrincipalRole = z.infer<typeof principalRoleSchema>;
export const operatorRoleSchema = z.enum(["OPERATOR", "SUPERADMIN"]);
export const membershipRoleSchema = z.enum(["VIEWER", "OPERATOR", "ADMIN"]);
export const operatorSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
  role: operatorRoleSchema,
  status: z.enum(["ACTIVE", "DISABLED"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Operator = z.infer<typeof operatorSchema>;
export const projectMembershipSchema = z.object({
  userId: z.string().uuid(),
  projectId: z.string().uuid(),
  role: membershipRoleSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProjectMembership = z.infer<typeof projectMembershipSchema>;

export const systemSettingSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_.-]{2,127}$/),
  value: z.unknown(),
  description: z.string().max(500).default(""),
  visibility: z.enum(["PUBLIC", "OPERATOR", "SUPERADMIN"]),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().min(1),
});
export type SystemSetting = z.infer<typeof systemSettingSchema>;

export const consoleBlockSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    type: z.literal("TEXT"),
    title: z.string().max(120),
    content: z.string().max(10_000),
  }),
  z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    type: z.literal("METRIC"),
    title: z.string().max(120),
    value: z.union([z.string().max(500), z.number(), z.boolean()]),
    note: z.string().max(500).default(""),
  }),
  z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    type: z.literal("JSON"),
    title: z.string().max(120),
    value: z.unknown(),
  }),
]);
export const consoleScreenSchema = z.object({
  screenId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  navigationLabel: z.string().min(1).max(80),
  title: z.string().min(1).max(120),
  description: z.string().max(500).default(""),
  enabled: z.boolean(),
  navigationOrder: z.number().int().min(0).max(10_000),
  blocks: z.array(consoleBlockSchema).max(50),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().min(1),
});
export type ConsoleScreen = z.infer<typeof consoleScreenSchema>;

export const adminOperationSchema = z.object({
  operationId: z.string().min(8).max(200),
  actor: z.string().min(1),
  tool: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/),
  projectId: z.string().uuid().optional(),
  result: z.unknown(),
  createdAt: z.string().datetime(),
});
export type AdminOperation = z.infer<typeof adminOperationSchema>;
export const migrationMarkerSchema = z.object({
  key: z.string(),
  checksum: z.string(),
  data: z.unknown(),
  createdAt: z.string().datetime(),
});
export type MigrationMarker = z.infer<typeof migrationMarkerSchema>;

export const projectUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED", "ARCHIVED"]).optional(),
  autonomyMode: autonomyModeSchema.optional(),
  sourceType: z.string().min(1).optional(),
  repository: repositoryIdentitySchema.optional(),
}).strict();
export const taskUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  requirements: z.array(z.string()).optional(),
  relationships: z.array(taskRelationshipSchema).optional(),
}).strict();
export const resourceUpdateSchema = z.object({
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  permissions: z.array(resourcePermissionSchema).min(1).optional(),
  secretRefs: z.array(secretRefSchema).optional(),
}).strict();
export const consoleScreenUpsertSchema = consoleScreenSchema.omit({
  updatedAt: true,
  updatedBy: true,
});
export const systemSettingUpsertSchema = systemSettingSchema.omit({
  updatedAt: true,
  updatedBy: true,
});
export const confirmedDeleteSchema = z.object({
  operationId: z.string().min(8),
  confirmation: z.enum([
    "ARCHIVE_PROJECT",
    "DELETE_TASK",
    "DELETE_RESOURCE",
    "DELETE_CONTEXT",
    "DELETE_ARTIFACT",
    "DELETE_RUN",
    "CANCEL_JOB",
    "DELETE_SCENARIO",
    "DELETE_VALIDATION",
    "DELETE_SETTING",
    "DELETE_SCREEN",
    "DELETE_MEMBERSHIP",
    "DELETE_OPERATOR",
  ]),
  reason: z.string().min(8).max(500),
});
