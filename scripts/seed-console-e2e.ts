import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { ArtifactStore } from "../packages/artifact-store/src/index.js";
import { systemClock, uuidGenerator } from "../packages/core/src/ports.js";
import { FileStateStore } from "../packages/project-registry/src/file-store.js";
import {
  PlatformVersions,
  type ArtifactKind,
  type AuditEvent,
  type Project,
  type Resource,
  type Run,
  type Task,
  type Transition,
} from "../packages/schemas/src/index.js";

const path = resolve("tests/.tmp/operator-console-state.json");
await mkdir(resolve("tests/.tmp"), { recursive: true });
await rm(path, { force: true });
const store = new FileStateStore(path);
const now = new Date().toISOString();
const projectId = crypto.randomUUID(),
  taskId = crypto.randomUUID();
const project: Project = {
  id: projectId,
  name: "Backend Autopilot Live Sandbox",
  slug: "backend-autopilot-live-sandbox",
  sourceType: "LOCAL",
  environment: "STAGING",
  autonomyMode: "AUTONOMOUS_STAGING",
  status: "ACTIVE",
  workspacePath: resolve("tests/fixtures/console-target"),
  createdAt: now,
  updatedAt: now,
};
await store.createProject(project);
const resources: Array<Omit<Resource, "resourceId" | "createdAt">> = [
  {
    type: "GITHUB_REPOSITORY",
    provider: "github",
    externalReference: "momaibackend-ctrl/momnabackend",
    projectId,
    environment: "SANDBOX",
    permissions: ["READ", "WRITE"],
    status: "ACTIVE",
    secretRefs: [],
  },
  {
    type: "SUPABASE_PROJECT",
    provider: "supabase",
    externalReference: "qtyfdzjzmgxtrarpgcmn",
    projectId,
    environment: "SANDBOX",
    permissions: ["READ", "WRITE", "MIGRATE"],
    status: "ACTIVE",
    secretRefs: [],
  },
  {
    type: "DATABASE",
    provider: "supabase",
    externalReference: "supabase:qtyfdzjzmgxtrarpgcmn:postgres",
    projectId,
    environment: "SANDBOX",
    permissions: ["READ", "MIGRATE"],
    status: "ACTIVE",
    secretRefs: ["E2E_SERVER_SIDE_ONLY"],
  },
];
for (const resource of resources)
  await store.createResource({
    ...resource,
    resourceId: crypto.randomUUID(),
    createdAt: now,
  });
const task: Task = {
  id: taskId,
  projectId,
  externalKey: "LIVE-1",
  title: "Live Notes CRUD REST API",
  description: "Validated sandbox backend implementation",
  requirements: [
    "Create/read/update/delete owned notes",
    "Apply reproducible migration",
    "Verify ownership isolation",
  ],
  state: "READY",
  relationships: [],
  repairAttempts: 1,
  createdAt: now,
  updatedAt: now,
};
await store.createTask(task);
const branch = "autopilot/LIVE-1-live-notes-crud-rest-api",
  commitSha = "6314f9b903cff61887b08f89c2d7754f60204f57";
