import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  StateStore,
  Clock,
  IdGenerator,
  CommandJournal,
  GitWorkspaceAdapter,
  ImplementationExecutor,
  TestExecutor,
  ArtifactBlobStore,
} from "./ports.js";
import { systemClock, uuidGenerator } from "./ports.js";
import {
  ArchitectureViolation,
  InvalidState,
  NotFound,
  ReviewFailed,
  TestFailed,
  UnsupportedOperation,
} from "./errors.js";
import {
  projectCreateSchema,
  resourceRegisterSchema,
  taskCreateSchema,
  implementationPlanSchema,
  executeInputSchema,
  epicEvidenceRecordInputSchema,
  epicVerifyInputSchema,
  PlatformVersions,
  type ArchitectureRule,
  type Artifact,
  type ImplementationPlan,
  type Project,
  type Resource,
  type Run,
  type Task,
  type TestReport,
} from "../../schemas/src/index.js";
import { PolicyEngine } from "../../policy-engine/src/index.js";
import { ArchitectureGuard } from "../../policy-engine/src/architecture-guard.js";
import {
  ContextEngine,
  type ContextImport,
} from "../../context-engine/src/index.js";
import {
  DependencyEngine,
  WorkflowEngine,
} from "../../workflow-engine/src/index.js";
import { ArtifactStore } from "../../artifact-store/src/index.js";
import { AuditLog } from "../../audit/src/index.js";
import { IndependentReviewer } from "../../execution-engine/src/reviewer.js";
import { taskReadiness } from "./task-readiness.js";
import { classifyScope } from "./scope-classification.js";
import { buildEpicVerification, type EpicHeadEvidence, type EpicMemberInput } from "./epic-verification.js";
import { buildVerificationProfile, requiredSuites } from "./verification-profile.js";

// What each independent-review check actually wants. Without this the gate reported only a check
// name, which is why "apiCompatibility" alone cost three tasks a blind repair loop each before the
// cause was found.
const reviewCheckRemediation: Record<string, string> = {
  apiCompatibility:
    "The approved plan lists apiChanges, so review wants an API_CONTRACT artifact. Either include an openapi file in the change set, or -- if this task adds no public HTTP surface -- state INTERNAL_ONLY in its requirements and re-plan so the planner stops requiring contract evidence.",
  migrationSafety: "The plan lists databaseChanges; include the migration in the change set so a MIGRATION_MANIFEST is written.",
  testAdequacy: "Every suite the plan lists in testsRequired must run and pass. Read the latest TEST_REPORT artifact for the failing suite.",
  propertyBasedAdequacy:
    "The plan's verification profile marks PROPERTY as REQUIRED, so a green build is not enough: the runner output has to show generated cases. Add jqwik properties (JVM) or fast-check properties (Node) covering the invariant the profile names, or emit reports/property-based-report.json. If this task genuinely carries no algorithmic invariant, say so in its requirements -- naming the CRUD/DTO/adapter/static-registry shape -- and re-plan so the profile records NOT_APPLICABLE with that reason.",
  requirementsCoverage: "The plan carries no requirements; re-run superadmin_task_analyze so the requirements snapshot is rebuilt.",
  architectureConsistency: "No ARCHITECTURE_REVIEW artifact is present; re-run superadmin_task_plan.",
  security: "The plan lists no securityConsiderations; restate the task's security constraints and re-plan.",
  dataOwnership: "The plan lists no dataOwners; restate ownership in the task requirements and re-plan.",
  errorHandling: "REGRESSION must be among the plan's testsRequired.",
  observability: "State an observability/logging requirement in the task, or keep the task at LOW risk.",
  raceConditions: "State a concurrency/ownership/idempotency security consideration in the task requirements.",
  idempotency: "Describe an idempotent rollback strategy, or avoid database changes in this task.",
  rollback: "The plan needs a rollback strategy; restate it in the task requirements and re-plan.",
};

