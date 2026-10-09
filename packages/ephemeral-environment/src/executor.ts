// Executes an EnvironmentPlan: dependencies, build, start, health, collection, teardown.
//
// This runs inside the environment job of the HTTP E2E workflow (ADR 018) -- the one job that
// holds no control-plane secret and no token, because it is the one that runs the project's own
// code. The project's code only ever runs inside containers through `ContainerRuntime`; this
// orchestrator runs on the runner and talks to the application over the published loopback port.
//
// Every failure is classified, so what follows is a diagnosis of a named cause rather than a
// blind retry, and every log that leaves the environment is tail-bounded and scrubbed of the
// throwaway credentials generated for this run.
import { randomBytes } from "node:crypto";
import { redact } from "../../audit/src/index.js";
import { ArtifactStore } from "../../artifact-store/src/index.js";
import { createService } from "../../core/src/runtime.js";
import { systemClock, uuidGenerator } from "../../core/src/ports.js";
import {
  HttpCollectionRunner,
  type ApiInventory,
  type CollectionExecutionResult,
  type ImportedScenario,
} from "../../http-runner/src/collection.js";
import { scenarioForStorage, scenarioHttpRunnerLimits } from "../../http-runner/src/index.js";
import { MemoryStateStore } from "../../project-registry/src/memory-store.js";
import { validationScenarioSaveInputSchema } from "../../schemas/src/index.js";
import {
  ENVIRONMENT_EVIDENCE_VERSION,
  environmentEvidenceSchema,
  type EnvironmentEvidence,
  type FailureClass,
} from "./evidence.js";
import { compareExecutions, stepsFromReports } from "./parity.js";
import { planIsExecutable, type DependencyKind, type EnvironmentPlan } from "./plan.js";

export { ENVIRONMENT_EVIDENCE_VERSION, environmentEvidenceSchema, failureClassSchema, type EnvironmentEvidence, type FailureClass } from "./evidence.js";

/** Where the application is reached from the runner. Scenarios target this loopback origin. */
export const APPLICATION_HOST_PORT = 18080;
const LOG_TAIL_BYTES = 16 * 1024;

export interface StepOutcome {
  exitCode: number;
  output: string;
  durationMs: number;
}

/** The only way the orchestrator touches containers. Docker in CI, a fake in tests. */
export interface ContainerRuntime {
  prepare(input: { network: string; cacheVolume: string }): Promise<void>;
  startService(input: { name: string; image: string; env: Record<string, string>; network: string }): Promise<void>;
  exec(input: { name: string; argv: string[]; env?: Record<string, string> }): Promise<StepOutcome>;
  runStep(input: { name: string; image: string; argv: string[]; env: Record<string, string>; workdir: string; network: string; cacheVolume: string }): Promise<StepOutcome>;
  startApplication(input: {
    name: string;
    image: string;
    argv: string[];
    env: Record<string, string>;
    workdir: string;
    network: string;
    cacheVolume: string;
    containerPort: number;
    hostPort: number;
  }): Promise<void>;
  isRunning(name: string): Promise<boolean>;
  logs(name: string, tailLines: number): Promise<string>;
  cleanup(input: { names: string[]; network: string; cacheVolume: string }): Promise<void>;
}

type Step = EnvironmentEvidence["steps"][number];

interface Credentials {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}
const dependencyRuntime: Record<DependencyKind, { port: number; env: (c: Credentials) => Record<string, string>; ready: (c: Credentials) => { argv: string[]; env?: Record<string, string> } }> = {
  POSTGRES: {
    port: 5432,
    env: (c) => ({ POSTGRES_USER: c.user, POSTGRES_PASSWORD: c.password, POSTGRES_DB: c.database }),
    ready: (c) => ({ argv: ["pg_isready", "-h", "127.0.0.1", "-U", c.user, "-d", c.database] }),
  },
  MYSQL: {
    port: 3306,
    env: (c) => ({ MYSQL_USER: c.user, MYSQL_PASSWORD: c.password, MYSQL_DATABASE: c.database, MYSQL_ROOT_PASSWORD: c.password }),
    // The password reaches mysqladmin through its environment, never through argv.
    ready: (c) => ({ argv: ["mysqladmin", "ping", "-h", "127.0.0.1", "-u", c.user, "--silent"], env: { MYSQL_PWD: c.password } }),
  },
  REDIS: { port: 6379, env: () => ({}), ready: () => ({ argv: ["redis-cli", "ping"] }) },
  MONGO: { port: 27017, env: () => ({}), ready: () => ({ argv: ["mongosh", "--quiet", "--eval", "db.runCommand({ ping: 1 })"] }) },
};

