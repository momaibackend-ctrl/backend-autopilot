// Executable HTTP validation runner.
//
// This is the single implementation of "actually send the requests of a saved validation
// scenario". It is deliberately provider-neutral and free of Node-only builtins so that the
// identical module runs inside the Supabase Deno Edge MCP, the Fastify Console API and vitest.
//
// Safety boundary (fail-closed, see docs/http-validation-runner.md):
//   * the target always comes from a registered, project-owned, ACTIVE, non-production
//     HTTP_API resource -- never from caller input;
//   * the resolved base URL must be HTTPS, or loopback HTTP for a LOCAL/SANDBOX resource;
//   * private, link-local, unique-local, CGNAT and cloud metadata targets are rejected;
//   * step paths cannot change origin or escape the registered base path prefix;
//   * redirects are bounded and same-origin only;
//   * timeout, redirect count and response size are all capped;
//   * secret material (bearer tokens, sensitive extractions, credential headers) never
//     reaches evidence, audit, logs, errors or the MCP tool result.
import { z } from "zod";
import {
  InvalidState,
  NotFound,
  PolicyViolation,
  UnsupportedOperation,
} from "../../core/src/errors.js";
import type { Clock, StateStore } from "../../core/src/ports.js";
import { PolicyEngine } from "../../policy-engine/src/index.js";
import { redact } from "../../audit/src/index.js";
import {
  validationScenarioSaveInputSchema,
  type ArtifactKind,
  type Project,
  type Resource,
  type ValidationAssertion,
  type ValidationScenarioSaveInput,
  type ValidationScenarioStep,
} from "../../schemas/src/index.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
export type FetchLike = (
  input: URL | string,
  init?: RequestInit,
) => Promise<Response>;
export interface SecretResolver {
  get(reference: string, projectId: string): Promise<string>;
}
export interface ArtifactWriter {
  write(
    projectId: string,
    kind: ArtifactKind,
    content: unknown,
    taskId?: string,
    runId?: string,
  ): Promise<{ id: string }>;
}

export interface HttpRunnerLimits {
  /** Per-request connect+response timeout. */
  requestTimeoutMs: number;
  /** Bounded, same-origin-only redirect following. 0 disables following entirely. */
  maxRedirects: number;
  /** Hard cap on bytes read from a response body; the rest is dropped, never buffered. */
  maxResponseBytes: number;
  /** Cap on the response body actually persisted as evidence. */
  maxEvidenceBodyBytes: number;
  /** Whole-scenario wall clock budget. */
  maxScenarioDurationMs: number;
}
export const defaultHttpRunnerLimits: HttpRunnerLimits = {
  requestTimeoutMs: 15_000,
  maxRedirects: 0,
  maxResponseBytes: 256 * 1024,
  maxEvidenceBodyBytes: 8 * 1024,
  maxScenarioDurationMs: 120_000,
};
export const scenarioHttpRunnerLimits: HttpRunnerLimits = {
  ...defaultHttpRunnerLimits,
  maxRedirects: 3,
};

// ---------------------------------------------------------------------------
// Target resolution and SSRF containment
// ---------------------------------------------------------------------------

export type HostClass =
  | "LOOPBACK"
  | "PRIVATE"
  | "LINK_LOCAL"
  | "UNIQUE_LOCAL"
  | "METADATA"
  | "PUBLIC";

const metadataHosts = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);

function parseIpv4(host: string): number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    octets.push(value);
  }
  return octets;
}

