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
  PlatformVersions,
  type ArchitectureRule,
  type Artifact,
  type ArtifactKind,
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
      const apiFiles = data.changes.filter((c) => /openapi/i.test(c.path));
      if (apiFiles.length)
        await this.artifacts.write(
          project.id,
          "API_CONTRACT",
          {
            contracts: apiFiles.map((c) => ({
              path: c.path,
              document: /\.ya?ml$/i.test(c.path)
                ? parseYaml(c.content)
                : JSON.parse(c.content),
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
      });
    }
    const required: ArtifactKind[] = [
      "REQUIREMENTS_SNAPSHOT",
      "IMPLEMENTATION_PLAN",
      "ARCHITECTURE_REVIEW",
      "CODE_DIFF",
      "TEST_REPORT",
      "SECURITY_REPORT",
      "REVIEW_REPORT",
    ];
    const requiresExternalCi = (await this.store.listResources(projectId)).some(
      (resource) =>
        resource.status === "ACTIVE" &&
        (resource.type === "GITHUB_REPOSITORY" ||
          (resource.type === "GIT_REPOSITORY" &&
            resource.provider !== "local")),
    );
    const runs = await this.store.listRuns(projectId, taskId);
    const latestCommit = runs.at(-1)?.commitSha;
    if (requiresExternalCi) required.push("CI_REPORT");
    const finalArtifacts = await this.store.listArtifacts(projectId, taskId);
    const missing: string[] = required.filter(
      (kind) => !finalArtifacts.some((a) => a.kind === kind),
    );
    if (requiresExternalCi) {
      const exactCi = finalArtifacts.some(
        (a) =>
          a.kind === "CI_REPORT" &&
          (
            a.content as {
              expectedSha?: string;
              ci?: { success?: boolean; headSha?: string };
            }
          ).expectedSha === latestCommit &&
          (a.content as { ci?: { success?: boolean; headSha?: string } }).ci
            ?.success === true &&
          (a.content as { ci?: { headSha?: string } }).ci?.headSha ===
            latestCommit,
      );
      if (!latestCommit || !exactCi)
        missing.push("CI_REPORT_EXACT_LATEST_COMMIT");
    }
    if (
      plan.databaseChanges.length &&
      !finalArtifacts.some((a) => a.kind === "MIGRATION_MANIFEST")
    )
      missing.push("MIGRATION_MANIFEST");
    if (
      plan.apiChanges.length &&
      !finalArtifacts.some((a) => a.kind === "API_CONTRACT")
    )
      missing.push("API_CONTRACT");
    if (missing.length)
      throw new ReviewFailed("READY gate artifacts missing", { missing });
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
    const db = /\bdatabase\b|\bpostgres\b|\bmigrations?\b|\bschema\b/i.test(text);
    // Word-bounded so "restart" (present in the standard dirty-workspace-recovery requirement on
    // every task) can no longer masquerade as a REST mention.
    const api = /\bapis?\b|\brest\b|\bendpoints?\b|\bopenapi\b/i.test(text);
    // `api` alone over-fires: three real tasks in a row (CORE-BE-07, 09, 10) required
    // "INTERNAL_ONLY ... do not invent public HTTP APIs" language to justify NOT exposing REST,
    // which this keyword scan cannot distinguish from a genuine request to add one. Each stalled
    // on independent review demanding an API_CONTRACT artifact for a change that was never meant
    // to touch the API surface, costing a blind repair loop every time before anyone found the
    // real cause. Task authors already write "INTERNAL_ONLY" as the explicit, deliberate signal
    // for exactly this case, so trust it: keep `api` driving CONTRACT-suite coverage and the
    // openapi.json expected-file hint (asking for more test coverage than needed is harmless),
    // but only require API_CONTRACT evidence -- what the review gate actually enforces -- when
    // the task does not declare itself internal-only.
    const publicApiIntent = api && !/\binternal[_-]?only\b/i.test(text);
    const tests: ImplementationPlan["testsRequired"] = [
      "UNIT",
      "INTEGRATION",
      ...(api ? ["CONTRACT" as const] : []),
      ...(db ? ["MIGRATION" as const] : []),
      "SECURITY",
      "REGRESSION",
    ];
    return implementationPlanSchema.parse({
      taskId: task.id,
      goal: task.title,
      requirements: task.requirements,
      affectedDomains: [task.title.split(/\s+/)[0]?.toLowerCase() ?? "backend"],
      dataOwners: ["authenticated principal"],
      filesExpectedToChange: [
        "src/**",
        ...(db ? ["migrations/*.sql"] : []),
        ...(api ? ["openapi.json"] : []),
      ],
      databaseChanges: db ? ["Versioned, reproducible schema migration"] : [],
      apiChanges: publicApiIntent ? ["Machine-readable REST contract"] : [],
      events: [],
      securityConsiderations: [
        "authorization ownership enforcement",
        "race conditions and idempotency",
      ],
      dependencies: task.relationships
        .filter((r) => r.type === "DEPENDS_ON")
        .map((r) => r.targetTaskId),
      testsRequired: tests,
      rollbackStrategy:
        "Revert the task commit and apply the documented idempotent rollback migration when applicable",
      openQuestions: [],
      riskLevel: db ? "MEDIUM" : "LOW",
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