// Package caches live on a volume shared by every step, so the build step finds what install
// downloaded and the run step does not download it again. Python packages go into the workspace
// itself, because a fresh container's site-packages would not survive into the next step.
function toolchainEnv(workdir: string): Record<string, string> {
  return {
    GRADLE_USER_HOME: "/cache/gradle",
    MAVEN_OPTS: "-Dmaven.repo.local=/cache/m2",
    npm_config_cache: "/cache/npm",
    npm_config_store_dir: "/cache/pnpm-store",
    COREPACK_HOME: "/cache/corepack",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    YARN_CACHE_FOLDER: "/cache/yarn",
    PIP_CACHE_DIR: "/cache/pip",
    PIP_TARGET: `${workdir}/.autopilot/python`,
    PYTHONPATH: `${workdir}/.autopilot/python`,
    GOMODCACHE: "/cache/go/mod",
    GOCACHE: "/cache/go/build",
    CI: "true",
  };
}

function tail(text: string, scrub: (value: string) => string): string {
  const clean = scrub(text);
  return clean.length > LOG_TAIL_BYTES ? `…${clean.slice(-LOG_TAIL_BYTES)}` : clean;
}

export interface ExecuteEnvironmentInput {
  plan: EnvironmentPlan;
  scenarios: ImportedScenario[];
  inventory?: ApiInventory;
  runtime: ContainerRuntime;
  /** Unique per run; prefixes every container, the network and the cache volume. */
  runId: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  dependencyTimeoutMs?: number;
  /** Loopback port the application is published on; APPLICATION_HOST_PORT unless a test needs another. */
  hostPort?: number;
}