/** Classifies a URL hostname without performing DNS resolution. */
export function classifyHost(hostname: string): HostClass {
  const host = hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
  if (!host) return "PRIVATE";
  if (host === "localhost" || host.endsWith(".localhost")) return "LOOPBACK";
  if (metadataHosts.has(host)) return "METADATA";
  if (host.endsWith(".internal") || host.endsWith(".local")) return "PRIVATE";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  if (mapped?.[1]) return classifyHost(mapped[1]);
  const octets = parseIpv4(host);
  if (octets) {
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    if (a === 127) return "LOOPBACK";
    if (a === 169 && b === 254)
      return c === 169 && d === 254 ? "METADATA" : "LINK_LOCAL";
    if (a === 0 || a === 10) return "PRIVATE";
    if (a === 172 && b >= 16 && b <= 31) return "PRIVATE";
    if (a === 192 && b === 168) return "PRIVATE";
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return "PRIVATE";
    if (a === 100 && b >= 64 && b <= 127) return "PRIVATE";
    if (a === 198 && (b === 18 || b === 19)) return "PRIVATE";
    if (a >= 224) return "PRIVATE";
    return "PUBLIC";
  }
  if (host.includes(":")) {
    if (host === "::1") return "LOOPBACK";
    if (host === "::") return "PRIVATE";
    if (/^fe[89ab]/.test(host)) return "LINK_LOCAL";
    if (/^f[cd]/.test(host)) return "UNIQUE_LOCAL";
    return "PUBLIC";
  }
  return "PUBLIC";
}

/**
 * Derives the only base URL an HTTP validation request may target from a registered resource.
 * Every failure mode is a hard rejection before any socket is opened.
 */
export function resolveHttpApiTarget(resource: Resource): URL {
  if (resource.type !== "HTTP_API")
    throw new PolicyViolation(
      "HTTP validation requires a project-owned HTTP_API resource",
      { resourceId: resource.resourceId, type: resource.type },
    );
  if (resource.status !== "ACTIVE")
    throw new PolicyViolation("HTTP_API resource is not ACTIVE", {
      resourceId: resource.resourceId,
      status: resource.status,
    });
  if (resource.environment === "PRODUCTION")
    throw new UnsupportedOperation(
      "Production HTTP targets are NOT_SUPPORTED in v0.5",
      { resourceId: resource.resourceId },
    );
  let url: URL;
  try {
    url = new URL(resource.externalReference);
  } catch {
    throw new PolicyViolation(
      "HTTP_API externalReference must be an absolute http(s) base URL",
      { resourceId: resource.resourceId },
    );
  }
  if (url.username || url.password)
    throw new PolicyViolation("HTTP_API URL cannot contain credentials", {
      resourceId: resource.resourceId,
    });
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new PolicyViolation("HTTP_API URL must use http or https", {
      resourceId: resource.resourceId,
      protocol: url.protocol,
    });
  if (url.search || url.hash)
    throw new PolicyViolation(
      "HTTP_API base URL cannot carry a query string or fragment",
      { resourceId: resource.resourceId },
    );
  const hostClass = classifyHost(url.hostname);
  if (hostClass === "LOOPBACK") {
    if (resource.environment !== "LOCAL" && resource.environment !== "SANDBOX")
      throw new PolicyViolation(
        "Loopback HTTP targets require a LOCAL or SANDBOX resource",
        { resourceId: resource.resourceId, environment: resource.environment },
      );
    return url;
  }
  if (hostClass !== "PUBLIC")
    throw new PolicyViolation(
      "HTTP_API target is a private, link-local or cloud metadata address",
      { resourceId: resource.resourceId, hostClass },
    );
  if (url.protocol !== "https:")
    throw new PolicyViolation("Non-loopback HTTP_API targets must use HTTPS", {
      resourceId: resource.resourceId,
    });
  return url;
}

/** Registered base path prefix; "" for a bare-origin base, so existing behaviour is unchanged. */
export function basePathPrefix(base: URL): string {
  const path = base.pathname.replace(/\/+$/, "");
  return path === "/" ? "" : path;
}

/** Resolves one step path + query inside the registered base, rejecting any escape attempt. */
export function resolveStepUrl(
  base: URL,
  path: string,
  query: Record<string, string> = {},
): URL {
  if (typeof path !== "string" || !path.startsWith("/"))
    throw new PolicyViolation("Request path must start with /");
  if (path.startsWith("//"))
    throw new PolicyViolation("Protocol-relative API paths are forbidden");
  if (/[\r\n\t\0]/.test(path))
    throw new PolicyViolation("Request path contains control characters");
  const prefix = basePathPrefix(base);
  let url: URL;
  try {
    url = new URL(`${prefix}${path}`, base.origin);
  } catch {
    throw new PolicyViolation("Request path is not a valid URL path");
  }
  assertContained(base, url);
  for (const [key, value] of Object.entries(query)) {
    if (!/^[\w.[\]-]{1,128}$/.test(key) || /[\r\n\0]/.test(String(value)))
      throw new PolicyViolation("Unsafe query parameter", { key });
    url.searchParams.set(key, String(value));
  }
  return url;
}