export interface ServiceDependencies {
  store: StateStore;
  execution: ImplementationExecutor;
  tests: TestExecutor;
  git: GitWorkspaceAdapter;
  commands: CommandJournal;
  clock?: Clock;
  ids?: IdGenerator;
  maxAutoRepairAttempts?: number;
  artifactBlobs?: ArtifactBlobStore;
}
export class AutopilotService {
  readonly store: StateStore;
  private clock: Clock;
  private ids: IdGenerator;
  private policy: PolicyEngine;
  private contexts: ContextEngine;
  private dependencies: DependencyEngine;
  private workflow: WorkflowEngine;
  private artifacts: ArtifactStore;
  private audit: AuditLog;
  private guard = new ArchitectureGuard();
  private reviewer: IndependentReviewer;
  private maxRepairs: number;
  constructor(private deps: ServiceDependencies) {
    this.store = deps.store;
    this.clock = deps.clock ?? systemClock;
    this.ids = deps.ids ?? uuidGenerator;
    this.policy = new PolicyEngine(deps.store);
    this.contexts = new ContextEngine(deps.store, this.ids, this.clock);
    this.dependencies = new DependencyEngine(deps.store);
    this.workflow = new WorkflowEngine(deps.store, this.ids, this.clock);
    this.artifacts = new ArtifactStore(deps.store, this.ids, this.clock, deps.artifactBlobs);
    this.audit = new AuditLog(deps.store, this.ids, this.clock);
    this.reviewer = new IndependentReviewer(this.clock);
    this.maxRepairs = deps.maxAutoRepairAttempts ?? 3;
  }
  async systemHealth() {
    return {
      status: "ok",
      platformVersion: PlatformVersions.platform,
      store: this.store.constructor.name,
      time: this.clock.now(),
      productionAutonomy: "NOT_SUPPORTED",
    };
  }
  async projectCreate(
    input: unknown,
    actor = "external-agent",
    correlationId = this.ids.next(),
  ) {
    const data = projectCreateSchema.parse(input);
    if (
      data.autonomyMode === "AUTONOMOUS_PRODUCTION" ||
      data.environment === "PRODUCTION"
    )
      throw new UnsupportedOperation(
        "Production autonomous mode and production project creation are not supported in v0.3",
      );
    const now = this.clock.now();
    const project: Project = {
      id: this.ids.next(),
      ...data,
      status: "ACTIVE",
      ...(data.workspacePath ? { workspacePath: resolve(data.workspacePath) } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.store.createProject(project);
    await this.audit.record({
      actor,
      action: "project.create",
      projectId: project.id,
      input: data,
      result: { id: project.id },
      reason: "Explicit project registration",
      correlationId,
    });
    return project;
  }
  projectGet(id: string) {
    return this.requiredProject(id);
  }
  projectList() {
    return this.store.listProjects();
  }
  async resourceRegister(
    input: unknown,
    actor = "external-agent",
    correlationId = this.ids.next(),
  ) {
    const data = resourceRegisterSchema.parse(input);
    const project = await this.requiredProject(data.projectId);
    await this.policy.authorize({ project, action: "PROJECT_WRITE", actor });
    if (data.environment === "PRODUCTION")
      throw new UnsupportedOperation(
        "Production resources cannot be registered for mutation in v0.3",
      );
    if (
      /:\/\/[^/@:]+:[^/@]+@/.test(data.externalReference) ||
      /(?:gh[pousr]_|sbp_)[A-Za-z0-9_-]+/.test(data.externalReference)
    )
      throw new ArchitectureViolation(
        "External references must not embed credentials; use secretRefs",
      );
    const resource: Resource = {
      resourceId: this.ids.next(),
      ...data,
      createdAt: this.clock.now(),
    };
    await this.store.createResource(resource);
    await this.audit.record({
      actor,
      action: "resource.register",
      projectId: project.id,
      resourceId: resource.resourceId,
      input: { ...data, secretRefs: data.secretRefs.map(() => "[REFERENCE]") },
      result: { resourceId: resource.resourceId },
      reason: "Explicit allowlist registration",
      correlationId,
    });
    return resource;
  }
  async resourceList(projectId: string) {
    await this.requiredProject(projectId);
    return this.store.listResources(projectId);
  }
  async contextImport(
    projectId: string,
    items: ContextImport[],
    actor = "external-agent",
    correlationId = this.ids.next(),
  ) {
    const project = await this.requiredProject(projectId);
    await this.policy.authorize({ project, action: "PROJECT_WRITE", actor });
    const context = await this.contexts.import(projectId, items);
    await this.audit.record({
      actor,
      action: "context.import",
      projectId,
      input: items.map((i) => ({ type: i.type, sourceRef: i.sourceRef })),
      result: { contextId: context.id, version: context.version },
      reason: "Structured context import; source text remains untrusted data",
      correlationId,
    });
    return context;
  }
  async contextGet(projectId: string) {
    await this.requiredProject(projectId);
    const v = await this.store.getLatestContext(projectId);
    if (!v) throw new NotFound("Project context not found");
    return v;
  }
  async taskCreate(
    input: unknown,
    actor = "external-agent",
    correlationId = this.ids.next(),
  ) {
    const data = taskCreateSchema.parse(input);
    const project = await this.requiredProject(data.projectId);
    await this.policy.authorize({ project, action: "PROJECT_WRITE", actor });
    const now = this.clock.now();
    const task: Task = {
      id: this.ids.next(),
      ...data,
      state: "INGESTED",
      repairAttempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.createTask(task);
    await this.audit.record({
      actor,
      action: "task.create",
      projectId: project.id,
      taskId: task.id,
      input: { externalKey: task.externalKey, title: task.title },
      result: { state: task.state },
      reason: "Task ingested as untrusted data",
      correlationId,
    });
    return task;
  }
  async taskGet(projectId: string, taskId: string) {
    return this.requiredTask(projectId, taskId);
  }
  async taskList(projectId: string) {
    await this.requiredProject(projectId);
    return this.store.listTasks(projectId);
  }
  async taskAnalyze(
    projectId: string,
    taskId: string,
    actor = "external-agent",
    correlationId = this.ids.next(),
  ) {
    let task = await this.requiredTask(projectId, taskId);
    await this.dependencies.assertReady(task);
    if (
      task.state !== "INGESTED" &&
      task.state !== "FAILED" &&
      task.state !== "BLOCKED"
    )
      throw new InvalidState(
        "Task can only be analyzed from INGESTED, FAILED, or BLOCKED",
      );
    task = await this.workflow.transition(
      task,
      "ANALYZING",
      "Dependencies satisfied; requirements snapshot created",
      actor,
    );
    const artifact = await this.artifacts.write(
      projectId,
      "REQUIREMENTS_SNAPSHOT",
      {
        title: task.title,
        description: task.description,
        requirements: task.requirements,
        relationships: task.relationships,
        sourceContentIsUntrusted: true,
      },
      task.id,
    );
    await this.audit.record({
      actor,
      action: "task.analyze",
      projectId,
      taskId,
      input: { state: "INGESTED" },
      result: { state: task.state, artifactId: artifact.id },
      reason: "Dependency gate passed",
      correlationId,
    });
    return { task, artifact };
  }
  async taskPlan(
    projectId: string,
    taskId: string,
    actor = "external-agent",
    correlationId = this.ids.next(),
  ) {
    let task = await this.requiredTask(projectId, taskId);
    if (task.state !== "ANALYZING")
      throw new InvalidState("Task must be ANALYZING before planning");
    const context = await this.store.getLatestContext(projectId);
    const plan = this.buildPlan(task);
    const rules = this.rulesFromContext(
      context?.sections.find((s) => s.type === "ARCHITECTURE_CANON")?.content,
    );
    const architecture = this.guard.review(plan, rules);
    if (!architecture.passed) {
      const reason = "ArchitectureGuard rejected implementation plan";
      throw new ArchitectureViolation(reason, {
        violations: architecture.violations,
        blockingReport: {
          code: "CANON_OR_API_CONFLICT",
          reason,
          evidence: architecture.violations,
          remediation: "Resolve the reported canon/API violations in the task requirements or architecture context, then analyze and plan again before execution.",
        },
      });
    }
    const approved = { ...plan, approved: true };
    const planArtifact = await this.artifacts.write(
      projectId,
      "IMPLEMENTATION_PLAN",
      approved,
      task.id,
    );
    const reviewArtifact = await this.artifacts.write(
      projectId,
      "ARCHITECTURE_REVIEW",
      architecture,
      task.id,
    );
    task = await this.workflow.transition(
      task,
      "PLANNED",
      "Structured plan approved by ArchitectureGuard",
      actor,
      [planArtifact.id],
      [reviewArtifact.id],
    );
    await this.audit.record({
      actor,
      action: "task.plan",
      projectId,
      taskId,
      input: { contextVersion: context?.version },
      result: { state: task.state, planArtifactId: planArtifact.id },
      reason: "Architecture gate passed",
      correlationId,
    });
    return { task, plan: approved, architecture };
  }
  async taskExecute(
    input: unknown,
    resourceId: string,
    actor = "external-agent",
    correlationId = this.ids.next(),
  ) {
    const data = executeInputSchema.parse(input);
    const project = await this.requiredProject(data.projectId);
    let task = await this.requiredTask(data.projectId, data.taskId);
    const existing = await this.store.findRunByOperation(
      project.id,
      data.operationId,
    );
    if (existing) return { run: existing, idempotentReplay: true };
    if (task.state !== "PLANNED" && task.state !== "IMPLEMENTING")
      throw new InvalidState(
        "Task must be PLANNED or awaiting repair in IMPLEMENTING",
      );
    await this.policy.authorize({
      project,
      action: "EXECUTE",
      resourceId,
      requiredPermission: "WRITE",
      actor,
    });
    const resource = await this.store.getResource(resourceId);
    if (!project.workspacePath)
      throw new UnsupportedOperation(
        "Local execution requires a workspacePath; remote projects must dispatch an execution job",
      );
    if (
      !resource ||
      resource.type !== "GIT_REPOSITORY" ||
      resolve(resource.externalReference) !== resolve(project.workspacePath)
    )
      throw new ArchitectureViolation(
        "Execution requires a local Git resource whose reference exactly matches the isolated project workspace",
      );
    if (task.state === "PLANNED")
      task = await this.workflow.transition(
        task,
        "IMPLEMENTING",
        "Execution authorized for registered sandbox repository",
        actor,
      );
    const context = await this.store.getLatestContext(project.id);
    let run: Run = {
      id: this.ids.next(),
      projectId: project.id,
      taskId: task.id,
      operationId: data.operationId,
      status: "RUNNING",
      platformVersion: PlatformVersions.platform,
      workflowVersion: PlatformVersions.workflow,
      policyVersion: PlatformVersions.policy,
      ...(context ? { contextVersion: context.version } : {}),
      startedAt: this.clock.now(),
    };
    run = await this.store.saveRun(run);
    try {
      const result = await this.deps.execution.execute({
        workspace: project.workspacePath,
        task,
        changes: data.changes,
      });
      const diffArtifact = await this.artifacts.write(
        project.id,
        "CODE_DIFF",
        { diff: result.diff },
        task.id,
        run.id,
      );
      const migrationFiles = data.changes.filter((c) =>
        /migrations?\//.test(c.path),
      );
      if (migrationFiles.length)
        await this.artifacts.write(
          project.id,
          "MIGRATION_MANIFEST",
          {
            migrations: migrationFiles.map((c) => ({
              path: c.path,
              content: c.content,
            })),
            schemaDiff: "Captured in code diff",
            validation: "Pending migration test gate",
            rollback: "Required in each migration or implementation plan",
          },
          task.id,
          run.id,
        );
      // A deleted contract file has no document to record; removal shows up in the diff instead.
      const apiFiles = data.changes.filter((c) => /openapi/i.test(c.path) && c.content !== undefined);
      if (apiFiles.length)
        await this.artifacts.write(
          project.id,
          "API_CONTRACT",
          {
            contracts: apiFiles.map((c) => ({
              path: c.path,
              document: /\.ya?ml$/i.test(c.path)
                ? parseYaml(c.content as string)
                : JSON.parse(c.content as string),
            })),
          },
          task.id,
          run.id,
        );
      await this.persistCommands(project.id, task.id, run.id);
      run = {
        ...run,
        status: "SUCCEEDED",
        baseCommit: result.baseCommit,
        commitSha: result.commitSha,
        branch: result.branch,
        finishedAt: this.clock.now(),
      };
      await this.store.updateRun(run);
      await this.audit.record({
        actor,
        action: "task.execute",
        projectId: project.id,
        taskId: task.id,
        resourceId,
        input: {
          operationId: data.operationId,
          changePaths: data.changes.map((c) => c.path),
        },
        result: {
          runId: run.id,
          branch: run.branch,
          commitSha: run.commitSha,
          diffArtifactId: diffArtifact.id,
        },
        reason: "Authorized semantic file change set",
        correlationId,
      });
      return { run, idempotentReplay: false };
    } catch (error) {
      await this.persistCommands(project.id, task.id, run.id);
      run = { ...run, status: "FAILED", finishedAt: this.clock.now() };
      await this.store.updateRun(run);
      throw error;
    }
  }
  async taskTest(
    projectId: string,
    taskId: string,
    actor = "external-agent",
    correlationId = this.ids.next(),
    executionWorkspace?: string,
  ) {
    const project = await this.requiredProject(projectId);
    const workspace=executionWorkspace??project.workspacePath;
    if (!workspace)
      throw new UnsupportedOperation(
        "Local testing requires a workspacePath; remote projects must dispatch an execution job",
      );
    let task = await this.requiredTask(projectId, taskId);
    if (task.state !== "IMPLEMENTING")
      throw new InvalidState("Task must be IMPLEMENTING before testing");
    task = await this.workflow.transition(
      task,
      "TESTING",
      "Implementation committed; executing required suites",
      actor,
    );
    const plan = await this.latestPlan(projectId, taskId);
    const report = await this.deps.tests.run(
      workspace,
      task.id,
      plan,
    );
    await this.persistCommands(projectId, task.id);
    const artifact = await this.artifacts.write(
      projectId,
      "TEST_REPORT",
      report,
      task.id,
    );
    await this.artifacts.write(
      projectId,
      "SECURITY_REPORT",
      {
        passed: report.suites.some((s) => s.type === "SECURITY" && s.passed),
        suite: "SECURITY",
      },
      task.id,
    );
    // Written before the pass/fail branch below on purpose: when the generative layer is the thing
    // that failed, the report explaining why -- counterexample count, replay seed, or the fact
    // that nothing was generated at all -- is exactly the evidence the repair needs.
    if (report.propertyBased)
      await this.artifacts.write(
        projectId,
        "PROPERTY_BASED_REPORT",
        report.propertyBased,
        task.id,
      );
    if (plan.databaseChanges.length)
      await this.artifacts.write(
        projectId,
        "MIGRATION_MANIFEST",
        {
          validation: report.suites.find((s) => s.type === "MIGRATION"),
          rollback: plan.rollbackStrategy,
          schemaDiffArtifact: (
            await this.findArtifact(projectId, taskId, "CODE_DIFF")
          ).id,
        },
        task.id,
      );
    if (!report.passed) {
      const updated = { ...task, repairAttempts: task.repairAttempts + 1 };
      await this.store.updateTask(updated);
      if (updated.repairAttempts >= this.maxRepairs) {
        task = await this.workflow.transition(
          updated,
          "BLOCKED",
          "Automatic repair attempt limit reached",
          actor,
          [artifact.id],
        );
      } else {
        task = await this.workflow.transition(
          updated,
          "IMPLEMENTING",
          "Tests failed; repair required",
          actor,
          [artifact.id],
        );
      }
      await this.audit.record({
        actor,
        action: "task.test",
        projectId,
        taskId,
        input: { attempt: updated.repairAttempts },
        result: { passed: false, state: task.state },
        reason: "Formal test gate failed",
        correlationId,
      });
      throw new TestFailed("Required tests failed", {
        state: task.state,
        report,
      });
    }
    task = await this.workflow.transition(
      task,
      "REVIEWING",
      "All required test suites passed",
      actor,
      [artifact.id],
    );
    await this.audit.record({
      actor,
      action: "task.test",
      projectId,
      taskId,
      input: { suites: plan.testsRequired },
      result: { passed: true, state: task.state },
      reason: "Formal test gate passed",
      correlationId,
    });
    return { task, report };
  }
  async taskReview(
    projectId: string,
    taskId: string,
    actor = "independent-reviewer",
    correlationId = this.ids.next(),
  ) {
    let task = await this.requiredTask(projectId, taskId);
    if (task.state !== "REVIEWING")
      throw new InvalidState("Task must be REVIEWING");
    const plan = await this.latestPlan(projectId, taskId);
    const artifacts = await this.store.listArtifacts(projectId, taskId);
    const testArtifact = [...artifacts]
      .reverse()
      .find((a) => a.kind === "TEST_REPORT");
    if (!testArtifact) throw new ReviewFailed("Test report missing");
    const report = testArtifact.content as TestReport;
    const review = this.reviewer.review(plan, report, artifacts);
    const reviewArtifact = await this.artifacts.write(
      projectId,
      "REVIEW_REPORT",
      review,
      task.id,
    );
    if (review.result === "FAIL") {
      task = await this.workflow.transition(
        task,
        "IMPLEMENTING",
        "Independent review failed; repair required",
        actor,
        [reviewArtifact.id],
      );
      await this.audit.record({
        actor,
        action: "task.review",
        projectId,
        taskId,
        input: { artifactCount: artifacts.length },
        result: review,
        reason: "Independent review gate failed",
        correlationId,
      });
      throw new ReviewFailed("Independent review failed", {
        failures: review.failures,
        blockingReport: {
          code: "REVIEW_CHECKS_FAILED",
          reason: `Independent review failed on: ${review.failures.join(", ")}`,
          remediation: review.failures
            .map((check) => `${check}: ${reviewCheckRemediation[check] ?? "Address this check, then execute again with a NEW operationId."}`)
            .join(" | "),
        },
      });
    }
    const requiresExternalCi = (await this.store.listResources(projectId)).some(
      (resource) =>
        resource.status === "ACTIVE" &&
        (resource.type === "GITHUB_REPOSITORY" ||
          (resource.type === "GIT_REPOSITORY" &&
            resource.provider !== "local")),
    );
    const runs = await this.store.listRuns(projectId, taskId);
    const finalArtifacts = await this.store.listArtifacts(projectId, taskId);
    // Same functions the readiness preflight uses, so what an agent is told beforehand and what
    // this gate actually enforces cannot drift apart.
    const readiness = taskReadiness({
      task,
      artifacts: finalArtifacts,
      runs,
      plan,
      requiresExternalCi,
    });
    if (readiness.blockers.length)
      throw new ReviewFailed("READY gate artifacts missing", {
        // Bare artifact kinds, unchanged for existing consumers; `blockers` carries the detail.
        missing: readiness.blockers.map((blocker) => blocker.code.replace(/^MISSING_/, "")),
        blockers: readiness.blockers,
        blockingReport: {
          code: "READY_GATE_EVIDENCE_MISSING",
          reason: readiness.blockers.map((blocker) => blocker.reason).join(" "),
          remediation: readiness.blockers.map((blocker) => blocker.remediation).join(" | "),
        },
      });
    const latestCommit = runs.at(-1)?.commitSha;
    const manifest = await this.artifacts.write(
      projectId,
      "FINAL_CHANGE_MANIFEST",
      {
        taskId,
        planHash: (
          await this.findArtifact(projectId, taskId, "IMPLEMENTATION_PLAN")
        ).contentHash,
        artifactIds: finalArtifacts.map((a) => a.id),
        gates: {
          implementation: true,
          architecture: true,
          tests: true,
          ci: requiresExternalCi,
          review: true,
        },
        verifiedCommitSha: latestCommit,
      },
      task.id,
    );
    task = await this.workflow.transition(
      task,
      "READY",
      "All formal READY gates passed",
      actor,
      [reviewArtifact.id],
      [manifest.id],
    );
    await this.audit.record({
      actor,
      action: "task.review",
      projectId,
      taskId,
      input: { artifactCount: finalArtifacts.length },
      result: {
        review: review.result,
        state: task.state,
        manifestId: manifest.id,
        verifiedCommitSha: latestCommit,
      },
      reason: "All formal readiness gates passed",
      correlationId,
    });
    return { task, review, manifest };
  }
  async taskRetry(projectId: string, taskId: string, actor = "external-agent") {
    const task = await this.requiredTask(projectId, taskId);
    if (task.state !== "BLOCKED" && task.state !== "FAILED")
      throw new InvalidState("Only BLOCKED or FAILED tasks may retry");
    if (task.repairAttempts >= this.maxRepairs)
      throw new InvalidState(
        "Repair limit exhausted; human intervention required",
      );
    return this.workflow.transition(
      task,
      "ANALYZING",
      "Explicit retry requested",
      actor,
    );
  }
  async taskStatus(projectId: string, taskId: string) {
    const task = await this.requiredTask(projectId, taskId);
    return {
      task,
      transitions: await this.store.listTransitions(taskId),
      artifacts: await this.store.listArtifacts(projectId, taskId),
      runs: await this.store.listRuns(projectId, taskId),
    };
  }
  /**
   * What this task still needs, and what to call next -- answerable at any point, including before
   * any work has run. Deliberately never throws for an unplanned task: an agent asking "what now?"
   * on a fresh task must get an answer, not an error.
   */
  async taskReadiness(projectId: string, taskId: string) {
    const task = await this.requiredTask(projectId, taskId);
    const [artifacts, runs, resources] = await Promise.all([
      this.store.listArtifacts(projectId, taskId),
      this.store.listRuns(projectId, taskId),
      this.store.listResources(projectId),
    ]);
    const planArtifact = artifacts.filter((value) => value.kind === "IMPLEMENTATION_PLAN").at(-1);
    const plan = planArtifact
      ? implementationPlanSchema.safeParse(planArtifact.content)
      : undefined;
    const requiresExternalCi = resources.some(
      (resource) =>
        resource.status === "ACTIVE" &&
        (resource.type === "GITHUB_REPOSITORY" ||
          (resource.type === "GIT_REPOSITORY" && resource.provider !== "local")),
    );
    return taskReadiness({
      task,
      artifacts,
      runs,
      ...(plan?.success ? { plan: plan.data } : {}),
      requiresExternalCi,
    });
  }
  /**
   * Whether a set of tasks composes into a verified system at one named commit.
   *
   * Deliberately not derived from the members' own verdicts: each of those was true about the
   * commit that member ran on, and an epic is a claim about a commit none of them ran on. See
   * epic-verification.ts. Read-only unless `persist` is set, so an agent can ask "what does this
   * epic still owe?" at any point without writing anything.
   */
  async epicVerification(input: unknown, actor = "release-agent") {
    const data = epicVerifyInputSchema.parse(input);
    const project = await this.requiredProject(data.projectId);
    const tasks = await this.store.listTasks(project.id);
    const selected = data.taskIds?.length
      ? tasks.filter((task) => data.taskIds!.includes(task.id))
      : tasks.filter((task) => task.externalKey.startsWith(data.externalKeyPrefix!));
    if (!selected.length)
      throw new NotFound("No tasks match the epic selection", {
        epicKey: data.epicKey,
        ...(data.externalKeyPrefix ? { externalKeyPrefix: data.externalKeyPrefix } : {}),
      });
    const artifacts = await this.store.listArtifacts(project.id);
    const members: EpicMemberInput[] = selected.map((task) => {
      const own = artifacts.filter((artifact) => artifact.taskId === task.id && artifact.status === "AVAILABLE");
      const planArtifact = [...own].reverse().find((artifact) => artifact.kind === "IMPLEMENTATION_PLAN");
      const parsed = planArtifact ? implementationPlanSchema.safeParse(planArtifact.content) : undefined;
      return { task, artifacts: own, ...(parsed?.success ? { plan: parsed.data } : {}) };
    });
    // Evidence is project-scoped rather than task-scoped: it belongs to the epic run, not to any
    // member. Only rows for this epic key are considered.
    const headEvidence: EpicHeadEvidence[] = artifacts
      .filter((artifact) => artifact.kind === "EPIC_DIMENSION_EVIDENCE" && artifact.status === "AVAILABLE")
      .map((artifact) => ({ artifact, content: artifact.content as Record<string, unknown> }))
      .filter((row) => row.content["epicKey"] === data.epicKey)
      .map((row) => ({
        dimension: row.content["dimension"] as EpicHeadEvidence["dimension"],
        artifactId: row.artifact.id,
        commitSha: String(row.content["commitSha"] ?? ""),
        passed: row.content["passed"] === true,
        ...(row.content["detail"] ? { detail: String(row.content["detail"]) } : {}),
      }));
    const report = buildEpicVerification({
      epicKey: data.epicKey,
      headSha: data.headSha,
      members,
      headEvidence,
      generatedAt: this.clock.now(),
    });
    if (!data.persist) return { report, persisted: null };
    const artifact = await this.artifacts.write(project.id, "EPIC_VERIFICATION_REPORT", report);
    await this.audit.record({
      actor,
      action: "epic.verification",
      projectId: project.id,
      input: { epicKey: data.epicKey, headSha: data.headSha, members: report.members.length },
      result: { result: report.result, blockers: report.blockers.map((blocker) => blocker.code), artifactId: artifact.id },
      reason: "Aggregate epic verification evaluated at a single head commit",
      correlationId: data.operationId ?? artifact.id,
    });
    return { report, persisted: artifact };
  }
  /**
   * Records one dimension's result from a run that actually happened. `source` is mandatory so the
   * verdict is attributable, and the commit is part of the record so it can never be reused for a
   * later head.
   */
  async epicEvidenceRecord(input: unknown, actor = "release-agent") {
    const data = epicEvidenceRecordInputSchema.parse(input);
    const project = await this.requiredProject(data.projectId);
    const existing = (await this.store.listArtifacts(project.id)).find((artifact) => {
      if (artifact.kind !== "EPIC_DIMENSION_EVIDENCE" || artifact.status !== "AVAILABLE") return false;
      const content = artifact.content as Record<string, unknown>;
      return (
        content["epicKey"] === data.epicKey &&
        content["dimension"] === data.dimension &&
        content["commitSha"] === data.commitSha &&
        content["source"] === data.source
      );
    });
    if (existing) return { artifact: existing, idempotentReplay: true };
    const artifact = await this.artifacts.write(project.id, "EPIC_DIMENSION_EVIDENCE", {
      epicKey: data.epicKey,
      dimension: data.dimension,
      commitSha: data.commitSha,
      passed: data.passed,
      source: data.source,
      ...(data.detail ? { detail: data.detail } : {}),
      recordedAt: this.clock.now(),
    });
    await this.audit.record({
      actor,
      action: "epic.evidence.recorded",
      projectId: project.id,
      input: { epicKey: data.epicKey, dimension: data.dimension, commitSha: data.commitSha, source: data.source },
      result: { passed: data.passed, artifactId: artifact.id },
      reason: "Aggregate epic check result bound to its exact commit",
      correlationId: data.operationId,
    });
    return { artifact, idempotentReplay: false };
  }
  async artifactList(projectId: string, taskId?: string) {
    await this.requiredProject(projectId);
    return this.artifacts.list(projectId, taskId);
  }
  async artifactRead(projectId: string, id: string) {
    await this.requiredProject(projectId);
    return this.artifacts.read(projectId, id);
  }
  async runList(projectId: string, taskId?: string) {
    await this.requiredProject(projectId);
    return this.store.listRuns(projectId, taskId);
  }
  async runGet(projectId: string, id: string) {
    await this.requiredProject(projectId);
    const run = await this.store.getRun(projectId, id);
    if (!run) throw new NotFound("Run not found");
    return run;
  }
  async gitDiff(projectId: string, taskId: string, resourceId: string) {
    const project = await this.requiredProject(projectId);
    if (!project.workspacePath)
      throw new UnsupportedOperation(
        "Local git diff requires a workspacePath; remote projects read the persisted CODE_DIFF artifact",
      );
    await this.policy.authorize({
      project,
      action: "RESOURCE_READ",
      resourceId,
      requiredPermission: "READ",
      actor: "external-agent",
    });
    const runs = await this.store.listRuns(projectId, taskId);
    const run = runs.at(-1);
    if (!run?.baseCommit) throw new NotFound("No executed run found");
    return {
      diff: await this.deps.git.diff(
        project.workspacePath,
        taskId,
        run.baseCommit,
      ),
      baseCommit: run.baseCommit,
      commitSha: run.commitSha,
    };
  }
  async projectSnapshot(projectId: string) {
    const project = await this.requiredProject(projectId);
    return {
      project,
      context: await this.store.getLatestContext(projectId),
      resources: await this.store.listResources(projectId),
      tasks: await this.store.listTasks(projectId),
      runs: await this.store.listRuns(projectId),
      artifacts: await this.store.listArtifacts(projectId),
      audit: await this.store.listAudit(projectId),
      versions: PlatformVersions,
    };
  }
  private async requiredProject(id: string) {
    const v = await this.store.getProject(id);
    if (!v) throw new NotFound("Project not found", { projectId: id });
    return v;
  }
  private async requiredTask(projectId: string, id: string) {
    const v = await this.store.getTask(projectId, id);
    if (!v) throw new NotFound("Task not found", { projectId, taskId: id });
    return v;
  }
  private buildPlan(task: Task): ImplementationPlan {
    const text = [task.title, task.description, ...task.requirements].join(" ");
    // Intent, not mention. A clause that names an API or a migration only to forbid it is evidence
    // against the change; counting it as evidence for one is what made three CORE-BE tasks and
    // CORE-QA-02 stall on gates demanding contracts and manifests they were told not to produce.
    // See scope-classification.ts for why negation is the general form of the INTERNAL_ONLY signal.
    const scope = classifyScope(text);
    const verification = buildVerificationProfile(text, scope);
    return implementationPlanSchema.parse({
      taskId: task.id,
      goal: task.title,
      requirements: task.requirements,
      affectedDomains: [task.title.split(/\s+/)[0]?.toLowerCase() ?? "backend"],
      dataOwners: ["authenticated principal"],
      filesExpectedToChange: [
        "src/**",
        ...(scope.database.mentioned ? ["migrations/*.sql"] : []),
        ...(scope.api.mentioned ? ["openapi.json"] : []),
      ],
      // Suite coverage follows mention -- asking for more coverage than strictly needed is
      // harmless -- while these two lists, which the READY gate turns into required artifacts,
      // follow intent.
      databaseChanges: scope.database.intended ? ["Versioned, reproducible schema migration"] : [],
      apiChanges: scope.api.intended ? ["Machine-readable REST contract"] : [],
      events: [],
      securityConsiderations: [
        "authorization ownership enforcement",
        "race conditions and idempotency",
      ],
      dependencies: task.relationships
        .filter((r) => r.type === "DEPENDS_ON")
        .map((r) => r.targetTaskId),
      testsRequired: requiredSuites(verification),
      verification,
      rollbackStrategy:
        "Revert the task commit and apply the documented idempotent rollback migration when applicable",
      openQuestions: [],
      // Risk is about what the change can break in operation, not about how deeply it is verified.
      // Tying it to PROPERTY made every task with an algorithmic invariant MEDIUM, which in turn
      // made independent review's observability check demand a logging requirement the task never
      // needed -- a portability fix for two test helpers was failed on exactly that. Verification
      // depth is already carried by the profile; it does not belong here too.
      riskLevel: scope.database.intended ? "MEDIUM" : "LOW",
      approved: false,
      createdAt: this.clock.now(),
    });
  }
  private rulesFromContext(content: unknown): ArchitectureRule[] {
    const defaults: ArchitectureRule[] = [
      {
        id: "security-ownership",
        type: "REQUIRE_SECURITY_CONSIDERATION",
        term: "ownership",
        message: "Ownership must be addressed",
      },
      {
        id: "security-test",
        type: "REQUIRE_TEST",
        test: "SECURITY",
        message: "Security tests are required",
      },
    ];
    if (!Array.isArray(content)) return defaults;
    return [
      ...defaults,
      ...(content.filter(
        (v) => v && typeof v === "object" && "type" in v,
      ) as ArchitectureRule[]),
    ];
  }
  private async latestPlan(projectId: string, taskId: string) {
    const artifact = await this.findArtifact(
      projectId,
      taskId,
      "IMPLEMENTATION_PLAN",
    );
    return implementationPlanSchema.parse(artifact.content);
  }
  private async findArtifact(
    projectId: string,
    taskId: string,
    kind: Artifact["kind"],
  ) {
    const found = (await this.store.listArtifacts(projectId, taskId))
      .filter((a) => a.kind === kind)
      .at(-1);
    if (!found) throw new NotFound(`${kind} artifact not found`);
    return found;
  }
  private async persistCommands(
    projectId: string,
    taskId: string,
    runId?: string,
  ) {
    const entries = this.deps.commands.drain(taskId);
    if (!entries.length) return;
    const records = [];
    for (const entry of entries) {
      const stdout = entry.stdout
        ? await this.artifacts.write(
            projectId,
            "COMMAND_STDOUT",
            entry.stdout,
            taskId,
            runId,
          )
        : undefined;
      const stderr = entry.stderr
        ? await this.artifacts.write(
            projectId,
            "COMMAND_STDERR",
            entry.stderr,
            taskId,
            runId,
          )
        : undefined;
      records.push({
        ...entry.record,
        ...(stdout ? { stdoutRef: stdout.id } : {}),
        ...(stderr ? { stderrRef: stderr.id } : {}),
      });
    }
    await this.artifacts.write(
      projectId,
      "COMMAND_LOG",
      { commands: records },
      taskId,
      runId,
    );
  }
}
