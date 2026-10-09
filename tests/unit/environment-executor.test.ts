import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { executeComparison, executeEnvironment, type ContainerRuntime, type StepOutcome } from "../../packages/ephemeral-environment/src/executor.js";
import { planEnvironment, type EnvironmentPlan } from "../../packages/ephemeral-environment/src/plan.js";
import { CommandPolicy } from "../../packages/execution-engine/src/command-policy.js";
import { extractApiOperations, importPostmanCollection } from "../../packages/http-runner/src/collection.js";

const fixture = "tests/fixtures/environments/node-postgres";
const read = (path: string) => readFileSync(path, "utf8");
const inventory = extractApiOperations(JSON.parse(read(`${fixture}/openapi.json`)));
const fullScenarios = importPostmanCollection(JSON.parse(read(`${fixture}/notes.postman_collection.json`))).scenarios;
const smokeScenarios = importPostmanCollection(JSON.parse(read("tests/fixtures/environments/node-postgres-smoke-only.postman_collection.json"))).scenarios;

async function fixturePlan(): Promise<EnvironmentPlan> {
  const files: Record<string, string> = { "package.json": read(`${fixture}/package.json`), "server.js": "" };
  return planEnvironment({ paths: Object.keys(files), read: async (path) => files[path] });
}

// The application under test, in-process: the same notes API the Docker self-test starts.
function notesApp(options: { healthStatus?: number; extraField?: boolean } = {}) {
  const notes = new Map<number, { id: number; title: string }>();
  let next = 0;
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const send = (status: number, value?: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(value === undefined ? "" : JSON.stringify(value));
      };
      const url = new URL(request.url ?? "/", "http://app");
      if (url.pathname === "/health") return send(options.healthStatus ?? 200, { status: "UP" });
      if (url.pathname === "/notes" && request.method === "GET") return send(200, [...notes.values()]);
      if (url.pathname === "/notes" && request.method === "POST") {
        const input = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { title?: string };
        if (!input.title) return send(400, { error: "title is required" });
        const note = { id: ++next, title: input.title };
        notes.set(note.id, note);
        return send(201, note);
      }
      const match = /^\/notes\/(\d+)$/.exec(url.pathname);
      const note = match ? notes.get(Number(match[1])) : undefined;
      if (match && request.method === "GET") return note ? send(200, options.extraField ? { ...note, archived: false } : note) : send(404, {});
      if (match && request.method === "DELETE") return note && notes.delete(note.id) ? send(204) : send(404, {});
      return send(404, {});
    });
  });
}