/** Runs the whole environment once and always tears it down. Never throws for a project failure. */
export async function executeEnvironment(input: ExecuteEnvironmentInput): Promise<EnvironmentEvidence> {
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const call = input.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const started = now();
  const startedAt = new Date(started).toISOString();
  const prefix = `ap-${input.runId.replace(/[^a-z0-9-]/gi, "").toLowerCase().slice(0, 24) || "run"}`;
  const network = `${prefix}-net`;
  const cacheVolume = `${prefix}-cache`;
  const steps: Step[] = [];
  const containers: string[] = [];
  const secrets: string[] = [];
  const scrub = (text: string) => {
    let value = text;
    for (const secret of secrets) value = value.split(secret).join("[REDACTED]");
    return String(redact(value));
  };
  const plan = input.plan;
  const workdir = `/workspace${plan.root ? `/${plan.root}` : ""}`;
  const appName = `${prefix}-app`;
  const hostPort = input.hostPort ?? APPLICATION_HOST_PORT;
  let failure: EnvironmentEvidence["outcome"]["failure"];
  let health: EnvironmentEvidence["health"];
  let applicationLogTail: string | undefined;
  let collection: CollectionExecutionResult | undefined;
  let scenarioReports: unknown[] = [];
  const fail = (failureClass: FailureClass, step: string, message: string) => {
    failure ??= { class: failureClass, step, message: scrub(message).slice(0, 2000) };
  };

  const finish = (): EnvironmentEvidence => {
    const reasons = failure ? [`${failure.class} at ${failure.step}: ${failure.message}`] : [];
    if (collection) for (const reason of collection.reasons) if (!reasons.includes(reason)) reasons.push(reason);
    return environmentEvidenceSchema.parse({
      evidenceVersion: ENVIRONMENT_EVIDENCE_VERSION,
      startedAt,
      completedAt: new Date(now()).toISOString(),
      durationMs: Math.max(0, now() - started),
      plan: redact(plan),
      outcome: { verdict: !failure && collection?.verdict === "PROVEN" ? "PROVEN" : "NOT_PROVEN", ...(failure ? { failure } : {}), reasons },
      steps,
      ...(health ? { health } : {}),
      ...(applicationLogTail !== undefined ? { applicationLogTail } : {}),
      ...(collection ? { collection: redact(collection) } : {}),
      scenarioReports,
    });
  };

  if (!planIsExecutable(plan)) {
    const first = plan.unresolved[0];
    fail("PLAN_UNRESOLVED", first?.field ?? "plan", first ? `${first.reason}; ${first.remediation}` : "the plan has no run command or image");
    return finish();
  }
  if (!input.scenarios.length) {
    // Nothing to send means nothing to prove; building the application would only spend minutes.
    fail("NO_SCENARIOS", "collection", "no scenarios were supplied: import the project's Postman collection or add scenarios for the uncovered operations");
    return finish();
  }

  // Credentials for this run only, substituted into every {{kind.field}} template.
  const credentials = new Map<string, Credentials>();
  for (const dependency of plan.dependencies) {
    const key = dependency.kind.toLowerCase();
    const password = randomBytes(18).toString("hex");
    secrets.push(password);
    credentials.set(key, { host: `${prefix}-${key}`, port: dependencyRuntime[dependency.kind].port, user: "autopilot", password, database: "autopilot" });
  }
  const unknownReference: string[] = [];
  const resolve = (value: string) =>
    value.replace(/\{\{([a-z]+)\.(host|port|user|password|database|url)\}\}/g, (match, kind: string, field: keyof Credentials) => {
      const values = credentials.get(kind);
      if (!values) {
        unknownReference.push(match);
        return match;
      }
      return String(values[field]);
    });
  const appEnv = Object.fromEntries(Object.entries(plan.env).map(([key, value]) => [key, resolve(value)]));
  if (unknownReference.length) {
    fail("PLAN_UNRESOLVED", "env", `the environment references ${[...new Set(unknownReference)].join(", ")} but that dependency is not provisioned; declare it under "dependencies" in .autopilot/environment.yml`);
    return finish();
  }
  const stepEnv = { ...toolchainEnv(workdir), ...appEnv };

  try {
    try {
      await input.runtime.prepare({ network, cacheVolume });
    } catch (error) {
      // No container runtime is a fact about the environment, not about the project -- and it is
      // still NOT_PROVEN: an environment that could not be built proved nothing.
      fail("INFRASTRUCTURE_UNAVAILABLE", "prepare", `the container runtime is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return finish();
    }
    for (const dependency of plan.dependencies) {
      const key = dependency.kind.toLowerCase();
      const values = credentials.get(key) as Credentials;
      const behaviour = dependencyRuntime[dependency.kind];
      const name = values.host;
      const begin = now();
      try {
        await input.runtime.startService({ name, image: dependency.image, env: behaviour.env(values), network });
        containers.push(name);
      } catch (error) {
        steps.push({ phase: "dependency", name: dependency.kind, status: "FAILED", durationMs: now() - begin, logTail: tail(error instanceof Error ? error.message : String(error), scrub) });
        fail("DEPENDENCY_UNAVAILABLE", dependency.kind, `${dependency.image} could not be started`);
        return finish();
      }
      const probe = behaviour.ready(values);
      let ready = false;
      while (now() - begin < (input.dependencyTimeoutMs ?? 120_000)) {
        const outcome = await input.runtime.exec({ name, argv: probe.argv, ...(probe.env ? { env: probe.env } : {}) }).catch(() => undefined);
        if (outcome?.exitCode === 0) {
          ready = true;
          break;
        }
        await sleep(2_000);
      }
      const durationMs = now() - begin;
      if (!ready) {
        steps.push({ phase: "dependency", name: dependency.kind, status: "FAILED", durationMs, logTail: tail(await input.runtime.logs(name, 200).catch(() => ""), scrub) });
        fail("DEPENDENCY_UNAVAILABLE", dependency.kind, `${dependency.image} did not become ready`);
        return finish();
      }
      steps.push({ phase: "dependency", name: dependency.kind, status: "PASSED", durationMs });
    }

    const phases: Array<["install" | "build" | "prepare", string[][]]> = [
      ["install", plan.install],
      ["build", plan.build],
      ["prepare", plan.prepare],
    ];
    for (const [phase, commands] of phases)
      for (const [index, argv] of commands.entries()) {
        const outcome = await input.runtime.runStep({ name: `${prefix}-${phase}-${index}`, image: plan.image, argv, env: stepEnv, workdir, network, cacheVolume });
        const passed = outcome.exitCode === 0;
        steps.push({ phase, name: argv.join(" "), status: passed ? "PASSED" : "FAILED", durationMs: outcome.durationMs, exitCode: outcome.exitCode, logTail: tail(outcome.output, scrub) });
        if (!passed) {
          // A failing migration or seed is a start-up failure of the environment, not of the build.
          fail(phase === "prepare" ? "ENVIRONMENT_BOOT_FAILED" : "BUILD_FAILED", `${phase}: ${argv.join(" ")}`, `exited with ${outcome.exitCode}`);
          return finish();
        }
      }

    const startBegin = now();
    try {
      await input.runtime.startApplication({
        name: appName,
        image: plan.image,
        argv: plan.run as string[],
        env: stepEnv,
        workdir,
        network,
        cacheVolume,
        containerPort: plan.port,
        hostPort,
      });
      containers.push(appName);
      steps.push({ phase: "start", name: (plan.run as string[]).join(" "), status: "PASSED", durationMs: now() - startBegin });
    } catch (error) {
      steps.push({ phase: "start", name: (plan.run as string[]).join(" "), status: "FAILED", durationMs: now() - startBegin, logTail: tail(error instanceof Error ? error.message : String(error), scrub) });
      fail("ENVIRONMENT_BOOT_FAILED", "start", "the application container could not be started");
      return finish();
    }

    // Ready means "answers HTTP below 500 on any probe": a 401 or 404 is a server that is up.
    const healthBegin = now();
    let attempts = 0;
    let ready: { path: string; status: number } | undefined;
    let exited = false;
    while (now() - healthBegin < plan.startupTimeoutSeconds * 1000) {
      attempts += 1;
      for (const path of plan.health) {
        const response = await call(`http://127.0.0.1:${hostPort}${path}`, { signal: AbortSignal.timeout(3_000) }).catch(() => undefined);
        if (response && response.status < 500) {
          ready = { path, status: response.status };
          await response.body?.cancel().catch(() => undefined);
          break;
        }
        await response?.body?.cancel().catch(() => undefined);
      }
      if (ready) break;
      if (!(await input.runtime.isRunning(appName).catch(() => false))) {
        exited = true;
        break;
      }
      await sleep(2_000);
    }
    health = { ready: Boolean(ready), ...(ready ? { path: ready.path, status: ready.status } : {}), attempts, durationMs: now() - healthBegin };
    applicationLogTail = tail(await input.runtime.logs(appName, 300).catch(() => ""), scrub);
    if (!ready) {
      steps.push({ phase: "health", name: plan.health.join(", "), status: "FAILED", durationMs: health.durationMs });
      if (exited) fail("ENVIRONMENT_BOOT_FAILED", "start", "the application exited before answering HTTP; see applicationLogTail");
      else fail("HEALTH_CHECK_FAILED", "health", `no probe (${plan.health.join(", ")}) answered below 500 within ${plan.startupTimeoutSeconds}s`);
      return finish();
    }
    steps.push({ phase: "health", name: ready.path, status: "PASSED", durationMs: health.durationMs });

    const collectionBegin = now();
    const ran = await runCollectionLocally(input.scenarios, input.inventory, input.fetchImpl, hostPort);
    collection = ran.result;
    scenarioReports = ran.reports;
    applicationLogTail = tail(await input.runtime.logs(appName, 300).catch(() => applicationLogTail ?? ""), scrub);
    steps.push({ phase: "collection", name: `${ran.result.summary.scenarios} scenario(s)`, status: ran.result.verdict === "PROVEN" ? "PASSED" : "FAILED", durationMs: now() - collectionBegin });
    if (ran.result.verdict !== "PROVEN") {
      if (ran.result.status !== "PASSED") fail("SCENARIO_FAILED", "collection", `${ran.result.summary.failedScenarios} of ${ran.result.summary.scenarios} scenario(s) did not pass`);
      else if (ran.result.coverage.incomplete.length) fail("CONTRACT_GAP", "collection", "the API inventory is incomplete; see coverage.incomplete");
      else fail("COVERAGE_INCOMPLETE", "collection", `${ran.result.coverage.uncoveredOperations} documented operation(s) have no passing request`);
    }
    return finish();
  } finally {
    await input.runtime.cleanup({ names: containers, network, cacheVolume }).catch(() => undefined);
  }
}

