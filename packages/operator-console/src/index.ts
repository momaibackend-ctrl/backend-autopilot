import { access } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactStore } from "../../artifact-store/src/index.js";
import { AuditLog, redact } from "../../audit/src/index.js";
import type { ExternalPostgresAdapter } from "../../adapters/database/src/index.js";
import {
  InvalidState,
  NotFound,
  PolicyViolation,
  UnsupportedOperation,
} from "../../core/src/errors.js";
import type { AutopilotService } from "../../core/src/application.js";
import type {
  Clock,
  CommandJournal,
  IdGenerator,
  StateStore,
  TestExecutor,
} from "../../core/src/ports.js";
import type { SecretProvider } from "../../core/src/secrets.js";
import type { CommandRunner } from "../../execution-engine/src/command-runner.js";
import { PolicyEngine } from "../../policy-engine/src/index.js";
import {
  apiRequestInputSchema,
  implementationPlanSchema,
  validationRunInputSchema,
  validationScenarioRunInputSchema,
  validationScenarioSaveInputSchema,
  type ApiRequestInput,
  type Artifact,
  type ImplementationPlan,
  type Project,
  type Resource,
  type ValidationScenarioSaveInput,
  type ValidationSuite,
} from "../../schemas/src/index.js";

type Capabilities = (projectId?: string) => Promise<unknown>;
const stateOrder = [
  "INGESTED",
  "ANALYZING",
  "PLANNED",
  "IMPLEMENTING",
  "TESTING",
  "REVIEWING",
  "READY",
];
const suiteTypes: Record<ValidationSuite, ImplementationPlan["testsRequired"]> =
  {
    SMOKE: ["UNIT", "CONTRACT"],
    CRUD: ["UNIT", "INTEGRATION", "CONTRACT"],
    AUTHENTICATION: ["SECURITY"],
    AUTHORIZATION: ["SECURITY", "INTEGRATION"],
    RLS: ["SECURITY", "MIGRATION"],
    REGRESSION: ["REGRESSION"],
    FULL: [
      "UNIT",
      "INTEGRATION",
      "CONTRACT",
      "MIGRATION",
      "SECURITY",
      "REGRESSION",
    ],
  };