function assertContained(base: URL, url: URL): void {
  if (url.origin !== base.origin)
    throw new PolicyViolation("Request cannot leave the registered origin", {
      registeredOrigin: base.origin,
    });
  const prefix = basePathPrefix(base);
  if (prefix && !`${url.pathname}/`.startsWith(`${prefix}/`))
    throw new PolicyViolation(
      "Request cannot escape the registered base path",
      { registeredPath: prefix },
    );
}

// ---------------------------------------------------------------------------
// Header, body and secret handling
// ---------------------------------------------------------------------------

const credentialHeader =
  /^(authorization|cookie|proxy-authorization|x-api-key)$/i;
const secretName = /(token|secret|password|authorization|api[_-]?key)/i;

export function secretLike(value: string): boolean {
  return secretName.test(value);
}

/** Caller-supplied headers may never carry credentials or inject a new header line. */
export function validatedHeaders(input: Record<string, string>): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  for (const [key, value] of Object.entries(input)) {
    if (credentialHeader.test(key))
      throw new PolicyViolation(
        "Caller-supplied secret-bearing headers are forbidden",
      );
    if (!/^[a-z0-9-]{1,64}$/i.test(key) || /[\r\n\0]/.test(value))
      throw new PolicyViolation("Unsafe request header", { header: key });
    headers.set(key, value);
  }
  return headers;
}

export function safeResponseHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    [...headers].filter(
      ([key]) => !["set-cookie", "www-authenticate"].includes(key.toLowerCase()),
    ),
  );
}

/** Raw secret values are never accepted inline; secretRefs are the only supported channel. */
export function validateNoInlineSecrets(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) validateNoInlineSecrets(entry);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (secretLike(key))
      throw new PolicyViolation(
        "Caller-supplied secret-bearing request fields are forbidden",
      );
    validateNoInlineSecrets(entry);
  }
}

// ---------------------------------------------------------------------------
// {{variable}} interpolation, extraction and chaining
// ---------------------------------------------------------------------------

export type ScenarioVariables = Map<
  string,
  { value: unknown; sensitive: boolean }
>;

