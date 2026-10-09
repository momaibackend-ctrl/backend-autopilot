// From a NOT_PROVEN verdict to a cause and a next step (ADR 021).
//
// A failure class says which phase broke; it does not say what to change. "BUILD_FAILED" can be a
// compile error in the change or a dependency download the network refused; "ENVIRONMENT_BOOT_FAILED"
// can be a missing variable the application expects, a database it cannot reach, or a migration
// that does not apply. Repairing without telling these apart is the blind retry this project wants
// gone. The diagnosis reads the evidence the environment already collected -- step log tails, the
// application's own log, failing scenario steps, coverage, parity differences -- and names the area
// to change (the implementation, the scenarios, .autopilot/environment.yml, the contract, the
// infrastructure or the reference), the findings that point there, and the next steps.
//
// It also carries a fingerprint of the cause, so repeated attempts can be told apart from progress.
// Pure and Web-only: the record job computes it, the control plane reads it.
import { z } from "zod";
import type { EnvironmentEvidence } from "./evidence.js";

export const repairAreaSchema = z.enum(["IMPLEMENTATION", "SCENARIOS", "ENVIRONMENT_MANIFEST", "CONTRACT", "INFRASTRUCTURE", "REFERENCE"]);
export type RepairArea = z.infer<typeof repairAreaSchema>;
export const diagnosisSchema = z.object({
  failureClass: z.string(),
  area: repairAreaSchema,
  summary: z.string(),
  findings: z.array(z.object({ kind: z.string(), detail: z.string() })),
  nextSteps: z.array(z.string()).min(1),
  /** Stable for the same cause, different for a different one; free of run-specific values. */
  fingerprint: z.string(),
});
export type Diagnosis = z.infer<typeof diagnosisSchema>;

const MAX_FINDINGS = 12;