interface FakeOptions {
  failStep?: (phase: string) => number | undefined;
  dependencyReadyAfter?: number;
  startServer?: boolean;
  healthStatus?: number;
  extraField?: boolean;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function fakeRuntime(options: FakeOptions = {}) {
  const calls: string[] = [];
  const serviceEnv: Record<string, string> = {};
  let appEnv: Record<string, string> = {};
  let readinessProbes = 0;
  const cleaned: string[][] = [];
  let ownServer: Server | undefined;
  const runtime: ContainerRuntime = {
    async prepare() {
      calls.push("prepare");
    },
    async startService(input) {
      calls.push(`service:${input.image}`);
      Object.assign(serviceEnv, input.env);
    },
    async exec() {
      readinessProbes += 1;
      return { exitCode: readinessProbes > (options.dependencyReadyAfter ?? 0) ? 0 : 1, output: "", durationMs: 1 } satisfies StepOutcome;
    },
    async runStep(input) {
      const phase = input.name.split("-").at(-2) ?? "";
      calls.push(`step:${input.argv.join(" ")}`);
      const exitCode = options.failStep?.(phase) ?? 0;
      return { exitCode, output: `${phase} output using ${input.env["DATABASE_URL"] ?? ""}`, durationMs: 5 };
    },
    async startApplication(input) {
      calls.push(`app:${input.argv.join(" ")}`);
      appEnv = input.env;
      if (options.startServer === false) return;
      const server = notesApp({ ...(options.healthStatus === undefined ? {} : { healthStatus: options.healthStatus }), ...(options.extraField ? { extraField: true } : {}) });
      servers.push(server);
      ownServer = server;
      await new Promise<void>((resolve) => server.listen(input.hostPort, "127.0.0.1", resolve));
    },
    async isRunning() {
      return options.startServer !== false;
    },
    async logs() {
      // An application that echoes its connection string: the password must not survive it.
      return `connected with ${appEnv["DATABASE_URL"] ?? "nothing"}`;
    },
    async cleanup(input) {
      cleaned.push(input.names);
      // Like `docker rm -f`: the application stops, so the next environment can use the port.
      const server = ownServer;
      ownServer = undefined;
      if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return { runtime, calls, cleaned, serviceEnv: () => serviceEnv, appEnv: () => appEnv };
}

// A clock that jumps forward on every sleep, so timeouts are reached without waiting.
function fastClock() {
  let now = 1_000_000;
  return { now: () => now, sleep: async (ms: number) => void (now += ms) };
}

describe("ephemeral environment executor", () => {
  it("provisions PostgreSQL, builds, starts, probes and proves the whole collection", async () => {
    const fake = fakeRuntime();
    const evidence = await executeEnvironment({ plan: await fixturePlan(), scenarios: fullScenarios, inventory, runtime: fake.runtime, runId: "unit-1", hostPort: await freePort() });
    expect(evidence.outcome).toEqual({ verdict: "PROVEN", reasons: [] });
    expect(evidence.steps.map((step) => `${step.phase}:${step.status}`)).toEqual(["dependency:PASSED", "install:PASSED", "start:PASSED", "health:PASSED", "collection:PASSED"]);
    expect(fake.calls).toEqual(["prepare", "service:postgres:16-alpine", "step:npm install", "app:npm run start"]);
    expect(evidence.health).toMatchObject({ ready: true, path: "/health", status: 200 });
    const password = fake.serviceEnv()["POSTGRES_PASSWORD"] ?? "";
    expect(password).toMatch(/^[0-9a-f]{36}$/);
    expect(fake.appEnv()["DATABASE_URL"]).toBe(`postgres://autopilot:${password}@ap-unit-1-postgres:5432/autopilot`);
    expect(JSON.stringify(evidence)).not.toContain(password);
    expect(evidence.applicationLogTail).toContain("[REDACTED]");
    expect(fake.cleaned).toEqual([["ap-unit-1-postgres", "ap-unit-1-app"]]);
    expect(evidence.scenarioReports).toHaveLength(2);
  });

  it("reports a green smoke-only collection as COVERAGE_INCOMPLETE", async () => {
    const fake = fakeRuntime();
    const evidence = await executeEnvironment({ plan: await fixturePlan(), scenarios: smokeScenarios, inventory, runtime: fake.runtime, runId: "unit-2", hostPort: await freePort() });
    expect(evidence.outcome.verdict).toBe("NOT_PROVEN");
    expect(evidence.outcome.failure).toMatchObject({ class: "COVERAGE_INCOMPLETE", step: "collection" });
    expect(evidence.outcome.reasons).toContain("4 of 5 documented operations were not exercised by a passing request");
  });

  it("stops at a failing build with its output, never starts the application, and still cleans up", async () => {
    const fake = fakeRuntime({ failStep: (phase) => (phase === "install" ? 1 : undefined) });
    const evidence = await executeEnvironment({ plan: await fixturePlan(), scenarios: fullScenarios, inventory, runtime: fake.runtime, runId: "unit-3", hostPort: await freePort() });
    expect(evidence.outcome.failure).toMatchObject({ class: "BUILD_FAILED", step: "install: npm install", message: "exited with 1" });
    expect(evidence.steps.at(-1)?.logTail).toContain("install output using postgres://autopilot:[REDACTED]@");
    expect(fake.calls.some((call) => call.startsWith("app:"))).toBe(false);
    expect(fake.cleaned).toEqual([["ap-unit-3-postgres"]]);
  });

  it("classifies a dependency that never becomes ready", async () => {
    const clock = fastClock();
    const fake = fakeRuntime({ dependencyReadyAfter: Number.POSITIVE_INFINITY });
    const evidence = await executeEnvironment({ plan: await fixturePlan(), scenarios: fullScenarios, inventory, runtime: fake.runtime, runId: "unit-4", hostPort: await freePort(), ...clock });
    expect(evidence.outcome.failure).toMatchObject({ class: "DEPENDENCY_UNAVAILABLE", step: "POSTGRES" });
    expect(fake.calls).toEqual(["prepare", "service:postgres:16-alpine"]);
  });

  it("tells an application that exited apart from one that never answered", async () => {
    const exited = await executeEnvironment({ plan: await fixturePlan(), scenarios: fullScenarios, inventory, runtime: fakeRuntime({ startServer: false }).runtime, runId: "unit-5", hostPort: await freePort(), ...fastClock() });
    expect(exited.outcome.failure).toMatchObject({ class: "ENVIRONMENT_BOOT_FAILED", step: "start" });
    expect(exited.applicationLogTail).toBeDefined();
    // Only /health is probed: any other path answering below 500 would correctly count as "up".
    const plan = { ...(await fixturePlan()), health: ["/health"], startupTimeoutSeconds: 10 };
    const unhealthy = await executeEnvironment({ plan, scenarios: fullScenarios, inventory, runtime: fakeRuntime({ healthStatus: 503 }).runtime, runId: "unit-6", hostPort: await freePort(), ...fastClock() });
    expect(unhealthy.outcome.failure).toMatchObject({ class: "HEALTH_CHECK_FAILED", step: "health" });
  });

  it("treats a failing migration as a start-up failure", async () => {
    const plan = { ...(await fixturePlan()), prepare: [["npx", "prisma", "migrate", "deploy"]] };
    const evidence = await executeEnvironment({ plan, scenarios: fullScenarios, inventory, runtime: fakeRuntime({ failStep: (phase) => (phase === "prepare" ? 2 : undefined) }).runtime, runId: "unit-7", hostPort: await freePort() });
    expect(evidence.outcome.failure).toMatchObject({ class: "ENVIRONMENT_BOOT_FAILED", step: "prepare: npx prisma migrate deploy" });
  });

  it("reports an unavailable container runtime as NOT_PROVEN, not as a crash", async () => {
    const fake = fakeRuntime();
    fake.runtime.prepare = async () => {
      throw new Error("spawn docker ENOENT");
    };
    const evidence = await executeEnvironment({ plan: await fixturePlan(), scenarios: fullScenarios, inventory, runtime: fake.runtime, runId: "unit-9" });
    expect(evidence.outcome.verdict).toBe("NOT_PROVEN");
    expect(evidence.outcome.failure).toMatchObject({ class: "INFRASTRUCTURE_UNAVAILABLE", step: "prepare" });
    expect(fake.cleaned).toEqual([[]]);
  });

  it("never touches the runtime for an unresolved plan, missing scenarios or an unprovisioned reference", async () => {
    for (const [plan, scenarios, expected] of [
      [{ ...(await fixturePlan()), unresolved: [{ field: "run", reason: "no start script", remediation: "add one" }] }, fullScenarios, "PLAN_UNRESOLVED"],
      [await fixturePlan(), [], "NO_SCENARIOS"],
      [{ ...(await fixturePlan()), dependencies: [], env: { REDIS_URL: "redis://{{redis.host}}:{{redis.port}}" } }, fullScenarios, "PLAN_UNRESOLVED"],
    ] as const) {
      const fake = fakeRuntime();
      const evidence = await executeEnvironment({ plan: plan as EnvironmentPlan, scenarios: [...scenarios], inventory, runtime: fake.runtime, runId: "unit-8" });
      expect(evidence.outcome.failure?.class).toBe(expected);
      expect(fake.calls).toEqual([]);
    }
  });
});

describe("parity between two implementations", () => {
  it("proves a twin, reports a changed response, and refuses an unproven reference", async () => {
    const plan = await fixturePlan();
    const port = await freePort();
    const twin = await executeComparison({ plan, referencePlan: plan, referenceLabel: "kotlin", scenarios: fullScenarios, inventory, runtime: fakeRuntime().runtime, referenceRuntime: fakeRuntime().runtime, runId: "parity-1", hostPort: port });
    expect(twin.outcome).toEqual({ verdict: "PROVEN", reasons: [] });
    expect(twin.parity).toMatchObject({ verdict: "MATCH", comparedSteps: 7, matchedSteps: 7, differenceCount: 0 });
    expect(twin.counterpart).toMatchObject({ label: "kotlin", outcome: { verdict: "PROVEN" } });

    const variant = await executeComparison({ plan, referencePlan: plan, referenceLabel: "kotlin", scenarios: fullScenarios, inventory, runtime: fakeRuntime().runtime, referenceRuntime: fakeRuntime({ extraField: true }).runtime, runId: "parity-2", hostPort: port });
    expect(variant.outcome.failure).toMatchObject({ class: "PARITY_MISMATCH", step: "parity" });
    expect(variant.parity?.differences).toEqual([{ scenario: "Notes", step: "Read", kind: "BODY", path: "$.archived", reference: "<boolean>", subject: "<absent>" }]);

    const broken = await executeComparison({ plan, referencePlan: plan, referenceLabel: "kotlin", scenarios: fullScenarios, inventory, runtime: fakeRuntime().runtime, referenceRuntime: fakeRuntime({ failStep: (phase) => (phase === "install" ? 1 : undefined) }).runtime, runId: "parity-3", hostPort: port });
    expect(broken.outcome.failure).toMatchObject({ class: "REFERENCE_NOT_PROVEN", step: "kotlin" });
    expect(broken.outcome.reasons.some((reason) => reason.startsWith("kotlin: BUILD_FAILED"))).toBe(true);
  });
});

describe("docker command policy", () => {
  const policy = new CommandPolicy();
  const category = (...args: string[]) => policy.classify("docker", args);

  it("allows the environment's own container operations", () => {
    expect(category("run", "--rm", "--network", "ap-net", "-v", "/home/runner/work/x/src:/workspace", "-v", "ap-cache:/cache", "-w", "/workspace", "-e", "DATABASE_URL", "node:22", "npm", "ci")).toBe("ENVIRONMENT");
    expect(category("run", "-d", "-p", "127.0.0.1:18080:8080", "postgres:16-alpine")).toBe("ENVIRONMENT");
    expect(category("network", "create", "ap-net")).toBe("ENVIRONMENT");
    expect(category("inspect", "--format", "{{.State.Running}}", "ap-app")).toBe("ENVIRONMENT");
    expect(category("rm", "-f", "-v", "ap-app")).toBe("ENVIRONMENT");
  });

  it("refuses anything that reaches the host", () => {
    expect(category("run", "--privileged", "alpine")).toBe("UNKNOWN");
    expect(category("run", "-v", "/var/run/docker.sock:/var/run/docker.sock", "alpine")).toBe("UNKNOWN");
    expect(category("run", "-v", "/:/host", "alpine")).toBe("UNKNOWN");
    expect(category("run", "-v", "/etc:/x", "alpine")).toBe("UNKNOWN");
    expect(category("run", "--mount", "type=bind,source=/proc,target=/p", "alpine")).toBe("UNKNOWN");
    expect(category("run", "--network", "host", "alpine")).toBe("UNKNOWN");
    expect(category("run", "--network=host", "alpine")).toBe("UNKNOWN");
    expect(category("run", "--pid=host", "alpine")).toBe("UNKNOWN");
    expect(category("run", "--cap-add", "SYS_ADMIN", "alpine")).toBe("UNKNOWN");
    expect(category("run", "--device", "/dev/sda", "alpine")).toBe("UNKNOWN");
    expect(category("build", ".")).toBe("UNKNOWN");
    expect(category("network", "connect", "bridge", "x")).toBe("UNKNOWN");
    expect(() => policy.assertAllowed("docker", ["run", "alpine"], ["BUILD"])).toThrow(/not allowed/);
  });
});