export function renderTemplate<T>(value: T, variables: ScenarioVariables): T {
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

function templateValue(name: string, variables: ScenarioVariables): unknown {
  const variable = variables.get(name);
  if (!variable) throw new InvalidState(`Scenario variable ${name} is missing`);
  if (variable.sensitive)
    throw new PolicyViolation(
      `Sensitive scenario variable ${name} may only be used as bearerFrom`,
    );
  return variable.value;
}

export function requiredBearer(
  variables: ScenarioVariables,
  name: string,
): string {
  const variable = variables.get(name);
  if (!variable)
    throw new InvalidState(`Scenario bearer variable ${name} is missing`);
  if (typeof variable.value !== "string" || !variable.value)
    throw new InvalidState(`Scenario bearer variable ${name} is not a string`);
  return variable.value;
}

export function extractResponseValue(body: unknown, path: string): unknown {
  const segments = path.split(".").slice(2);
  let value = body;
  for (const segment of segments) {
    if (!value || typeof value !== "object" || !(segment in value))
      throw new InvalidState(`Scenario extraction path ${path} was not found`);
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

/**
 * Converts a scenario definition into its redaction-safe persisted shape.
 *
 * ArtifactStore.write() redacts artifact content by key, so an `extract` record keyed by a
 * variable named `access_token` would be stored as the string "[REDACTED]" and the scenario
 * could never be executed. Storing extractions as a list of {variable,path,sensitive} objects
 * keeps every key non-secret-looking while preserving the exact definition.
 */
export function scenarioForStorage(definition: ValidationScenarioSaveInput) {
  return {
    ...definition,
    steps: definition.steps.map((step) => ({
      ...step,
      extract: Object.entries(step.extract).map(([variable, extraction]) => ({
        variable,
        ...extraction,
      })),
    })),
  };
}

/**
 * Accepts both persisted scenario shapes: the Console writes `extract` as an array of
 * {variable,path,sensitive}, the Superadmin MCP writes it as the schema's record. Without this
 * a scenario created through superadmin_scenario_create could never be executed.
 */
export function restoreScenarioDefinition(
  content: unknown,
): ValidationScenarioSaveInput {
  if (!content || typeof content !== "object")
    throw new InvalidState("Stored validation scenario is invalid");
  const stored = content as { steps?: unknown; operationId?: string };
  if (!Array.isArray(stored.steps))
    throw new InvalidState("Stored validation scenario has no steps");
  const steps = stored.steps.map((step) => {
    const value = (step ?? {}) as Record<string, unknown>;
    const extract = value["extract"];
    if (!Array.isArray(extract)) return value;
    return {
      ...value,
      extract: Object.fromEntries(
        extract.map((entry) => {
          const { variable, ...rest } = (entry ?? {}) as {
            variable?: string;
          } & Record<string, unknown>;
          return [variable ?? "", rest];
        }),
      ),
    };
  });
  return validationScenarioSaveInputSchema.parse({
    ...(content as Record<string, unknown>),
    operationId: stored.operationId ?? "restored-scenario",
    steps,
  });
}

// ---------------------------------------------------------------------------
// Bounded HTTP execution
// ---------------------------------------------------------------------------

export interface HttpExecutionEvidence {
  request: { method: HttpMethod; url: unknown; headers: unknown; body: unknown };
  response: {
    status: number;
    durationMs: number;
    headers: unknown;
    body: unknown;
    truncated: boolean;
  };
}
export interface HttpExecution extends HttpExecutionEvidence {
  rawBody: unknown;
  rawHeaders: Headers;
  redirects: number;
  durationMs: number;
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return { text: "", truncated: true };
  }
  if (!response.body) return { text: await response.text(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = maxBytes - total;
    if (value.byteLength > remaining) {
      if (remaining > 0) chunks.push(value.slice(0, remaining));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

function boundedEvidenceBody(value: unknown, maxBytes: number): unknown {
  const safe = redact(value);
  const serialized = JSON.stringify(safe ?? null) ?? "null";
  if (serialized.length <= maxBytes) return safe;
  return {
    truncated: true,
    bytes: serialized.length,
    preview: serialized.slice(0, maxBytes),
  };
}

export interface HttpRequestInput {
  base: URL;
  method: HttpMethod;
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  bearer?: string;
  limits?: HttpRunnerLimits;
  fetchImpl?: FetchLike;
}

/** Performs one logical request (plus bounded same-origin redirects) and returns evidence. */
export async function executeHttpRequest(
  input: HttpRequestInput,
): Promise<HttpExecution> {
  const limits = input.limits ?? defaultHttpRunnerLimits;
  const call: FetchLike = input.fetchImpl ?? ((url, init) => fetch(url, init));
  const url = resolveStepUrl(input.base, input.path, input.query ?? {});
  const headers = validatedHeaders(input.headers ?? {});
  if (input.bearer) headers.set("authorization", `Bearer ${input.bearer}`);
  const contentType = headers.get("content-type") ?? "application/json";
  const requestBody =
    input.body === undefined ||
    input.method === "GET" ||
    input.method === "HEAD"
      ? undefined
      : typeof input.body === "string" && !/json/i.test(contentType)
        ? input.body
        : JSON.stringify(input.body);
  const started = performance.now();
  let target = url;
  let redirects = 0;
  let response: Response;
  for (;;) {
    response = await call(target, {
      method: input.method,
      headers,
      ...(requestBody === undefined ? {} : { body: requestBody }),
      redirect: "manual",
      signal: AbortSignal.timeout(limits.requestTimeoutMs),
    });
    if (
      limits.maxRedirects <= 0 ||
      ![301, 302, 303, 307, 308].includes(response.status)
    )
      break;
    const location = response.headers.get("location");
    if (!location) break;
    if (redirects >= limits.maxRedirects)
      throw new PolicyViolation("Request exceeded the maximum redirect count", {
        maxRedirects: limits.maxRedirects,
      });
    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      throw new PolicyViolation("Redirect target is not a valid URL");
    }
    if (next.protocol !== target.protocol)
      throw new PolicyViolation("Redirect cannot change the request scheme");
    assertContained(input.base, next);
    await response.body?.cancel().catch(() => undefined);
    target = next;
    redirects += 1;
  }
  const { text, truncated } = await readBoundedText(
    response,
    limits.maxResponseBytes,
  );
  const durationMs = Math.round(performance.now() - started);
  let rawBody: unknown = text;
  try {
    rawBody = JSON.parse(text);
  } catch {
    /* plain response */
  }
  const evidenceHeaders = Object.fromEntries(headers);
  delete evidenceHeaders["authorization"];
  return {
    rawBody,
    rawHeaders: response.headers,
    redirects,
    durationMs,
    request: {
      method: input.method,
      url: redact(`${input.base.origin}${target.pathname}${target.search}`),
      headers: redact(evidenceHeaders),
      body: boundedEvidenceBody(input.body, limits.maxEvidenceBodyBytes),
    },
    response: {
      status: response.status,
      durationMs,
      headers: redact(safeResponseHeaders(response.headers)),
      body: boundedEvidenceBody(rawBody, limits.maxEvidenceBodyBytes),
      truncated,
    },
  };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

export interface AssertionOutcome {
  type: string;
  target: string;
  passed: boolean;
  summary: string;
}

export function evaluateAssertions(
  assertions: ValidationAssertion[],
  execution: HttpExecution,
): AssertionOutcome[] {
  return assertions.map((assertion) => {
    switch (assertion.type) {
      case "HEADER_EXISTS": {
        const header = (assertion.header ?? "").toLowerCase();
        return outcome(
          assertion.type,
          header,
          header !== "" && execution.rawHeaders.has(header),
          `header ${header} exists`,
        );
      }
      case "HEADER_EQUALS": {
        const header = (assertion.header ?? "").toLowerCase();
        const actual = execution.rawHeaders.get(header);
        return outcome(
          assertion.type,
          header,
          actual !== null && actual === assertion.value,
          `header ${header} equals the expected value`,
        );
      }
      case "BODY_FIELD_EXISTS": {
        const path = assertion.path ?? "";
        return outcome(
          assertion.type,
          path,
          readable(execution.rawBody, path).found,
          `body field ${path} exists`,
        );
      }
      case "BODY_FIELD_EQUALS": {
        const path = assertion.path ?? "";
        const found = readable(execution.rawBody, path);
        return outcome(
          assertion.type,
          path,
          found.found &&
            JSON.stringify(found.value ?? null) ===
              JSON.stringify(assertion.value ?? null),
          `body field ${path} equals the expected value`,
        );
      }
      case "MAX_DURATION_MS": {
        const budget = assertion.maxDurationMs ?? 0;
        return outcome(
          assertion.type,
          String(budget),
          budget > 0 && execution.durationMs <= budget,
          `response time <= ${budget}ms (actual ${execution.durationMs}ms)`,
        );
      }
      default:
        return outcome("UNKNOWN", "", false, "unsupported assertion");
    }
  });
}

function readable(body: unknown, path: string) {
  try {
    return { found: true, value: extractResponseValue(body, path) };
  } catch {
    return { found: false, value: undefined };
  }
}

function outcome(
  type: string,
  target: string,
  passed: boolean,
  label: string,
): AssertionOutcome {
  return {
    type,
    target,
    passed,
    summary: `${passed ? "PASSED" : "FAILED"}: ${label}`,
  };
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

export type StepStatus = "PASSED" | "FAILED" | "ERROR" | "SKIPPED";
export type ScenarioStatus = "PASSED" | "FAILED" | "ERROR";

export interface ScenarioStepResult {
  index: number;
  name: string;
  method: HttpMethod;
  path: string;
  status: StepStatus;
  httpStatus?: number;
  expectedStatus?: number;
  durationMs: number;
  assertions: AssertionOutcome[];
  extracted: Record<string, unknown>;
  request?: HttpExecutionEvidence["request"];
  response?: HttpExecutionEvidence["response"];
  validation?: {
    passed: boolean;
    expectedStatus?: number;
    humanSummary: string;
  };
  error?: { code: string; message: string };
  skipped?: true;
}

export interface ScenarioExecutionResult {
  executionId: string;
  scenarioId: string;
  scenarioName: string;
  projectId: string;
  resourceId: string;
  taskId?: string;
  environment: Project["environment"];
  status: ScenarioStatus;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  summary: {
    totalSteps: number;
    passedSteps: number;
    failedSteps: number;
    skippedSteps: number;
  };
  steps: ScenarioStepResult[];
  resultArtifactId: string;
}

export interface HttpScenarioRunnerDependencies {
  store: StateStore;
  artifacts: ArtifactWriter;
  clock: Clock;
  secrets?: SecretResolver;
  fetchImpl?: FetchLike;
  limits?: HttpRunnerLimits;
}

export class HttpScenarioRunner {
  private readonly policy: PolicyEngine;
  private readonly limits: HttpRunnerLimits;
  constructor(private readonly deps: HttpScenarioRunnerDependencies) {
    this.policy = new PolicyEngine(deps.store);
    this.limits = deps.limits ?? scenarioHttpRunnerLimits;
  }

  /**
   * Resolves and authorizes everything before a single packet leaves the process. Any failure
   * here is a hard rejection with no evidence record; failures after this point are recorded
   * as step evidence so an agent can act on them.
   */
  private async authorize(
    projectId: string,
    scenarioId: string,
    actor: string,
  ) {
    const project = await this.deps.store.getProject(projectId);
    if (!project) throw new NotFound("Project not found", { projectId });
    if (
      project.environment === "PRODUCTION" ||
      project.autonomyMode === "AUTONOMOUS_PRODUCTION"
    )
      throw new UnsupportedOperation(
        "Production HTTP scenario execution is NOT_SUPPORTED",
      );
    const artifact = await this.deps.store.getArtifact(projectId, scenarioId);
    if (
      !artifact ||
      artifact.kind !== "VALIDATION_SCENARIO" ||
      artifact.status === "DELETED"
    )
      throw new NotFound("Validation scenario not found", {
        projectId,
        scenarioId,
      });
    const definition = restoreScenarioDefinition(artifact.content);
    const resource = await this.deps.store.getResource(definition.resourceId);
    if (!resource || resource.projectId !== projectId)
      throw new PolicyViolation(
        "Validation scenario resource is not owned by this project",
        { projectId, resourceId: definition.resourceId },
      );
    await this.policy.authorize({
      project,
      action: "NETWORK",
      resourceId: resource.resourceId,
      requiredPermission: "READ",
      actor,
    });
    const base = resolveHttpApiTarget(resource);
    for (const step of definition.steps) {
      validatedHeaders(step.headers);
      validateNoInlineSecrets(step.body);
    }
    return { project, definition, resource, base };
  }

  async run(input: {
    projectId: string;
    scenarioId: string;
    operationId: string;
    actor: string;
  }): Promise<ScenarioExecutionResult> {
    const { project, definition, resource, base } = await this.authorize(
      input.projectId,
      input.scenarioId,
      input.actor,
    );
    const startedAt = this.deps.clock.now();
    const startedMs = performance.now();
    const variables: ScenarioVariables = new Map();
    const steps: ScenarioStepResult[] = [];
    const serverBearer = resource.secretRefs[0]
      ? await this.resolveSecret(resource.secretRefs[0], input.projectId)
      : undefined;
    let halted = false;
    for (const [index, step] of definition.steps.entries()) {
      if (halted) {
        steps.push(skippedStep(index, step));
        continue;
      }
      if (performance.now() - startedMs > this.limits.maxScenarioDurationMs) {
        steps.push({
          ...skippedStep(index, step),
          status: "ERROR",
          error: {
            code: "EXECUTION_FAILED",
            message: "Scenario exceeded its total execution budget",
          },
        });
        halted = true;
        continue;
      }
      const result = await this.runStep({
        index,
        step,
        base,
        variables,
        ...(serverBearer === undefined ? {} : { serverBearer }),
      });
      steps.push(result);
      if (result.status !== "PASSED") halted = true;
    }
    const completedAt = this.deps.clock.now();
    const durationMs = Math.round(performance.now() - startedMs);
    const passedSteps = steps.filter((step) => step.status === "PASSED").length;
    const failedSteps = steps.filter(
      (step) => step.status === "FAILED" || step.status === "ERROR",
    ).length;
    const skippedSteps = steps.filter(
      (step) => step.status === "SKIPPED",
    ).length;
    const errored = steps.some((step) => step.status === "ERROR");
    const status: ScenarioStatus = !failedSteps
      ? "PASSED"
      : errored
        ? "ERROR"
        : "FAILED";
    const humanSummary =
      status === "PASSED"
        ? `Сценарий «${definition.name}»: ${passedSteps} шагов пройдено.`
        : `Сценарий «${definition.name}» остановлен на ошибочном шаге.`;
    const summary = {
      totalSteps: steps.length,
      passedSteps,
      failedSteps,
      skippedSteps,
    };
    const content = {
      operationId: input.operationId,
      projectId: input.projectId,
      ...(definition.taskId ? { taskId: definition.taskId } : {}),
      environment: project.environment,
      suite: "SCENARIO",
      // `scenarioArtifactId`, `result` and `counts` keep the pre-existing
      // VALIDATION_REPORT shape that the Console and Validation Center already read.
      scenarioArtifactId: input.scenarioId,
      scenarioId: input.scenarioId,
      scenarioName: definition.name,
      resourceId: resource.resourceId,
      actor: input.actor,
      startedAt,
      finishedAt: completedAt,
      completedAt,
      durationMs,
      result: status === "PASSED" ? "PASS" : "FAIL",
      status,
      counts: {
        passed: passedSteps,
        failed: failedSteps ? 1 : 0,
        skipped: skippedSteps,
      },
      summary,
      humanSummary,
      steps,
    };
    const artifact = await this.deps.artifacts.write(
      input.projectId,
      "VALIDATION_REPORT",
      content,
      definition.taskId,
    );
    return {
      executionId: artifact.id,
      scenarioId: input.scenarioId,
      scenarioName: definition.name,
      projectId: input.projectId,
      resourceId: resource.resourceId,
      ...(definition.taskId ? { taskId: definition.taskId } : {}),
      environment: project.environment,
      status,
      startedAt,
      completedAt,
      durationMs,
      summary,
      steps,
      resultArtifactId: artifact.id,
    };
  }

  private async resolveSecret(reference: string, projectId: string) {
    if (!this.deps.secrets) return undefined;
    try {
      return await this.deps.secrets.get(reference, projectId);
    } catch {
      // A missing optional resource credential must never leak the reference name upward as
      // an execution failure; unauthenticated execution is still valid evidence.
      return undefined;
    }
  }

  private async runStep(input: {
    index: number;
    step: ValidationScenarioStep;
    base: URL;
    variables: ScenarioVariables;
    serverBearer?: string;
  }): Promise<ScenarioStepResult> {
    const { index, step, base, variables } = input;
    const started = performance.now();
    try {
      const path = renderTemplate(step.path, variables);
      const headers = renderTemplate(step.headers, variables);
      const query = renderTemplate(step.query, variables);
      const body =
        step.body === undefined
          ? undefined
          : renderTemplate(step.body, variables);
      const bearer = step.bearerFrom
        ? requiredBearer(variables, step.bearerFrom)
        : input.serverBearer;
      const execution = await executeHttpRequest({
        base,
        method: step.method,
        path,
        headers,
        query,
        ...(body === undefined ? {} : { body }),
        ...(bearer === undefined ? {} : { bearer }),
        limits: this.limits,
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      });
      const extracted: Record<string, unknown> = {};
      for (const [name, extraction] of Object.entries(step.extract)) {
        const value = extractResponseValue(execution.rawBody, extraction.path);
        const sensitive =
          extraction.sensitive ||
          secretLike(name) ||
          secretLike(extraction.path);
        variables.set(name, { value, sensitive });
        extracted[name] = sensitive ? "[REDACTED]" : value;
      }
      const statusPassed =
        step.expectedStatus === undefined ||
        execution.response.status === step.expectedStatus;
      const assertions = evaluateAssertions(step.assertions, execution);
      const passed = statusPassed && assertions.every((value) => value.passed);
      return {
        index,
        name: step.name,
        method: step.method,
        path: String(redact(path)),
        status: passed ? "PASSED" : "FAILED",
        httpStatus: execution.response.status,
        ...(step.expectedStatus === undefined
          ? {}
          : { expectedStatus: step.expectedStatus }),
        durationMs: execution.durationMs,
        assertions,
        extracted,
        request: execution.request,
        response: execution.response,
        validation: {
          passed,
          ...(step.expectedStatus === undefined
            ? {}
            : { expectedStatus: step.expectedStatus }),
          humanSummary: statusPassed
            ? `Получен ожидаемый HTTP ${execution.response.status}`
            : `Ожидался HTTP ${step.expectedStatus}, фактически получен HTTP ${execution.response.status}`,
        },
      };
    } catch (error) {
      return {
        index,
        name: step.name,
        method: step.method,
        path: String(redact(step.path)),
        status: "ERROR",
        ...(step.expectedStatus === undefined
          ? {}
          : { expectedStatus: step.expectedStatus }),
        durationMs: Math.round(performance.now() - started),
        assertions: [],
        extracted: {},
        error: sanitizedError(error),
        validation: {
          passed: false,
          ...(step.expectedStatus === undefined
            ? {}
            : { expectedStatus: step.expectedStatus }),
          humanSummary:
            "Шаг не выполнен: ошибка транспорта или нарушение политики",
        },
      };
    }
  }
}

function skippedStep(
  index: number,
  step: ValidationScenarioStep,
): ScenarioStepResult {
  return {
    index,
    name: step.name,
    method: step.method,
    path: String(redact(step.path)),
    status: "SKIPPED",
    durationMs: 0,
    assertions: [],
    extracted: {},
    skipped: true,
  };
}

/** Never surfaces provider stack traces, URLs with credentials or secret values. */
export function sanitizedError(error: unknown): {
  code: string;
  message: string;
} {
  const domain = error as { code?: string; message?: string; name?: string };
  const code =
    typeof domain?.code === "string" && /^[A-Z_]+$/.test(domain.code)
      ? domain.code
      : "EXECUTION_FAILED";
  const message =
    typeof domain?.message === "string" && domain.message
      ? domain.message
      : "HTTP scenario step failed";
  return { code, message: String(redact(message)).slice(0, 500) };
}

// ---------------------------------------------------------------------------
// Published tool contract
// ---------------------------------------------------------------------------
//
// The name, description, annotations and input schema of the externally published executor
// live here so the Supabase Edge MCP registration and every contract/E2E test share one
// definition. A runner that exists but is not registered under this name is not shipped.
export const scenarioRunToolName = "superadmin_scenario_run";
export const scenarioRunToolDescription =
  "Execute a saved validation scenario as real HTTP requests (Postman-style run) against its own registered HTTP_API resource: runs every step in order, applies headers/query/body, checks expected status and assertions, extracts response values, chains them through {{variable}} interpolation and bearerFrom, and persists a redacted VALIDATION_REPORT execution result. The target is resolved server-side from the scenario's resource; no URL, host or resourceId may be supplied by the caller.";
export const scenarioRunToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
export const scenarioRunToolInputSchema = {
  operationId: z.string().min(8).max(200),
  projectId: z.string().uuid(),
  scenarioId: z.string().uuid(),
};
export const scenarioRunInputSchema = z.object(scenarioRunToolInputSchema);
export type ScenarioRunInput = z.infer<typeof scenarioRunInputSchema>;