/** Lines that look like the reason a build or start failed, in the order they appeared. */
export function errorLines(log: string | undefined, limit = 8): string[] {
  if (!log) return [];
  const pattern = /^\s*(e: |error[\s:[]|ERROR[\s:[]|FAILURE:|FAILED|Caused by:|Exception|.*\w+(Exception|Error):|SyntaxError|TypeError|ModuleNotFoundError|ImportError|cannot find symbol|Unresolved reference|npm ERR!|ERR_|panic:)/;
  return log
    .split(/\r?\n/)
    .filter((line) => pattern.test(line))
    .map((line) => line.trim().slice(0, 300))
    .filter((line, index, all) => all.indexOf(line) === index)
    .slice(0, limit);
}

// Run-specific noise -- numbers, hex ids, quoted values, paths -- is removed before hashing, so the
// same cause hashes the same across attempts.
function fingerprintOf(parts: string[]): string {
  const text = parts
    .join("|")
    .toLowerCase()
    .replace(/0x[0-9a-f]+|[0-9a-f]{8,}|\d+/g, "#")
    .replace(/'[^']*'|"[^"]*"/g, "'…'")
    .replace(/(\/[\w.-]+)+/g, "/…");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

interface FailingStep {
  scenario: string;
  step: string;
  method: string;
  path: string;
  status: string;
  httpStatus?: number;
  expectedStatus?: number;
  error?: string;
}

function failingSteps(reports: unknown[]): FailingStep[] {
  const found: FailingStep[] = [];
  for (const report of reports) {
    const value = report as { scenarioName?: string; steps?: Array<Record<string, unknown>> };
    for (const step of value.steps ?? []) {
      if (step["status"] !== "FAILED" && step["status"] !== "ERROR") continue;
      const error = step["error"] as { message?: string } | undefined;
      found.push({
        scenario: String(value.scenarioName ?? ""),
        step: String(step["name"] ?? ""),
        method: String(step["method"] ?? ""),
        path: String(step["path"] ?? ""),
        status: String(step["status"]),
        ...(typeof step["httpStatus"] === "number" ? { httpStatus: step["httpStatus"] } : {}),
        ...(typeof step["expectedStatus"] === "number" ? { expectedStatus: step["expectedStatus"] } : {}),
        ...(error?.message ? { error: error.message.slice(0, 300) } : {}),
      });
    }
  }
  return found;
}

/** Where a failing scenario step points, judged from what the server actually answered. */
function stepArea(step: FailingStep): { area: RepairArea; why: string } {
  if (step.error && /variable .* is missing|bearer variable/i.test(step.error))
    return { area: "SCENARIOS", why: "an earlier step did not extract a variable this step needs" };
  if (step.error && /POLICY_VIOLATION|forbidden|secret-bearing/i.test(step.error)) return { area: "SCENARIOS", why: "the step itself is refused by the runner's policy" };
  if (step.httpStatus === 401 || step.httpStatus === 403)
    return { area: "SCENARIOS", why: "authentication or authorization: the step lacks a bearer the application accepts, or the application enforces a rule the scenario does not satisfy" };
  if (step.httpStatus !== undefined && step.httpStatus >= 500) return { area: "IMPLEMENTATION", why: "the application failed while handling the request (see the application log)" };
  if (step.httpStatus === 404 && step.expectedStatus !== 404) return { area: "IMPLEMENTATION", why: "the route or the resource does not exist in this implementation" };
  if (step.httpStatus === 400 || step.httpStatus === 422) return { area: "SCENARIOS", why: "the application rejected the request body or parameters the scenario sends" };
  return { area: "IMPLEMENTATION", why: "the application answered differently from what the scenario expects" };
}

/** The cause behind a NOT_PROVEN verdict, the area to change and what to do next. */
export function diagnoseHttpE2e(evidence: EnvironmentEvidence): Diagnosis | undefined {
  const failure = evidence.outcome.failure;
  if (evidence.outcome.verdict === "PROVEN" || !failure) return undefined;
  const findings: Diagnosis["findings"] = [];
  const add = (kind: string, detail: string) => {
    if (findings.length < MAX_FINDINGS) findings.push({ kind, detail: detail.slice(0, 400) });
  };
  const failedStep = evidence.steps.find((step) => step.status === "FAILED");
  const appLog = evidence.applicationLogTail ?? "";
  const plan = (evidence.plan ?? {}) as { port?: number; health?: string[]; root?: string };
  let area: RepairArea = "IMPLEMENTATION";
  let summary = failure.message;
  const next: string[] = [];

  switch (failure.class) {
    case "PLAN_UNRESOLVED":
      area = "ENVIRONMENT_MANIFEST";
      summary = `The autopilot could not decide how to build or start the application: ${failure.message}`;
      next.push("Add or fix .autopilot/environment.yml as the message says, then verify again; superadmin_environment_plan shows the resulting plan before anything runs.");
      break;
    case "INFRASTRUCTURE_UNAVAILABLE":
      area = "INFRASTRUCTURE";
      summary = `The environment itself could not run: ${failure.message}`;
      next.push("Nothing in the project is implicated. Re-run superadmin_http_e2e_run with a new operationId; if it repeats, check the HTTP E2E workflow run linked from the job.");
      break;
    case "DEPENDENCY_UNAVAILABLE":
      area = "ENVIRONMENT_MANIFEST";
      summary = `The ${failure.step} container did not start or never became ready.`;
      for (const line of errorLines(failedStep?.logTail)) add("dependency-log", line);
      next.push(`Check the ${failure.step} image tag in docker-compose or in .autopilot/environment.yml (dependencies[].image); an unknown or private tag cannot be pulled.`);
      break;
    case "BUILD_FAILED": {
      const lines = errorLines(failedStep?.logTail, 10);
      // 126/127 mean the shell could not execute the command at all -- a missing executable bit,
      // a missing tool in the image, a wrong interpreter. That is the environment, not the code,
      // and sending the project a repair for it would be exactly the wrong fix.
      const unexecutable =
        failedStep?.exitCode === 126 ||
        failedStep?.exitCode === 127 ||
        /Permission denied|command not found|: not found|exec format error|no such file or directory/i.test(failedStep?.logTail ?? "");
      if (unexecutable) {
        area = "INFRASTRUCTURE";
        add("unexecutable-command", (failedStep?.logTail ?? "").split(/\r?\n/).find((line) => /Permission denied|not found|exec format error|no such file or directory/i.test(line))?.trim() ?? `exit code ${failedStep?.exitCode}`);
        summary = `The environment could not execute "${failure.step}" (exit ${failedStep?.exitCode ?? "?"}); the project's code was never compiled.`;
        next.push("This is the verification environment, not the project: check that the build tool exists in the image and that wrapper scripts keep their executable bit (wrappers are invoked through sh). Re-run verification once the environment is fixed; do not change the project for it.");
        break;
      }
      for (const line of lines) add("build-error", line);
      const network = /could not (resolve|get|download)|ENOTFOUND|ETIMEDOUT|ECONNRESET|Temporary failure in name resolution|Read timed out/i.test(failedStep?.logTail ?? "");
      area = network ? "INFRASTRUCTURE" : "IMPLEMENTATION";
      summary = network
        ? `The build could not download its dependencies (${failure.step}).`
        : `The build step "${failure.step}" failed${lines[0] ? `: ${lines[0]}` : ""}.`;
      next.push(
        network
          ? "Dependency download failed on the network; re-run verification. If it repeats, a private registry needs credentials the environment does not have -- declare a public mirror or vendor the dependency."
          : "Fix the compile/build error shown in the findings (it is in the commit under test), then execute the repair with a NEW operationId.",
      );
      break;
    }
    case "ENVIRONMENT_BOOT_FAILED": {
      const log = `${appLog}\n${failedStep?.logTail ?? ""}`;
      const placeholder = /Could not resolve placeholder '([^']+)'|environment variable ['"]?([A-Z][A-Z0-9_]+)['"]? (?:is )?(?:not set|missing|required)|Missing required (?:configuration|env(?:ironment)? variable)[: ]+['"]?([A-Za-z0-9_.-]+)/i.exec(log);
      if (failure.step.startsWith("prepare")) {
        area = "IMPLEMENTATION";
        summary = `A migration or preparation step failed: ${failure.step}.`;
        for (const line of errorLines(failedStep?.logTail)) add("prepare-error", line);
        next.push("Fix the migration or seed it names (it runs against a fresh database), then execute the repair with a NEW operationId.");
      } else if (placeholder) {
        area = "ENVIRONMENT_MANIFEST";
        const name = placeholder[1] ?? placeholder[2] ?? placeholder[3] ?? "";
        summary = `The application expects configuration "${name}" that the environment does not provide.`;
        add("missing-configuration", name);
        next.push(`Declare ${name} in .autopilot/environment.yml under env (use {{postgres.url}}-style templates for dependency values, never a literal secret).`);
      } else if (/password authentication failed|Access denied for user|authentication failed/i.test(log)) {
        area = "ENVIRONMENT_MANIFEST";
        summary = "The application reached its database but with credentials other than the generated ones.";
        next.push("The application reads its database credentials from variables the environment does not set. Map them in .autopilot/environment.yml env to {{postgres.user}} / {{postgres.password}}.");
      } else if (/ECONNREFUSED|Connection refused|Connection to \S+ refused|could not connect to server|UnknownHostException|ENOTFOUND|getaddrinfo/i.test(log)) {
        area = "ENVIRONMENT_MANIFEST";
        summary = "The application could not reach a dependency: it is connecting to an address the environment does not provide (often localhost).";
        next.push("The application reads its connection settings from variables the environment does not set. Declare them in .autopilot/environment.yml env using {{postgres.host}}/{{postgres.port}} (or the matching dependency).");
      } else if (/Address already in use|EADDRINUSE/i.test(log)) {
        area = "ENVIRONMENT_MANIFEST";
        summary = "The application could not bind its port.";
        next.push("Set the port the application listens on in .autopilot/environment.yml (port).");
      } else if (/(flyway|liquibase|migration|migrate)[^\n]*(fail|error)|relation "?[\w.]+"? does not exist|Table '[^']+' doesn't exist/i.test(log)) {
        area = "IMPLEMENTATION";
        summary = "The application failed while applying or relying on its database schema.";
        next.push("Fix the migration or the schema assumption shown in the findings, then execute the repair with a NEW operationId.");
      } else {
        area = "IMPLEMENTATION";
        summary = "The application exited before answering HTTP.";
        next.push("Read the application log in the findings, fix the start-up failure, then execute the repair with a NEW operationId.");
      }
      for (const line of errorLines(appLog)) add("application-log", line);
      break;
    }
    case "HEALTH_CHECK_FAILED": {
      area = "ENVIRONMENT_MANIFEST";
      const listening = /(?:listening|started|running)\b[^\n]*?(?:port|:)\s*(\d{2,5})/i.exec(appLog);
      if (listening && plan.port !== undefined && Number(listening[1]) !== plan.port) {
        add("port-mismatch", `the application reports port ${listening[1]}, the environment expects ${plan.port}`);
        summary = `The application listens on port ${listening[1]}, not on ${plan.port}.`;
        next.push(`Set port: ${listening[1]} in .autopilot/environment.yml (or make the application honour PORT/SERVER_PORT).`);
      } else {
        summary = `The application kept running but no health probe answered below 500 (${(plan.health ?? []).join(", ")}).`;
        next.push("Declare the application's real health path in .autopilot/environment.yml (health), or check the application log for a start-up that never completes.");
      }
      for (const line of errorLines(appLog)) add("application-log", line);
      break;
    }
    case "NO_SCENARIOS":
      area = "SCENARIOS";
      summary = "There was nothing to send: no scenarios.";
      next.push("Commit the project's Postman collection, or import it with superadmin_collection_import and run with scenarioSource SAVED; superadmin_api_coverage drafts a step for every operation.");
      break;
    case "SCENARIO_FAILED": {
      const steps = failingSteps(evidence.scenarioReports);
      const votes = new Map<RepairArea, number>();
      for (const step of steps) {
        const judged = stepArea(step);
        votes.set(judged.area, (votes.get(judged.area) ?? 0) + 1);
        add(
          "failing-step",
          `${step.scenario} › ${step.step}: ${step.method} ${step.path} answered ${step.httpStatus ?? step.status}${step.expectedStatus !== undefined ? `, expected ${step.expectedStatus}` : ""}${step.error ? ` (${step.error})` : ""} -- ${judged.why}`,
        );
      }
      area = [...votes.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "IMPLEMENTATION";
      summary = `${steps.length} scenario step(s) failed; most point to ${area === "IMPLEMENTATION" ? "the implementation" : "the scenarios"}.`;
      for (const line of errorLines(appLog, 4)) add("application-log", line);
      next.push(
        area === "IMPLEMENTATION"
          ? "Fix the behaviour each failing step shows (route, status, payload), then execute the repair with a NEW operationId."
          : "Fix the scenarios: credentials go through the resource secretRef or a bearerFrom extracted by an earlier step; request bodies must satisfy the contract. Re-import or update the scenarios, then verify again.",
      );
      break;
    }
    case "COVERAGE_INCOMPLETE": {
      area = "SCENARIOS";
      const coverage = (evidence.collection as { coverage?: { uncovered?: Array<{ method: string; path: string }>; uncoveredOperations?: number; totalOperations?: number } } | undefined)?.coverage;
      for (const operation of coverage?.uncovered ?? []) add("uncovered-operation", `${operation.method} ${operation.path}`);
      summary = `Every request passed, but ${coverage?.uncoveredOperations ?? "some"} of ${coverage?.totalOperations ?? "the"} documented operations have no passing request.`;
      next.push("Add scenarios for the uncovered operations (superadmin_api_coverage returns a runnable draft for each), then verify again.");
      break;
    }
    case "CONTRACT_GAP": {
      area = "CONTRACT";
      const incomplete = (evidence.collection as { coverage?: { incomplete?: Array<{ source: string; reason: string }> } } | undefined)?.coverage?.incomplete ?? [];
      for (const gap of incomplete) add("inventory-gap", `${gap.source}: ${gap.reason}`);
      summary = "The API inventory itself is incomplete, so coverage cannot be proven.";
      next.push("Fix the contracts the findings name (unparseable file, unresolved $ref), then verify again.");
      break;
    }
    case "REFERENCE_NOT_PROVEN":
      area = "REFERENCE";
      summary = `The reference implementation did not verify: ${failure.message}`;
      for (const line of errorLines(evidence.counterpart?.applicationLogTail)) add("reference-log", line);
      next.push("The reference must be PROVEN on the same scenarios before parity means anything: fix its environment (root, manifest) or the scenarios it fails, then verify again.");
      break;
    case "PARITY_MISMATCH": {
      area = "IMPLEMENTATION";
      for (const difference of evidence.parity?.differences ?? [])
        add("parity-difference", `${difference.scenario} › ${difference.step}: ${difference.kind}${difference.path ? ` at ${difference.path}` : ""} -- reference ${JSON.stringify(difference.reference)}, subject ${JSON.stringify(difference.subject)}`);
      summary = `The implementation answers ${evidence.parity?.differenceCount ?? "some"} step(s) differently from the reference.`;
      next.push("Change the implementation to answer as the reference does at each listed path, or record why the difference is intended; then verify again.");
      break;
    }
    default:
      next.push("Read the evidence steps and logs, fix the cause, then verify again.");
  }
  const fingerprint = fingerprintOf([failure.class, area, ...findings.slice(0, 3).map((finding) => `${finding.kind}:${finding.detail}`)]);
  return diagnosisSchema.parse({ failureClass: failure.class, area, summary: summary.slice(0, 500), findings, nextSteps: next, fingerprint });
}