/**
 * The collection runs exactly as it does in the control plane -- same runner, same policy, same
 * redaction -- against an in-memory registry holding one LOCAL HTTP_API resource on the loopback
 * port. Nothing here can reach anything but that port.
 */
export async function runCollectionLocally(
  scenarios: ImportedScenario[],
  inventory: ApiInventory | undefined,
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>,
  hostPort = APPLICATION_HOST_PORT,
): Promise<{ result: CollectionExecutionResult; reports: unknown[] }> {
  const store = new MemoryStateStore();
  const service = createService({ store });
  const project = await service.projectCreate({
    name: "Ephemeral environment",
    slug: `ephemeral-${uuidGenerator.next().slice(0, 8)}`,
    sourceType: "EPHEMERAL",
    environment: "SANDBOX",
    autonomyMode: "AUTONOMOUS_STAGING",
    workspacePath: "",
  });
  const resource = await service.resourceRegister({
    projectId: project.id,
    type: "HTTP_API",
    provider: "ephemeral-environment",
    externalReference: `http://127.0.0.1:${hostPort}`,
    environment: "LOCAL",
    permissions: ["READ"],
    secretRefs: [],
  });
  const artifacts = new ArtifactStore(store, uuidGenerator, systemClock);
  for (const [index, scenario] of scenarios.entries()) {
    const value = validationScenarioSaveInputSchema.parse({ ...scenario, resourceId: resource.resourceId, operationId: `ephemeral-scenario-${index}` });
    await artifacts.write(project.id, "VALIDATION_SCENARIO", { ...scenarioForStorage(value), createdAt: systemClock.now(), collection: { index } });
  }
  const result = await new HttpCollectionRunner({
    store,
    artifacts,
    clock: systemClock,
    // Bodies are kept up to 64 KB (not the control plane's 8 KB) so a parity run can compare
    // them; anything larger is still truncated and is reported as UNCOMPARED, never as a match.
    limits: { ...scenarioHttpRunnerLimits, maxEvidenceBodyBytes: 64 * 1024 },
    ...(fetchImpl ? { fetchImpl: fetchImpl as (input: URL | string, init?: RequestInit) => Promise<Response> } : {}),
  }).run({
    projectId: project.id,
    resourceId: resource.resourceId,
    operationId: `ephemeral-run-${uuidGenerator.next()}`,
    actor: "ephemeral-environment",
    ...(inventory ? { inventory } : {}),
    inventorySource: inventory ? "REPOSITORY" : "NONE",
  });
  const reports = (await store.listArtifacts(project.id))
    .filter((artifact) => artifact.kind === "VALIDATION_REPORT" && (artifact.content as { suite?: string }).suite === "SCENARIO")
    .map((artifact) => artifact.content);
  return { result, reports };
}