for (let index = 0; index < 3; index++) {
  const run: Run = {
    id: crypto.randomUUID(),
    projectId,
    taskId,
    operationId: `e2e-run-${index}`,
    status: "SUCCEEDED",
    baseCommit: "a".repeat(40),
    commitSha: index === 2 ? commitSha : String(index + 1).repeat(40),
    branch,
    platformVersion: PlatformVersions.platform,
    workflowVersion: PlatformVersions.workflow,
    policyVersion: PlatformVersions.policy,
    startedAt: new Date(Date.now() + index * 1000).toISOString(),
    finishedAt: new Date(Date.now() + index * 1000 + 500).toISOString(),
  };
  await store.saveRun(run);
}
const artifacts = new ArtifactStore(store, uuidGenerator, systemClock);
const values: Array<[ArtifactKind, unknown]> = [
  [
    "REQUIREMENTS_SNAPSHOT",
    {
      requirements: task.requirements,
      sourceContentIsUntrusted: true,
      untrustedRenderingProbe:
        '<img src=x onerror="globalThis.compromised=true"><script>globalThis.compromised=true</script>',
    },
  ],
  [
    "IMPLEMENTATION_PLAN",
    {
      taskId,
      goal: task.title,
      requirements: task.requirements,
      affectedDomains: ["notes", "authorization"],
      dataOwners: ["authenticated user"],
      filesExpectedToChange: [
        "src/notes.js",
        "src/server.js",
        "openapi.json",
        "migrations/001_notes.sql",
      ],
      databaseChanges: ["Create notes table with owner_id and RLS"],
      apiChanges: ["Add CRUD /notes endpoints"],
      events: [],
      securityConsiderations: [
        "Enforce owner_id for every operation",
        "Keep credentials server-side",
      ],
      dependencies: [],
      testsRequired: [
        "UNIT",
        "INTEGRATION",
        "CONTRACT",
        "MIGRATION",
        "SECURITY",
        "REGRESSION",
      ],
      rollbackStrategy:
        "Revert commit and apply the reviewed down migration",
      openQuestions: [],
      riskLevel: "MEDIUM",
      approved: true,
      createdAt: now,
    },
  ],
  ["ARCHITECTURE_REVIEW", { passed: true, violations: [] }],
  [
    "CODE_DIFF",
    {
      files: [
        "src/notes.js",
        "src/server.js",
        "openapi.json",
        "migrations/001_notes.sql",
      ],
    },
  ],
  [
    "MIGRATION_MANIFEST",
    {
      migrationId: "notes_schema_v1",
      status: "APPLIED",
      durationMs: 312,
      schemaDiff: [
        "+ table notes",
        "+ column notes.owner_id",
        "+ index notes_owner_created_idx",
        "+ RLS policy notes_owner_policy",
      ],
      rollback: "DROP TABLE notes requires explicit review",
    },
  ],
  [
    "API_CONTRACT",
    {
      contracts: [
        {
          document: {
            openapi: "3.1.0",
            paths: {
              "/notes": {
                get: {
                  description: "List owned notes",
                  security: [{ userId: [] }],
                },
                post: {
                  description: "Create note",
                  responses: { "201": { description: "Created" } },
                },
              },
              "/notes/{id}": {
                get: { description: "Read owned note" },
                patch: { description: "Update note" },
                delete: { description: "Delete note" },
              },
            },
          },
        },
      ],
    },
  ],
  [
    "TEST_REPORT",
    {
      passed: true,
      suites: [
        { type: "UNIT", passed: true },
        { type: "INTEGRATION", passed: true },
        { type: "CONTRACT", passed: true },
        { type: "MIGRATION", passed: true },
        { type: "SECURITY", passed: true },
        { type: "REGRESSION", passed: true },
      ],
    },
  ],
  ["SECURITY_REPORT", { passed: true, ownershipIsolation: true, rls: true }],
  [
    "CI_REPORT",
    {
      provider: "github",
      repository: "momaibackend-ctrl/momnabackend",
      expectedSha: commitSha,
      ci: {
        success: true,
        status: "completed",
        conclusion: "success",
        headSha: commitSha,
        url: "https://github.com/momaibackend-ctrl/momnabackend/actions/runs/32264809746",
      },
    },
  ],
  [
    "REVIEW_REPORT",
    {
      result: "PASS",
      warnings: [],
      failures: [],
      checks: {
        requirementsCoverage: true,
        security: true,
        migrationSafety: true,
        testAdequacy: true,
      },
    },
  ],
  [
    "FINAL_CHANGE_MANIFEST",
    {
      gates: {
        implementation: true,
        architecture: true,
        tests: true,
        ci: true,
        review: true,
      },
      verifiedCommitSha: commitSha,
    },
  ],
  [
    "PULL_REQUEST_REPORT",
    {
      pullRequest: {
        url: "https://github.com/momaibackend-ctrl/momnabackend/pull/1",
      },
    },
  ],
  [
    "VALIDATION_REPORT",
    {
      operationId: "seeded-live-proof",
      suite: "FULL",
      environment: "STAGING",
      commitSha,
      result: "PASS",
      counts: { passed: 7, failed: 0, skipped: 0 },
      humanSummary: "7 проверок пройдены.",
      checks: [
        {
          name: "Live sandbox API CRUD",
          passed: true,
          summary: "Реальный CRUD и ownership isolation прошли",
        },
      ],
    },
  ],
];
for (const [kind, content] of values)
  await artifacts.write(projectId, kind, content, taskId);
for (let index = values.length; index < 56; index++)
  await artifacts.write(
    projectId,
    "COMMAND_STDOUT",
    { fixtureEvidence: `sanitized-${index}` },
    taskId,
  );
const states = [
  "ANALYZING",
  "PLANNED",
  "IMPLEMENTING",
  "TESTING",
  "IMPLEMENTING",
  "TESTING",
  "REVIEWING",
  "READY",
] as const;
let from: "INGESTED" | (typeof states)[number] = "INGESTED";
for (const [index, to] of states.entries()) {
  const transition: Transition = {
    id: crypto.randomUUID(),
    taskId,
    from,
    to,
    reason:
      index === 4
        ? "API tests failed; repair attempt #1"
        : "Formal workflow gate completed",
    actor: index === 7 ? "independent-reviewer" : "external-agent",
    inputArtifactIds: [],
    outputArtifactIds: [],
    timestamp: new Date(Date.now() + index * 1000).toISOString(),
  };
  await store.appendTransition(transition);
  from = to;
}
for (const [index, action] of [
  "task.create",
  "task.plan",
  "task.execute",
  "bootstrap.database.migration_verified",
  "task.test",
  "bootstrap.github.ci_verified",
  "task.review",
].entries()) {
  const event: AuditEvent = {
    id: crypto.randomUUID(),
    actor: "console-e2e",
    action,
    projectId,
    taskId,
    timestamp: new Date(Date.now() + index * 1000).toISOString(),
    input: {},
    result: { success: true },
    reason: "Sanitized browser E2E fixture evidence",
    correlationId: crypto.randomUUID(),
  };
  await store.appendAudit(event);
}
console.log(JSON.stringify({ success: true, path, projectId, taskId }));