export class OperatorConsoleService {
  private artifacts: ArtifactStore;
  private audit: AuditLog;
  private policy: PolicyEngine;
  constructor(
    private deps: {
      service: AutopilotService;
      store: StateStore;
      tests: TestExecutor;
      commands: CommandRunner & CommandJournal;
      database: ExternalPostgresAdapter;
      secrets: SecretProvider;
      clock: Clock;
      ids: IdGenerator;
      capabilities: Capabilities;
    },
  ) {
    this.artifacts = new ArtifactStore(deps.store, deps.ids, deps.clock);
    this.audit = new AuditLog(deps.store, deps.ids, deps.clock);
    this.policy = new PolicyEngine(deps.store);
  }
  async overview() {
    const projects = await this.deps.service.projectList();
    const views = await Promise.all(
      projects.map((project) => this.projectCard(project)),
    );
    const tasks = views.flatMap((view) => view.tasks);
    const runs = views.flatMap((view) => view.runs);
    const events = views
      .flatMap((view) => view.recentEvents)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 12);
    return {
      generatedAt: this.deps.clock.now(),
      summary: {
        projects: projects.length,
        activeTasks: tasks.filter(
          (task) => !["READY", "FAILED", "BLOCKED"].includes(task.state),
        ).length,
        blocked: tasks.filter((task) => task.state === "BLOCKED").length,
        failed: tasks.filter((task) => task.state === "FAILED").length,
        ready: tasks.filter((task) => task.state === "READY").length,
        runningRuns: runs.filter((run) => run.status === "RUNNING").length,
        warnings: views.reduce((sum, view) => sum + view.warningCount, 0),
      },
      projects: views,
      events,
    };
  }
  async project(projectId: string) {
    const snapshot = await this.deps.service.projectSnapshot(projectId);
    const tasks = await Promise.all(
      snapshot.tasks.map((task) => this.taskSummary(projectId, task.id)),
    );
    return {
      project: snapshot.project,
      resources: snapshot.resources.map(safeResource),
      context: snapshot.context,
      tasks,
      runs: snapshot.runs,
      artifacts: snapshot.artifacts,
      audit: snapshot.audit,
      capabilities: await this.deps.capabilities(projectId),
      database: databaseView(snapshot.resources, snapshot.artifacts),
      api: apiView(snapshot.artifacts),
      validation: validationHistory(snapshot.artifacts),
    };
  }
  async task(projectId: string, taskId: string) {
    const status = await this.deps.service.taskStatus(projectId, taskId);
    const artifacts = status.artifacts;
    const transitions = status.transitions;
    const latestRun = status.runs.at(-1);
    const timeline = [
      ...transitions.map((value) => ({
        timestamp: value.timestamp,
        title: transitionTitle(value.to),
        kind: "STATE",
        status: value.to,
        summary: value.reason,
        details: redact(value),
      })),
      ...status.runs.map((value) => ({
        timestamp: value.startedAt,
        title: `Run ${value.status.toLowerCase()}`,
        kind: "RUN",
        status: value.status,
        summary: `${value.branch ?? "branch pending"} · ${shortSha(value.commitSha)}`,
        details: redact(value),
      })),
    ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return {
      task: status.task,
      lifecycle: stateOrder.map((state) => ({
        state,
        complete:
          stateOrder.indexOf(state) <= stateOrder.indexOf(status.task.state),
        current: state === status.task.state,
      })),
      currentRun: latestRun,
      branch: latestRun?.branch,
      commitSha: latestRun?.commitSha,
      ci: latestContent(artifacts, "CI_REPORT"),
      review: latestContent(artifacts, "REVIEW_REPORT"),
      plan: latestContent(artifacts, "IMPLEMENTATION_PLAN"),
      architecture: latestContent(artifacts, "ARCHITECTURE_REVIEW"),
      requirements: latestContent(artifacts, "REQUIREMENTS_SNAPSHOT"),
      codeChanges: latestContent(artifacts, "CODE_DIFF"),
      databaseChanges: artifacts.filter(
        (value) => value.kind === "MIGRATION_MANIFEST",
      ),
      apiChanges: artifacts.filter((value) => value.kind === "API_CONTRACT"),
      tests: artifacts.filter((value) => value.kind === "TEST_REPORT"),
      security: artifacts.filter((value) => value.kind === "SECURITY_REPORT"),
      repairHistory: status.runs.filter((_, index) => index > 0),
      finalManifest: latestContent(artifacts, "FINAL_CHANGE_MANIFEST"),
      artifacts,
      timeline,
      validation: validationHistory(artifacts),
    };
  }
  async validationHistory(projectId: string, taskId?: string) {
    await this.requireProject(projectId);
    return validationHistory(
      await this.deps.store.listArtifacts(projectId, taskId),
    );
  }
  async runValidation(projectId: string, input: unknown) {
    const data = validationRunInputSchema.parse(input);
    const project = await this.requireNonProduction(projectId);
    const task = await this.deps.store.getTask(projectId, data.taskId);
    if (!task) throw new NotFound("Task not found");
    const prior = (
      await this.deps.store.listArtifacts(projectId, data.taskId)
    ).find(
      (value) =>
        value.kind === "VALIDATION_REPORT" &&
        (value.content as { operationId?: string }).operationId ===
          data.operationId,
    );
    if (prior) return { report: prior, idempotentReplay: true };
    const planArtifact = (
      await this.deps.store.listArtifacts(projectId, data.taskId)
    )
      .filter((value) => value.kind === "IMPLEMENTATION_PLAN")
      .at(-1);
    if (!planArtifact)
      throw new InvalidState(
        "Implementation plan is required before validation",
      );
    const plan = implementationPlanSchema.parse(planArtifact.content);
    const selected = suiteTypes[data.suite].filter((type) =>
      plan.testsRequired.includes(type),
    );
    const validationPlan = { ...plan, testsRequired: selected };
    const startedAt = this.deps.clock.now();
    const report = await this.deps.tests.run(
      project.workspacePath,
      task.id,
      validationPlan,
    );
    const checks: {
      name: string;
      category: string;
      passed: boolean;
      skipped: boolean;
      summary: string;
      technical?: unknown;
    }[] = report.suites.map((suite) => ({
      name: `${suite.type} tests`,
      category: suite.type,
      passed: suite.passed,
      skipped: suite.exitCode === -1,
      summary: suite.passed
        ? "Проверка пройдена"
        : suite.exitCode === -1
          ? "Файл проверки отсутствует"
          : "Тест завершился с ошибкой",
      technical: suite,
    }));
    let schema: unknown;
    const database = (await this.deps.store.listResources(projectId)).find(
      (resource) =>
        resource.type === "DATABASE" && resource.status === "ACTIVE",
    );
    if (database && ["RLS", "FULL", "CRUD"].includes(data.suite)) {
      await this.policy.authorize({
        project,
        action: "RESOURCE_READ",
        resourceId: database.resourceId,
        requiredPermission: "READ",
        actor: "console-validator",
      });
      try {
        schema = await this.deps.database.inspectSchema(database);
        checks.push({
          name: "Database schema",
          category: "DATABASE",
          passed: true,
          skipped: false,
          summary:
            "Schema зарегистрированной sandbox database прочитана и проверена",
        });
      } catch (error) {
        checks.push({
          name: "Database schema",
          category: "DATABASE",
          passed: false,
          skipped: false,
          summary: "Не удалось проверить schema sandbox database",
          technical: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    if (
      data.suite === "FULL" &&
      database &&
      (await exists(join(project.workspacePath, "tests", "live-api.test.js")))
    ) {
      const secretRef = database.secretRefs[0];
      if (!secretRef)
        throw new PolicyViolation("Database resource has no secret reference");
      const databaseUrl = await this.deps.secrets.get(secretRef, projectId);
      const live = await this.deps.commands.run({
        command: "node",
        args: ["--test", "tests/live-api.test.js"],
        cwd: project.workspacePath,
        taskId: task.id,
        allowed: ["TEST"],
        env: { AUTOPILOT_LIVE_DATABASE_URL: databaseUrl },
      });
      checks.push({
        name: "Live sandbox API CRUD",
        category: "API",
        passed: live.record.exitCode === 0,
        skipped: false,
        summary:
          live.record.exitCode === 0
            ? "Реальный CRUD и ownership isolation прошли"
            : "Live API сценарий завершился ошибкой",
        technical: {
          exitCode: live.record.exitCode,
          stdout: redact(live.stdout),
          stderr: redact(live.stderr),
        },
      });
    }
    const passed = checks.filter((check) => check.passed).length,
      failed = checks.filter((check) => !check.passed && !check.skipped).length,
      skipped = checks.filter((check) => check.skipped).length;
    const taskArtifacts = await this.deps.store.listArtifacts(
      projectId,
      data.taskId,
    );
    const content = {
      operationId: data.operationId,
      projectId,
      taskId: data.taskId,
      commitSha: (await this.deps.store.listRuns(projectId, data.taskId)).at(-1)
        ?.commitSha,
      environment: project.environment,
      suite: data.suite,
      startedAt,
      finishedAt: this.deps.clock.now(),
      durationMs:
        new Date(this.deps.clock.now()).getTime() -
        new Date(startedAt).getTime(),
      result: failed ? "FAIL" : skipped ? "PARTIAL" : "PASS",
      counts: { passed, failed, skipped },
      humanSummary: failed
        ? `${failed} проверок завершились ошибкой. Задача не должна считаться проверенной.`
        : `${passed} проверок пройдены${skipped ? `, ${skipped} пропущены` : ""}.`,
      checks,
      schema,
      schemaDiff: summarizeSchema(schema),
      destructiveWarnings: destructiveMigrationWarnings(taskArtifacts),
    };
    const artifact = await this.artifacts.write(
      projectId,
      "VALIDATION_REPORT",
      content,
      data.taskId,
    );
    await this.persistCommands(projectId, task.id);
    await this.audit.record({
      actor: "console-operator",
      action: "validation.run",
      projectId,
      taskId: task.id,
      input: { suite: data.suite, operationId: data.operationId },
      result: {
        success: failed === 0,
        artifactId: artifact.id,
        counts: content.counts,
      },
      reason: "Operator requested a non-production validation suite",
      correlationId: data.operationId,
    });
    return { report: artifact, idempotentReplay: false };
  }
  async runApiRequest(projectId: string, input: unknown) {
    const data = apiRequestInputSchema.parse(input);
    const project = await this.requireNonProduction(projectId);
    const resource = await this.authorizeApiResource(project, data.resourceId);
    const prior = (
      await this.deps.store.listArtifacts(projectId, data.taskId)
    ).find(
      (value) =>
        value.kind === "API_REQUEST_RESULT" &&
        (value.content as { operationId?: string }).operationId ===
          data.operationId,
    );
    if (prior) return { result: prior, idempotentReplay: true };
    validateNoBrowserSecrets(data.body);
    const execution = await this.performHttpRequest(projectId, resource, data);
    const content = {
      operationId: data.operationId,
      projectId,
      taskId: data.taskId,
      environment: project.environment,
      request: execution.request,
      response: execution.response,
      validation: execution.validation,
      createdAt: this.deps.clock.now(),
    };
    const artifact = await this.artifacts.write(
      projectId,
      "API_REQUEST_RESULT",
      content,
      data.taskId,
    );
    await this.audit.record({
      actor: "console-operator",
      action: "validation.api_request",
      projectId,
      ...(data.taskId ? { taskId: data.taskId } : {}),
      resourceId: resource.resourceId,
      input: {
        method: data.method,
        path: data.path,
        operationId: data.operationId,
      },
      result: {
        success: execution.validation.passed,
        status: execution.response.status,
        artifactId: artifact.id,
      },
      reason:
        "Operator executed a request against an explicitly registered non-production API",
      correlationId: data.operationId,
    });
    return { result: artifact, idempotentReplay: false };
  }
  async saveScenario(projectId: string, input: unknown) {
    const data = validationScenarioSaveInputSchema.parse(input);
    const project = await this.requireNonProduction(projectId);
    await this.authorizeApiResource(project, data.resourceId);
    if (data.taskId && !(await this.deps.store.getTask(projectId, data.taskId)))
      throw new NotFound("Task not found");
    for (const step of data.steps) {
      validatedHeaders(step.headers);
      validateNoBrowserSecrets(step.body);
    }
    const existing = (
      await this.deps.store.listArtifacts(projectId, data.taskId)
    ).find(
      (artifact) =>
        artifact.kind === "VALIDATION_SCENARIO" &&
        (artifact.content as { operationId?: string }).operationId ===
          data.operationId,
    );
    if (existing) return { scenario: existing, idempotentReplay: true };
    const scenario = await this.artifacts.write(
      projectId,
      "VALIDATION_SCENARIO",
      scenarioForStorage(data, this.deps.clock.now()),
      data.taskId,
    );
    await this.audit.record({
      actor: "console-operator",
      action: "validation.scenario.save",
      projectId,
      ...(data.taskId ? { taskId: data.taskId } : {}),
      resourceId: data.resourceId,
      input: { name: data.name, steps: data.steps.length },
      result: { success: true, artifactId: scenario.id },
      reason: "Operator saved a non-production semantic API scenario",
      correlationId: data.operationId,
    });
    return { scenario, idempotentReplay: false };
  }
  async runScenario(projectId: string, input: unknown) {
    const data = validationScenarioRunInputSchema.parse(input);
    const project = await this.requireNonProduction(projectId);
    const definitionArtifact = await this.deps.store.getArtifact(
      projectId,
      data.scenarioArtifactId,
    );
    if (
      !definitionArtifact ||
      definitionArtifact.kind !== "VALIDATION_SCENARIO"
    )
      throw new NotFound("Validation scenario not found");
    const definition = restoreScenario(definitionArtifact.content);
    const resource = await this.authorizeApiResource(
      project,
      definition.resourceId,
    );
    const prior = (
      await this.deps.store.listArtifacts(projectId, definition.taskId)
    ).find(
      (artifact) =>
        artifact.kind === "VALIDATION_REPORT" &&
        (artifact.content as { operationId?: string }).operationId ===
          data.operationId,
    );
    if (prior) return { report: prior, idempotentReplay: true };

    const variables = new Map<string, { value: unknown; sensitive: boolean }>();
    const steps: unknown[] = [];
    let failed = false;
    const startedAt = this.deps.clock.now();
    for (const [index, step] of definition.steps.entries()) {
      if (failed) {
        steps.push({
          name: step.name,
          skipped: true,
          summary: "Skipped after prior failure",
        });
        continue;
      }
      const request: ApiRequestInput = {
        ...(definition.taskId ? { taskId: definition.taskId } : {}),
        resourceId: definition.resourceId,
        method: step.method,
        path: renderTemplate(step.path, variables),
        headers: renderTemplate(step.headers, variables),
        query: renderTemplate(step.query, variables),
        ...(step.body === undefined
          ? {}
          : { body: renderTemplate(step.body, variables) }),
        ...(step.expectedStatus === undefined
          ? {}
          : { expectedStatus: step.expectedStatus }),
        operationId: `${data.operationId}-step-${index + 1}`,
      };
      const bearer = step.bearerFrom
        ? requiredBearer(variables, step.bearerFrom)
        : undefined;
      const execution = await this.performHttpRequest(
        projectId,
        resource,
        request,
        bearer,
      );
      for (const [name, extraction] of Object.entries(step.extract)) {
        const value = extractResponseValue(execution.rawBody, extraction.path);
        const sensitive =
          extraction.sensitive ||
          secretLike(name) ||
          secretLike(extraction.path);
        variables.set(name, { value, sensitive });
      }
      failed = !execution.validation.passed;
      steps.push({
        name: step.name,
        request: execution.request,
        response: execution.response,
        validation: execution.validation,
        extracted: Object.fromEntries(
          Object.entries(step.extract).map(([name, extraction]) => [
            name,
            extraction.sensitive ||
            secretLike(name) ||
            secretLike(extraction.path)
              ? "[REDACTED]"
              : variables.get(name)?.value,
          ]),
        ),
      });
    }
    const passedCount = steps.filter(
      (step) =>
        typeof step === "object" &&
        step !== null &&
        (step as { validation?: { passed?: boolean } }).validation?.passed,
    ).length;
    const skippedCount = steps.filter(
      (step) => typeof step === "object" && step !== null && "skipped" in step,
    ).length;
    const content = {
      operationId: data.operationId,
      projectId,
      taskId: definition.taskId,
      environment: project.environment,
      suite: "SCENARIO",
      scenarioArtifactId: definitionArtifact.id,
      scenarioName: definition.name,
      startedAt,
      finishedAt: this.deps.clock.now(),
      result: failed ? "FAIL" : "PASS",
      counts: {
        passed: passedCount,
        failed: failed ? 1 : 0,
        skipped: skippedCount,
      },
      humanSummary: failed
        ? `Сценарий «${definition.name}» остановлен на ошибочном шаге.`
        : `Сценарий «${definition.name}»: ${passedCount} шагов пройдено.`,
      steps,
    };
    const report = await this.artifacts.write(
      projectId,
      "VALIDATION_REPORT",
      content,
      definition.taskId,
    );
    await this.audit.record({
      actor: "console-operator",
      action: "validation.scenario.run",
      projectId,
      ...(definition.taskId ? { taskId: definition.taskId } : {}),
      resourceId: resource.resourceId,
      input: {
        scenarioArtifactId: definitionArtifact.id,
        operationId: data.operationId,
      },
      result: {
        success: !failed,
        artifactId: report.id,
        counts: content.counts,
      },
      reason: "Operator executed a persisted non-production API scenario",
      correlationId: data.operationId,
    });
    return { report, idempotentReplay: false };
  }
  private async authorizeApiResource(project: Project, resourceId: string) {
    const resource = await this.deps.store.getResource(resourceId);
    if (
      !resource ||
      resource.projectId !== project.id ||
      resource.type !== "HTTP_API"
    )
      throw new PolicyViolation(
        "API Request Runner requires a project-owned HTTP_API resource",
      );
    await this.policy.authorize({
      project,
      action: "NETWORK",
      resourceId: resource.resourceId,
      requiredPermission: "READ",
      actor: "console-api-runner",
    });
    return resource;
  }
  private async performHttpRequest(
    projectId: string,
    resource: Resource,
    data: ApiRequestInput,
    bearer?: string,
  ) {
    const base = validatedBase(resource);
    if (data.path.startsWith("//"))
      throw new PolicyViolation("Protocol-relative API paths are forbidden");
    const url = new URL(data.path, base);
    if (url.origin !== base.origin)
      throw new PolicyViolation(
        "API request cannot leave the registered origin",
      );
    for (const [key, value] of Object.entries(data.query))
      url.searchParams.set(key, value);
    const headers = validatedHeaders(data.headers);
    const serverBearer =
      bearer ??
      (resource.secretRefs[0]
        ? await this.deps.secrets.get(resource.secretRefs[0], projectId)
        : undefined);
    if (serverBearer) headers.set("authorization", `Bearer ${serverBearer}`);
    const started = performance.now();
    const requestBody =
      data.body === undefined || ["GET", "HEAD"].includes(data.method)
        ? undefined
        : JSON.stringify(data.body);
    const response = await fetch(url, {
      method: data.method,
      headers,
      ...(requestBody === undefined ? {} : { body: requestBody }),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await response.text();
    const durationMs = Math.round(performance.now() - started);
    let rawBody: unknown = raw;
    try {
      rawBody = JSON.parse(raw);
    } catch {
      /* plain response */
    }
    const passed =
      data.expectedStatus === undefined ||
      response.status === data.expectedStatus;
    return {
      rawBody,
      request: {
        method: data.method,
        url: `${base.origin}${url.pathname}${url.search}`,
        headers: redact(Object.fromEntries(headers)),
        body: redact(data.body),
      },
      response: {
        status: response.status,
        durationMs,
        headers: redact(safeResponseHeaders(response.headers)),
        body: redact(rawBody),
      },
      validation: {
        passed,
        expectedStatus: data.expectedStatus,
        humanSummary: passed
          ? `Получен ожидаемый HTTP ${response.status}`
          : `Ожидался HTTP ${data.expectedStatus}, фактически получен HTTP ${response.status}`,
      },
    };
  }
  private async projectCard(project: Project) {
    const [tasks, runs, resources, audit, artifacts] = await Promise.all([
      this.deps.store.listTasks(project.id),
      this.deps.store.listRuns(project.id),
      this.deps.store.listResources(project.id),
      this.deps.store.listAudit(project.id),
      this.deps.store.listArtifacts(project.id),
    ]);
    const repository = resources.find(
      (resource) =>
        resource.type === "GITHUB_REPOSITORY" ||
        resource.type === "GIT_REPOSITORY",
    );
    const database = resources.find((resource) => resource.type === "DATABASE");
    const ci = artifacts.filter((value) => value.kind === "CI_REPORT").at(-1);
    return {
      id: project.id,
      name: project.name,
      slug: project.slug,
      environment: project.environment,
      autonomyMode: project.autonomyMode,
      status: project.status,
      repository: repository?.externalReference,
      databaseProvider: database?.provider,
      databaseProject: resources.find(
        (resource) => resource.type === "SUPABASE_PROJECT",
      )?.externalReference,
      taskSource:
        resources.find((resource) => resource.type === "TASK_SOURCE")
          ?.provider ?? project.sourceType,
      createdAt: project.createdAt,
      lastActivity: [
        project.updatedAt,
        ...audit.map((value) => value.timestamp),
      ]
        .sort()
        .at(-1),
      tasks,
      runs,
      latestCi: ci?.content,
      warningCount: artifacts.filter(
        (value) =>
          value.kind === "REVIEW_REPORT" &&
          (value.content as { warnings?: unknown[] }).warnings?.length,
      ).length,
      recentEvents: audit.slice(-8),
    };
  }
  private async taskSummary(projectId: string, taskId: string) {
    const status = await this.deps.service.taskStatus(projectId, taskId);
    const run = status.runs.at(-1);
    return {
      ...status.task,
      currentRun: run,
      branch: run?.branch,
      commitSha: run?.commitSha,
      ci: latestContent(status.artifacts, "CI_REPORT"),
      review: latestContent(status.artifacts, "REVIEW_REPORT"),
      artifactCount: status.artifacts.length,
      warnings: status.artifacts
        .filter((value) => value.kind === "REVIEW_REPORT")
        .flatMap(
          (value) => (value.content as { warnings?: unknown[] }).warnings ?? [],
        ),
    };
  }
  private async requireProject(projectId: string) {
    const project = await this.deps.store.getProject(projectId);
    if (!project) throw new NotFound("Project not found");
    return project;
  }
  private async requireNonProduction(projectId: string) {
    const project = await this.requireProject(projectId);
    if (
      project.environment === "PRODUCTION" ||
      project.autonomyMode === "AUTONOMOUS_PRODUCTION"
    )
      throw new UnsupportedOperation(
        "Production validation/write actions are NOT_SUPPORTED",
      );
    return project;
  }
  private async persistCommands(projectId: string, taskId: string) {
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
          )
        : undefined;
      const stderr = entry.stderr
        ? await this.artifacts.write(
            projectId,
            "COMMAND_STDERR",
            entry.stderr,
            taskId,
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
    );
  }
}

function latestContent(artifacts: Artifact[], kind: Artifact["kind"]) {
  return artifacts.filter((value) => value.kind === kind).at(-1)?.content;
}
function validationHistory(artifacts: Artifact[]) {
  return artifacts
    .filter((value) =>
      [
        "VALIDATION_REPORT",
        "API_REQUEST_RESULT",
        "VALIDATION_SCENARIO",
      ].includes(value.kind),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function safeResource(resource: Resource) {
  return {
    ...resource,
    secretRefs: resource.secretRefs.map(() => "[SERVER_SIDE_SECRET]"),
  };
}
function shortSha(value?: string) {
  return value?.slice(0, 8) ?? "not committed";
}
function transitionTitle(state: string) {
  return state === "READY"
    ? "Задача готова"
    : state === "BLOCKED"
      ? "Задача заблокирована"
      : state === "FAILED"
        ? "Выполнение завершилось ошибкой"
        : `Переход в ${state}`;
}
function databaseView(resources: Resource[], artifacts: Artifact[]) {
  const database = resources.find((value) => value.type === "DATABASE");
  const bootstrap = latestContent(artifacts, "BOOTSTRAP_REPORT") as
    | { database?: { schema?: unknown } }
    | undefined;
  const validation = artifacts
    .filter((value) => value.kind === "VALIDATION_REPORT")
    .map((value) => value.content as { schema?: unknown; schemaDiff?: unknown })
    .filter((value) => value.schema)
    .at(-1);
  const schema = publicSchemaView(validation?.schema ?? bootstrap?.database?.schema);
  return {
    provider: database?.provider,
    status: database?.status,
    migrations: artifacts.filter(
      (value) => value.kind === "MIGRATION_MANIFEST",
    ),
    schema,
    schemaDiff: validation?.schemaDiff ?? summarizeSchema(schema),
  };
}
function publicSchemaView(schema: unknown) {
  if (!schema || typeof schema !== "object") return undefined;
  const value = schema as Record<string, unknown>;
  const publicRows = (name: string) =>
    Array.isArray(value[name])
      ? (value[name] as Array<Record<string, unknown>>).filter((row) =>
          [row.table_schema, row.schemaname, row.routine_schema].some(
            (schemaName) => schemaName === "public",
          ),
        )
      : [];
  return {
    tables: publicRows("tables"),
    columns: publicRows("columns"),
    indexes: publicRows("indexes"),
    policies: publicRows("policies"),
    functions: publicRows("functions"),
  };
}
function apiView(artifacts: Artifact[]) {
  return {
    contracts: artifacts.filter((value) => value.kind === "API_CONTRACT"),
    requests: artifacts.filter((value) => value.kind === "API_REQUEST_RESULT"),
  };
}
function validatedBase(resource: Resource) {
  const url = new URL(resource.externalReference);
  if (url.username || url.password)
    throw new PolicyViolation("HTTP_API URL cannot contain credentials");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    )
  )
    throw new PolicyViolation("Sandbox API must use HTTPS or loopback HTTP");
  return url;
}
function validatedHeaders(input: Record<string, string>) {
  const headers = new Headers({ "content-type": "application/json" });
  for (const [key, value] of Object.entries(input)) {
    if (/^(authorization|cookie|proxy-authorization|x-api-key)$/i.test(key))
      throw new PolicyViolation(
        "Browser-supplied secret-bearing headers are forbidden",
      );
    if (!/^[a-z0-9-]{1,64}$/i.test(key) || /[\r\n]/.test(value))
      throw new PolicyViolation("Unsafe request header");
    headers.set(key, value);
  }
  return headers;
}
function safeResponseHeaders(headers: Headers) {
  return Object.fromEntries(
    [...headers].filter(
      ([key]) =>
        !["set-cookie", "www-authenticate"].includes(key.toLowerCase()),
    ),
  );
}
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
function summarizeSchema(schema: unknown) {
  if (!schema || typeof schema !== "object") return [];
  const value = schema as {
    tables?: Array<{ table_schema: string; table_name: string }>;
    columns?: Array<{
      table_schema: string;
      table_name: string;
      column_name: string;
    }>;
    indexes?: Array<{
      schemaname: string;
      tablename: string;
      indexname: string;
    }>;
    policies?: Array<{
      schemaname: string;
      tablename: string;
      policyname: string;
    }>;
  };
  return [
    ...(value.tables ?? []).map(
      (row) => `+ table ${row.table_schema}.${row.table_name}`,
    ),
    ...(value.columns ?? []).map(
      (row) =>
        `+ column ${row.table_schema}.${row.table_name}.${row.column_name}`,
    ),
    ...(value.indexes ?? []).map(
      (row) => `+ index ${row.schemaname}.${row.tablename}.${row.indexname}`,
    ),
    ...(value.policies ?? []).map(
      (row) =>
        `+ RLS policy ${row.schemaname}.${row.tablename}.${row.policyname}`,
    ),
  ];
}
function destructiveMigrationWarnings(artifacts: Artifact[]) {
  return artifacts
    .filter((value) => value.kind === "MIGRATION_MANIFEST")
    .flatMap((value) => {
      const text = JSON.stringify(value.content);
      return [
        ...text.matchAll(
          /\b(DROP\s+(?:TABLE|COLUMN)|TRUNCATE|ALTER\s+TYPE)\b/gi,
        ),
      ].map(
        (match) =>
          `Destructive migration statement requires manual review: ${match[0].toUpperCase()}`,
      );
    });
}

type ScenarioVariables = Map<string, { value: unknown; sensitive: boolean }>;
function scenarioForStorage(
  definition: ValidationScenarioSaveInput,
  createdAt: string,
) {
  return {
    ...definition,
    steps: definition.steps.map((step) => ({
      ...step,
      extract: Object.entries(step.extract).map(([variable, extraction]) => ({
        variable,
        ...extraction,
      })),
    })),
    createdAt,
  };
}
function restoreScenario(content: unknown) {
  if (!content || typeof content !== "object")
    throw new InvalidState("Stored validation scenario is invalid");
  const stored = content as {
    steps?: Array<{
      extract?: Array<{
        variable: string;
        path: string;
        sensitive: boolean;
      }>;
    }>;
  };
  if (!Array.isArray(stored.steps))
    throw new InvalidState("Stored validation scenario has no steps");
  return validationScenarioSaveInputSchema.parse({
    ...content,
    steps: stored.steps.map((step) => ({
      ...step,
      extract: Object.fromEntries(
        (step.extract ?? []).map(({ variable, ...extraction }) => [
          variable,
          extraction,
        ]),
      ),
    })),
  });
}
function renderTemplate<T>(value: T, variables: ScenarioVariables): T {
  if (typeof value === "string") {
    const exact = /^\{\{([a-z][a-z0-9_]{0,63})\}\}$/.exec(value);
    if (exact?.[1]) return templateValue(exact[1], variables) as T;
    return value.replace(
      /\{\{([a-z][a-z0-9_]{0,63})\}\}/g,
      (_match, name: string) => String(templateValue(name, variables)),
    ) as T;
  }
  if (Array.isArray(value))
    return value.map((entry) => renderTemplate(entry, variables)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        renderTemplate(entry, variables),
      ]),
    ) as T;
  return value;
}
function templateValue(name: string, variables: ScenarioVariables) {
  const variable = variables.get(name);
  if (!variable) throw new InvalidState(`Scenario variable ${name} is missing`);
  if (variable.sensitive)
    throw new PolicyViolation(
      `Sensitive scenario variable ${name} may only be used as bearerFrom`,
    );
  return variable.value;
}
function requiredBearer(variables: ScenarioVariables, name: string) {
  const variable = variables.get(name);
  if (!variable)
    throw new InvalidState(`Scenario bearer variable ${name} is missing`);
  if (typeof variable.value !== "string" || !variable.value)
    throw new InvalidState(`Scenario bearer variable ${name} is not a string`);
  return variable.value;
}
function extractResponseValue(body: unknown, path: string) {
  const segments = path.split(".").slice(2);
  let value = body;
  for (const segment of segments) {
    if (!value || typeof value !== "object" || !(segment in value))
      throw new InvalidState(`Scenario extraction path ${path} was not found`);
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}
function secretLike(value: string) {
  return /(token|secret|password|authorization|api[_-]?key)/i.test(value);
}
function validateNoBrowserSecrets(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) validateNoBrowserSecrets(entry);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (secretLike(key))
      throw new PolicyViolation(
        "Browser-supplied secret-bearing request fields are forbidden",
      );
    validateNoBrowserSecrets(entry);
  }
}
