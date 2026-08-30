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

// Which verification layers a task actually needs, decided before implementation rather than
// discovered after 21 tasks were already merged. Every layer carries an explicit status: a layer
// that does not apply must say so and say why, so a silent gap and a justified absence stop
// looking identical in the evidence chain.
export const verificationLayerSchema = z.enum([
  "UNIT",
  "INTEGRATION",
  "PROPERTY",
  "CONTRACT",
  "MIGRATION",
  "SECURITY",
  "REGRESSION",
  "HTTP_CONTRACT",
  "MIGRATION_MANIFEST",
]);
export type VerificationLayer = z.infer<typeof verificationLayerSchema>;
export const verificationStatusSchema = z.enum(["REQUIRED", "NOT_APPLICABLE"]);
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;
export const verificationDecisionSchema = z.object({
  layer: verificationLayerSchema,
  status: verificationStatusSchema,
  /** Why this layer is required, or why it demonstrably does not apply. Never empty. */
  reasons: z.array(z.string().min(1)).min(1),
});
export type VerificationDecision = z.infer<typeof verificationDecisionSchema>;
export const verificationProfileSchema = z.object({
  profileVersion: z.string().min(1),
  decisions: z.array(verificationDecisionSchema).min(1),
});
export type VerificationProfile = z.infer<typeof verificationProfileSchema>;

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
      "PROPERTY",
      "CONTRACT",
      "MIGRATION",
      "SECURITY",
      "REGRESSION",
    ]),
  ),
  // Optional so plans persisted before verification profiles existed still parse; every plan the
  // current planner writes carries one.
  verification: verificationProfileSchema.optional(),
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
      "PROPERTY",
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