/**
 * Parity: the reference implementation (for example the original Kotlin service) and the subject
 * (its Java port) each run the same scenarios in their own fresh environment -- fresh database,
 * same loopback port, one after the other -- and every response is compared. PROVEN requires the
 * subject PROVEN, the reference PROVEN and no difference at all.
 */
export async function executeComparison(
  input: ExecuteEnvironmentInput & { referencePlan: EnvironmentPlan; referenceRuntime: ContainerRuntime; referenceLabel: string },
): Promise<EnvironmentEvidence> {
  // Each implementation has its own checkout, so each gets a runtime bound to that workspace.
  const reference = await executeEnvironment({ ...input, plan: input.referencePlan, runtime: input.referenceRuntime, runId: `${input.runId}-ref` });
  const subject = await executeEnvironment({ ...input, runId: `${input.runId}-sub` });
  const parity = compareExecutions(stepsFromReports(reference.scenarioReports), stepsFromReports(subject.scenarioReports));
  const reasons = [...subject.outcome.reasons];
  let failure = subject.outcome.failure;
  if (!failure && reference.outcome.verdict !== "PROVEN")
    failure = { class: "REFERENCE_NOT_PROVEN", step: input.referenceLabel, message: reference.outcome.failure ? `${reference.outcome.failure.class}: ${reference.outcome.failure.message}` : "the reference implementation was not proven" };
  if (!failure && parity.verdict !== "MATCH")
    failure = { class: "PARITY_MISMATCH", step: "parity", message: `${parity.differenceCount} difference(s) across ${parity.comparedSteps} compared step(s); ${parity.uncomparedSteps} step(s) could not be compared` };
  if (reference.outcome.verdict !== "PROVEN") reasons.push(...reference.outcome.reasons.map((reason) => `${input.referenceLabel}: ${reason}`));
  if (parity.verdict !== "MATCH") reasons.push(`parity: ${parity.differenceCount} difference(s), ${parity.uncomparedSteps} uncompared step(s)`);
  return environmentEvidenceSchema.parse({
    ...subject,
    outcome: { verdict: failure ? "NOT_PROVEN" : "PROVEN", ...(failure ? { failure } : {}), reasons: failure ? reasons : [] },
    counterpart: {
      label: input.referenceLabel,
      plan: reference.plan,
      outcome: reference.outcome,
      steps: reference.steps,
      ...(reference.health ? { health: reference.health } : {}),
      ...(reference.applicationLogTail !== undefined ? { applicationLogTail: reference.applicationLogTail } : {}),
      ...(reference.collection ? { collection: reference.collection } : {}),
    },
    parity,
  });
}