export const fileChangeSchema = z
  .object({
    path: z.string().min(1),
    // Not required for DELETE, where there is no content to write.
    content: z.string().optional(),
    // DELETE exists because relocating code is how an architecture violation actually gets fixed.
    // Without it an agent could only ever add or overwrite, so a class living in the wrong package
    // could never be moved out of it -- it would have to be left behind, still violating.
    operation: z.enum(["CREATE", "UPDATE", "DELETE"]).default("CREATE"),
  })
  .refine((value) => value.operation === "DELETE" || value.content !== undefined, {
    message: "content is required unless operation is DELETE",
    path: ["content"],
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

// Evidence that generative tests actually ran, not merely that a build succeeded. A green exit
// code proves nothing about whether any property was ever generated, so the gate reads counts and
// seeds parsed out of the real runner output instead of trusting the suite's status.
export const propertyBasedReportSchema = z.object({
  required: z.boolean(),
  framework: z.enum(["jqwik", "fast-check", "UNKNOWN"]),
  status: z.enum(["PASS", "FAIL", "UNVERIFIED", "NOT_APPLICABLE"]),
  /** How the numbers below were obtained; never inferred from a suite exit code alone. */
  evidence: z.enum(["PARSED_RUNNER_OUTPUT", "REPORT_FILE", "NONE"]),
  properties: z.number().int().nonnegative(),
  generatedCases: z.number().int().nonnegative(),
  shrinking: z.enum(["ENABLED", "DISABLED", "UNKNOWN"]),
  replaySeeds: z.array(z.string()),
  counterexamples: z.number().int().nonnegative(),
  reasons: z.array(z.string()),
});
export type PropertyBasedReport = z.infer<typeof propertyBasedReportSchema>;

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
  /** Present whenever the plan's verification profile required a generative layer. */
  propertyBased: propertyBasedReportSchema.optional(),
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

// An epic is judged at one commit, not as the union of its members' past verdicts. Each dimension
// resolves to PASS, NOT_APPLICABLE with a reason, or BLOCKED with a remediation -- there is no
// state in which a dimension is quietly absent.
export const epicDimensionSchema = z.enum([
  "CONTRACTS",
  "CONSUMERS",
  "INVARIANTS",
  "INTEGRATION_DEPENDENCIES",
  "SECURITY_PRIVACY",
  "MIGRATIONS",
  "JOURNEYS",
]);
export type EpicDimension = z.infer<typeof epicDimensionSchema>;

// Where a verdict came from. Classified by the server from the recording actor, never accepted
// from the caller: a free-text "source" that anyone can set to "github" is a label, not a
// provenance. Manual evidence stays permitted -- it just cannot masquerade as a CI run.
export const evidenceSourceTypeSchema = z.enum(["TRUSTED_CI", "OPERATOR", "HISTORICAL", "UNKNOWN"]);
export type EvidenceSourceType = z.infer<typeof evidenceSourceTypeSchema>;

export const epicEvidenceProvenanceSchema = z.object({
  sourceType: evidenceSourceTypeSchema,
  /** The repository the check ran against, so evidence cannot drift between targets. */
  repository: z.string().min(1),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  workflowRunId: z.string().optional(),
  workflowRunUrl: z.string().optional(),
  /** The service principal or operator identity that recorded it. */
  actor: z.string().min(1),
  /** Digest of the run output the verdict was read from, when the runner captured one. */
  artifactHash: z.string().optional(),
  runnerVersion: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type EpicEvidenceProvenance = z.infer<typeof epicEvidenceProvenanceSchema>;

export const epicEvidenceRefSchema = z.object({
  artifactId: z.string(),
  provenance: epicEvidenceProvenanceSchema,
  detail: z.string().optional(),
});
export type EpicEvidenceRef = z.infer<typeof epicEvidenceRefSchema>;

export const epicDimensionResultSchema = z.object({
  dimension: epicDimensionSchema,
  requirement: z.enum(["REQUIRED", "NOT_APPLICABLE"]),
  status: z.enum(["PASS", "BLOCKED", "NOT_APPLICABLE"]),
  reasons: z.array(z.string().min(1)).min(1),
  remediation: z.string().optional(),
  /** The checks that actually ran at the epic head SHA, each with where it came from. */
  evidence: z.array(epicEvidenceRefSchema),
});
export type EpicDimensionResult = z.infer<typeof epicDimensionResultSchema>;

export const epicMemberViewSchema = z.object({
  taskId: z.string(),
  externalKey: z.string(),
  state: z.string(),
  /** The commit this member's own evidence was verified at, from its final manifest. */
  verifiedCommitSha: z.string().optional(),
  settled: z.boolean(),
  planned: z.boolean(),
  /** False whenever the member was verified at an earlier commit than the epic head. */
  evidenceIsAtHead: z.boolean(),
  /**
   * The member that replaced this one, resolved from an explicit SUPERSEDES relationship. Set only
   * on historical members: they keep their true state and are excluded from the readiness verdict.
   */
  supersededBy: z.string().optional(),
  /** Whether this member's verified commit is actually reachable from the epic head. */
  verifiedCommitContainedInHead: z.boolean().optional(),
});
export type EpicMemberView = z.infer<typeof epicMemberViewSchema>;

// One dimension's result from a run that actually happened, recorded against the exact commit it
// ran on. Keeping this separate from the report keeps the gate a pure function: whatever performs
// the aggregate run -- a workflow, or an operator recording a verified external run -- records
// evidence, and the report is derived. `source` is mandatory so a verdict is always attributable.
export const epicDimensionEvidenceSchema = z.object({
  epicKey: z.string().min(1),
  dimension: epicDimensionSchema,
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  passed: z.boolean(),
  detail: z.string().optional(),
  provenance: epicEvidenceProvenanceSchema,
});
export type EpicDimensionEvidence = z.infer<typeof epicDimensionEvidenceSchema>;

export const epicVerificationReportSchema = z.object({
  epicKey: z.string().min(1),
  /** The repository the epic is released from, taken from the evidence that ran against it. */
  repository: z.string().optional(),
  headSha: z.string().min(1),
  result: z.enum(["PASS", "BLOCKED"]),
  /** Whether the passing evidence came from CI, from an operator's assertion, or from both. */
  trust: z.enum(["CI_VERIFIED", "OPERATOR_ASSERTED", "MIXED", "NONE"]),
  members: z.array(epicMemberViewSchema),
  dimensions: z.array(epicDimensionResultSchema),
  /** Evidence recorded for this epic at some OTHER commit; listed so it is visible, never counted. */
  staleEvidence: z.array(epicEvidenceRefSchema.extend({ dimension: epicDimensionSchema, commitSha: z.string() })),
  /** Required dimensions with no passing evidence at the head commit. */
  missingDimensions: z.array(epicDimensionSchema),
  /** Members that actually compose the released system, after supersession is resolved. */
  effectiveMembers: z.number().int().nonnegative(),
  /** Historical members and what replaced them; recorded, never counted. */
  supersededMembers: z.array(z.object({ externalKey: z.string(), state: z.string(), supersededBy: z.string() })),
  blockers: z.array(z.object({ code: z.string(), reason: z.string(), remediation: z.string() })),
  generatedAt: z.string().datetime(),
});
export type EpicVerificationReport = z.infer<typeof epicVerificationReportSchema>;

export const epicEvidenceRecordInputSchema = z.object({
  projectId: z.string().uuid(),
  operationId: z.string().min(8),
  epicKey: z.string().min(1),
  dimension: epicDimensionSchema,
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  passed: z.boolean(),
  repository: z.string().min(1),
  detail: z.string().optional(),
  // Provenance facts only. `sourceType` is deliberately absent: the server classifies it from the
  // recording actor, so a caller cannot declare its own verdict trusted.
  workflowRunId: z.string().optional(),
  workflowRunUrl: z.string().optional(),
  artifactHash: z.string().optional(),
  runnerVersion: z.string().optional(),
});
export type EpicEvidenceRecordInput = z.infer<typeof epicEvidenceRecordInputSchema>;

export const epicVerifyInputSchema = z
  .object({
    projectId: z.string().uuid(),
    epicKey: z.string().min(1),
    // Required on purpose. An epic is judged at one named commit; resolving "whatever main is right
    // now" would let the subject of the verdict move underneath the run.
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    repository: z.string().min(1).optional(),
    /**
     * taskId -> whether that member's verified commit is reachable from headSha. Supplied by a
     * caller that has a checkout; an absent entry means nobody checked, which does not block.
     */
    containment: z.record(z.boolean()).optional(),
    taskIds: z.array(z.string().uuid()).optional(),
    externalKeyPrefix: z.string().min(1).optional(),
    /** Persist the report as an artifact. Omitted or false makes this a read-only preflight. */
    persist: z.boolean().optional(),
    operationId: z.string().min(8).optional(),
  })
  .refine((value) => Boolean(value.taskIds?.length) || Boolean(value.externalKeyPrefix), {
    message: "Either taskIds or externalKeyPrefix must select the epic's members",
  });
export type EpicVerifyInput = z.infer<typeof epicVerifyInputSchema>;

// ---------------------------------------------------------------------------
// Canonical Development Repository
//
// A ROLE a registered repository plays for a project -- "this is the one source of further
// development" -- not a name, a host, or a claim about production. It references a registered
// GITHUB_REPOSITORY resource rather than carrying its own owner/name, so there stays exactly one
// repository registry: the resource answers "what may Autopilot touch at all", this answers
// "which of those is this project's development target". Bindings are append-only and versioned;
// a replaced binding becomes SUPERSEDED and is never deleted, so which repository was canonical
// when stays readable alongside the runs and artifacts produced against it.
// ---------------------------------------------------------------------------
export const canonicalRepositoryStatusSchema = z.enum([
  "CANDIDATE",
  "ACTIVE",
  "SUPERSEDED",
  "ROLLED_BACK",
]);
export type CanonicalRepositoryStatus = z.infer<typeof canonicalRepositoryStatusSchema>;
export const canonicalRepositoryIdentitySchema = z.object({
  provider: z.string().min(1),
  owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  name: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  /** Exactly the registered resource's externalReference; never a caller-supplied URL. */
  externalReference: z.string().min(1),
});
export type CanonicalRepositoryIdentity = z.infer<typeof canonicalRepositoryIdentitySchema>;
export const canonicalRepositorySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  resourceId: z.string().uuid(),
  repositoryIdentity: canonicalRepositoryIdentitySchema,
  defaultBranch: z.string().min(1),
  /** The exact default-branch head at the moment the binding was made. Never a floating ref. */
  canonicalSinceSha: z.string().regex(/^[0-9a-f]{40}$/),
  canonicalSinceAt: z.string().datetime(),
  status: canonicalRepositoryStatusSchema,
  /** Monotonic per project. The value a mutation pins with expectedCurrentCanonicalVersion. */
  version: z.number().int().positive(),
  createdBy: z.string().min(1),
  operationId: z.string().min(8).max(200),
  reason: z.string().max(500).default(""),
  /** Set on the binding this one replaced, and on the binding that replaced it. */
  supersedes: z.string().uuid().optional(),
  supersededBy: z.string().uuid().optional(),
  supersededAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CanonicalDevelopmentRepository = z.infer<typeof canonicalRepositorySchema>;

export const blockerSchema = z.object({
  code: z.string().min(1),
  reason: z.string().min(1),
  remediation: z.string().min(1),
});
export type Blocker = z.infer<typeof blockerSchema>;

// What a promotion WOULD do, computed without touching anything. Every fact here is read from the
// registry and from the provider; an unknown verification state is reported as UNKNOWN rather
// than as a pass, because a plan that flatters the candidate is worse than no plan.
export const canonicalRepositoryPlanSchema = z.object({
  projectId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  currentCanonical: canonicalRepositorySchema.optional(),
  candidateResourceId: z.string().uuid(),
  candidateRepository: z.string().optional(),
  candidateDefaultBranch: z.string().optional(),
  candidateHeadSha: z.string().optional(),
  permissions: z.array(resourcePermissionSchema),
  verificationState: z.object({
    source: z.enum(["EPIC_VERIFICATION_REPORT", "CI_REPORT", "NONE"]),
    status: z.enum(["PASS", "BLOCKED", "UNKNOWN"]),
    headSha: z.string().optional(),
    /** True only when that evidence was produced at candidateHeadSha itself. */
    atCandidateHead: z.boolean(),
    detail: z.string(),
  }),
  changesThatWouldOccur: z.array(z.string()),
  warnings: z.array(z.string()),
  blockers: z.array(blockerSchema),
  /** Pin these into the promotion call; drift between plan and mutation blocks it. */
  expectedHeadSha: z.string().optional(),
  expectedCurrentCanonicalVersion: z.number().int().nonnegative(),
  result: z.enum(["READY_TO_PROMOTE", "BLOCKED"]),
});
export type CanonicalRepositoryPlan = z.infer<typeof canonicalRepositoryPlanSchema>;

export const canonicalRepositoryPlanInputSchema = z.object({
  projectId: z.string().uuid(),
  resourceId: z.string().uuid(),
});
export const canonicalRepositoryPromoteInputSchema = z.object({
  projectId: z.string().uuid(),
  resourceId: z.string().uuid(),
  operationId: z.string().min(8).max(200),
  /** The head the plan was computed at. A moved branch is a stale plan, never a silent retarget. */
  expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
  /** 0 means "the plan saw no ACTIVE binding". Any drift blocks with STALE_PROMOTION_PLAN. */
  expectedCurrentCanonicalVersion: z.number().int().nonnegative(),
  confirmation: z.literal("PROMOTE_CANONICAL_DEVELOPMENT_REPOSITORY"),
  reason: z.string().min(8).max(500),
});
export type CanonicalRepositoryPromoteInput = z.infer<typeof canonicalRepositoryPromoteInputSchema>;
export const canonicalRepositoryRollbackInputSchema = z.object({
  projectId: z.string().uuid(),
  operationId: z.string().min(8).max(200),
  /** The binding being rolled back. Pinning it keeps a rollback from racing a promotion. */
  expectedCurrentCanonicalVersion: z.number().int().positive(),
  confirmation: z.literal("ROLLBACK_CANONICAL_DEVELOPMENT_REPOSITORY"),
  reason: z.string().min(8).max(500),
});
export type CanonicalRepositoryRollbackInput = z.infer<typeof canonicalRepositoryRollbackInputSchema>;

// ---------------------------------------------------------------------------
// Registered repository rename
//
// Renaming the repository a project is registered against is normally forbidden: changing a
// GITHUB_REPOSITORY binding through generic input is exactly how a project ends up executing
// against a repository nobody chose. A rename is the one case that is provably NOT that, because
// the provider's repository object keeps its stable id across it. So this operation is allowed
// only when it can prove, before and after, that the underlying repository is the same object at
// the same commit -- and it re-points the registration itself rather than leaving Autopilot to
// rely on the host's redirect, which would let the old and new names drift apart in resources,
// evidence and new tasks.
// ---------------------------------------------------------------------------
export const repositoryRenamePlanInputSchema = z.object({
  projectId: z.string().uuid(),
  resourceId: z.string().uuid(),
  newName: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
});
export const repositoryRenameInputSchema = z.object({
  projectId: z.string().uuid(),
  resourceId: z.string().uuid(),
  operationId: z.string().min(8).max(200),
  /** The new repository name only. The owner is never caller-supplied: a rename cannot move hosts. */
  newName: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  expectedCurrentReference: z.string().min(1),
  /** Pinned so a rename cannot quietly happen across a commit nobody looked at. */
  expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
  confirmation: z.literal("RENAME_REGISTERED_REPOSITORY"),
  reason: z.string().min(8).max(500),
});
export type RepositoryRenameInput = z.infer<typeof repositoryRenameInputSchema>;
export const repositoryRenamePlanSchema = z.object({
  projectId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  resourceId: z.string().uuid(),
  currentRepository: z.string(),
  targetRepository: z.string(),
  /** The provider's stable repository id. Equality across the rename is what proves identity. */
  repositoryId: z.string().optional(),
  defaultBranch: z.string().optional(),
  headSha: z.string().optional(),
  /** Present when something already occupies the target name. */
  targetNameTaken: z.boolean(),
  changesThatWouldOccur: z.array(z.string()),
  warnings: z.array(z.string()),
  blockers: z.array(blockerSchema),
  expectedHeadSha: z.string().optional(),
  result: z.enum(["READY_TO_RENAME", "BLOCKED"]),
});
export type RepositoryRenamePlan = z.infer<typeof repositoryRenamePlanSchema>;
export const repositoryRenameReportSchema = z.object({
  projectId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  operationId: z.string(),
  actor: z.string(),
  reason: z.string(),
  resourceId: z.string().uuid(),
  previousRepository: z.string(),
  newRepository: z.string(),
  /** Identical before and after, or the rename is not reported as a rename. */
  repositoryId: z.string(),
  defaultBranch: z.string(),
  headSha: z.string(),
  gitHistoryTouched: z.literal(false),
  registrationUpdated: z.boolean(),
  projectRepositoryUpdated: z.boolean(),
});
export type RepositoryRenameReport = z.infer<typeof repositoryRenameReportSchema>;

// ---------------------------------------------------------------------------
// Repository export / transfer
//
// Moving Git as an engineering object -- commit graph, branches, tags, refs -- not a file archive.
// Deliberately separate from promotion: a successful export says a target now holds the history,
// and says nothing whatsoever about where the project develops next. Making the target canonical
// is a second, explicit decision.
// ---------------------------------------------------------------------------
export const secretHandoverEntrySchema = z.object({
  /** A reference NAME. This artifact carries no values, by construction. */
  name: secretRefSchema,
  purpose: z.string().min(1),
  consumer: z.string().min(1),
  environment: environmentSchema,
  requirement: z.enum(["REQUIRED", "OPTIONAL"]),
  destinationSystem: z.string().min(1),
  owner: z.string().min(1),
  setupStatus: z.enum(["VERIFIED", "REQUIRES_OPERATOR_SETUP", "UNAVAILABLE", "NOT_APPLICABLE"]),
});
export type SecretHandoverEntry = z.infer<typeof secretHandoverEntrySchema>;
export const secretConfigHandoverSchema = z.object({
  projectId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  sourceRepository: z.string().min(1),
  targetRepository: z.string().optional(),
  entries: z.array(secretHandoverEntrySchema),
  /** Always false, and asserted by tests: no value ever travels with a handover. */
  valuesTransferred: z.literal(false),
  notes: z.array(z.string()),
});
export type SecretConfigHandover = z.infer<typeof secretConfigHandoverSchema>;

export const repositoryRefSchema = z.object({
  name: z.string().min(1),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
});
export type RepositoryRef = z.infer<typeof repositoryRefSchema>;
export const nonTransferableConfigurationSchema = z.object({
  item: z.string().min(1),
  classification: z.enum([
    "ACTIONS_SECRET",
    "BRANCH_PROTECTION",
    "IAM",
    "CLOUD_ACCOUNT",
    "DATABASE_CREDENTIAL",
    "HOSTED_ENVIRONMENT",
  ]),
  status: z.enum(["VERIFIED", "REQUIRES_OPERATOR_SETUP", "UNAVAILABLE", "NOT_APPLICABLE"]),
  detail: z.string().min(1),
});
export const repositoryExportPlanSchema = z.object({
  projectId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  sourceResourceId: z.string().uuid(),
  sourceRepository: z.string(),
  sourceDefaultBranch: z.string().optional(),
  sourceHeadSha: z.string().optional(),
  targetResourceId: z.string().uuid(),
  targetRepository: z.string(),
  targetDefaultBranch: z.string().optional(),
  targetHeadSha: z.string().optional(),
  targetIsEmpty: z.boolean(),
  branches: z.array(repositoryRefSchema),
  tags: z.array(repositoryRefSchema),
  /** Refs the transfer must create in the target before it can be judged complete. */
  requiredRefs: z.array(z.string()),
  transferMechanism: z.literal("GIT_MIRROR_PUSH"),
  requiredPermissions: z.object({
    source: z.array(resourcePermissionSchema),
    target: z.array(resourcePermissionSchema),
  }),
  protectedBranches: z.array(z.string()),
  /** Repository content that travels as Git, listed so an operator can see what is included. */
  transferableConfiguration: z.array(z.string()),
  /** Provider/hosting state Git cannot carry. Never marked VERIFIED without evidence. */
  nonTransferableConfiguration: z.array(nonTransferableConfigurationSchema),
  secretHandover: secretConfigHandoverSchema,
  verificationProcedure: z.array(z.string()),
  warnings: z.array(z.string()),
  blockers: z.array(blockerSchema),
  result: z.enum(["READY_TO_EXPORT", "BLOCKED"]),
});
export type RepositoryExportPlan = z.infer<typeof repositoryExportPlanSchema>;

export const repositoryExportPlanInputSchema = z.object({
  projectId: z.string().uuid(),
  sourceResourceId: z.string().uuid(),
  targetResourceId: z.string().uuid(),
});
export const repositoryExportInputSchema = z.object({
  projectId: z.string().uuid(),
  sourceResourceId: z.string().uuid(),
  targetResourceId: z.string().uuid(),
  operationId: z.string().min(8).max(200),
  expectedSourceHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
  confirmation: z.literal("EXPORT_REPOSITORY_HISTORY"),
  reason: z.string().min(8).max(500),
});
export type RepositoryExportInput = z.infer<typeof repositoryExportInputSchema>;

// Judged on refs actually read back from the target. A transfer that cannot be checked is
// BLOCKED, not "probably fine": partial success is not a state this is able to report.
export const repositoryExportVerificationSchema = z.object({
  projectId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  sourceRepository: z.string(),
  targetRepository: z.string(),
  sourceHeadSha: z.string().optional(),
  targetHeadSha: z.string().optional(),
  defaultBranch: z.string().optional(),
  checks: z.array(z.object({
    check: z.enum([
      "SOURCE_IDENTITY",
      "TARGET_IDENTITY",
      "SOURCE_HEAD",
      "TARGET_HEAD",
      "DEFAULT_BRANCH",
      "REQUIRED_REFS",
      "REQUIRED_TAGS",
      "HISTORY_EQUIVALENCE",
      "NO_SECRET_TRANSFER",
    ]),
    status: z.enum(["PASS", "BLOCKED", "NOT_APPLICABLE"]),
    detail: z.string().min(1),
  })),
  missingRefs: z.array(z.string()),
  missingTags: z.array(z.string()),
  blockers: z.array(blockerSchema),
  result: z.enum(["PASS", "BLOCKED"]),
});
export type RepositoryExportVerification = z.infer<typeof repositoryExportVerificationSchema>;

// ---------------------------------------------------------------------------
// Developer handover
//
// Machine-checkable facts about whether a human backend developer with no MCP and no Superadmin
// token can pick this repository up. It judges presence and objective content, never prose
// quality, and it never invents infrastructure facts: anything unproven reads UNVERIFIED.
// ---------------------------------------------------------------------------
export const handoverCheckSchema = z.object({
  check: z.string().min(1),
  requirement: z.enum(["REQUIRED", "NOT_APPLICABLE"]),
  status: z.enum(["PASS", "BLOCKED", "NOT_APPLICABLE", "UNVERIFIED"]),
  detail: z.string().min(1),
  remediation: z.string().optional(),
});
export type HandoverCheck = z.infer<typeof handoverCheckSchema>;
export const developerHandoverReportSchema = z.object({
  projectId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  repository: z.string().optional(),
  defaultBranch: z.string().optional(),
  /** The exact commit the documentation was read at, so two reports are comparable. */
  headSha: z.string().optional(),
  canonicalRepositoryStatus: z.enum(["ACTIVE", "ABSENT"]),
  checks: z.array(handoverCheckSchema),
  blockers: z.array(blockerSchema),
  result: z.enum(["PASS", "BLOCKED"]),
});
export type DeveloperHandoverReport = z.infer<typeof developerHandoverReportSchema>;

export const artifactKindSchema = z.enum([
  "REQUIREMENTS_SNAPSHOT",
  "IMPLEMENTATION_PLAN",
  "ARCHITECTURE_REVIEW",
  "CODE_DIFF",
  "MIGRATION_MANIFEST",
  "API_CONTRACT",
  "TEST_REPORT",
  "PROPERTY_BASED_REPORT",
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
  "EPIC_DIMENSION_EVIDENCE",
  "EPIC_VERIFICATION_REPORT",
  "CANONICAL_REPOSITORY_REPORT",
  "REPOSITORY_EXPORT_REPORT",
  "REPOSITORY_EXPORT_VERIFICATION",
  "SECRET_CONFIG_HANDOVER",
  "DEVELOPER_HANDOVER_REPORT",
  "REPOSITORY_RENAME_REPORT",
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
