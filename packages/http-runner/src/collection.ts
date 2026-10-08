// Full API collection: inventory, Postman import, coverage and a whole-collection run.
//
// The gap this closes is concrete. A project's executable HTTP evidence was whatever scenarios
// somebody happened to save -- in practice a handful of health, version, auth and 404 probes --
// and a green run of those seven requests read exactly like a green run of the whole API. Nothing
// in the runner knew how many operations the API actually has, so "the Java port passes the
// Postman collection" was indistinguishable from "the Java port answers /health". The same was
// true of the original repository: its own Postman collection was equally thin, so copying it
// over proved nothing either.
//
// This module makes the size of the claim explicit and provider-neutral, for any project:
//   * the API inventory comes from the project's own OpenAPI/Swagger contract;
//   * a project's whole Postman collection can be imported into saved scenarios, and everything
//     the runner cannot express is reported, never silently dropped;
//   * a collection run executes every scenario against one registered resource with a shared
//     variable map, the way a Postman runner carries a token from one folder into the next;
//   * coverage is computed against the inventory, and the verdict is PROVEN only when every
//     request passed AND every documented operation was actually exercised by a passing request.
//
// Like the runner itself it uses Web APIs only, so the same module runs in the Deno Edge MCP,
// the Node services and vitest.
import { z } from "zod";
import { InvalidState, NotFound, PolicyViolation, UnsupportedOperation } from "../../core/src/errors.js";
import type { Clock, StateStore } from "../../core/src/ports.js";
import {
  validationScenarioStepSchema,
  type Artifact,
  type Project,
  type ValidationAssertion,
  type ValidationScenarioStep,
} from "../../schemas/src/index.js";
import {
  HttpScenarioRunner,
  resolveHttpApiTarget,
  sanitizedError,
  secretLike,
  validateNoInlineSecrets,
  validatedHeaders,
  type ArtifactWriter,
  type FetchLike,
  type HttpMethod,
  type HttpRunnerLimits,
  type ScenarioExecutionResult,
  type ScenarioVariables,
  type SecretResolver,
  type StepStatus,
} from "./index.js";

export const COLLECTION_REPORT_VERSION = "1";
export const collectionLimits = {
  /** Operations read from one contract; a larger document is refused rather than truncated. */
  maxOperations: 2_000,
  /** Requests read from one Postman collection. */
  maxRequests: 1_000,
  /** Folder nesting depth walked in a Postman collection. */
  maxDepth: 16,
  /** Steps per saved scenario -- the existing scenario schema limit. */
  maxStepsPerScenario: 20,
  /** Scenarios executed by one collection run; more must be split with explicit scenarioIds. */
  maxScenariosPerRun: 100,
  /** Whole-collection wall clock budget; scenarios not started in time are recorded SKIPPED. */
  maxCollectionDurationMs: 120_000,
  /** Serialized size of an inline Postman collection or OpenAPI document. */
  maxDocumentBytes: 4 * 1024 * 1024,
  /** Entries listed per section in a persisted report or tool result. */
  maxListed: 500,
};

const supportedMethods = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Inline documents arrive either parsed or as JSON text; both are bounded before parsing. */
export function boundedDocument(value: unknown, label: string): unknown {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (text.length > collectionLimits.maxDocumentBytes)
    throw new PolicyViolation(`${label} exceeds the ${collectionLimits.maxDocumentBytes}-byte limit`);
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new InvalidState(`${label} is not valid JSON`);
  }
}

// ---------------------------------------------------------------------------
// Path templates
// ---------------------------------------------------------------------------

/** One canonical spelling of a request path: leading slash, no query, no trailing slash. */
export function normalizeApiPath(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? "";
  const collapsed = `/${withoutQuery}`.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") || "/" : "/";
}

function segments(path: string) {
  const normalized = normalizeApiPath(path);
  return normalized === "/" ? [] : normalized.slice(1).split("/");
}

const templateParam = /\{[^{}/]+\}/g;
const scenarioVariable = /\{\{[^{}]*\}\}/g;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * How well one template segment matches one request segment: 2 literal, 1 partially templated,
 * 0 a whole-segment parameter, -1 no match. A request segment that is still a scenario variable
 * (`{{note_id}}`) stands for "some value" and so only matches a templated segment, never a literal.
 */
function segmentScore(template: string, actual: string): number {
  const templated = template.match(templateParam);
  const variable = actual.match(scenarioVariable);
  if (!templated) return !variable && template === actual ? 2 : -1;
  if (actual === "") return -1;
  if (/^\{[^{}/]+\}$/.test(template)) return 0;
  const pattern = new RegExp(`^${template.split(templateParam).map(escapeRegExp).join("[^/]+")}$`);
  return pattern.test(actual.replace(scenarioVariable, "x")) ? 1 : -1;
}

/** Specificity of a template for a request path, or -1. Higher wins, like OpenAPI's own rule. */
export function templateMatchScore(template: string, path: string): number {
  const expected = segments(template);
  const actual = segments(path);
  if (expected.length !== actual.length) return -1;
  let score = 0;
  for (const [index, segment] of expected.entries()) {
    const value = segmentScore(segment, actual[index] ?? "");
    if (value < 0) return -1;
    score += value;
  }
  return score;
}

// ---------------------------------------------------------------------------
// API inventory from an OpenAPI / Swagger contract
// ---------------------------------------------------------------------------

export interface ApiOperation {
  method: HttpMethod;
  path: string;
  operationId?: string;
  /** The operation (or the document by default) declares a non-empty security requirement. */
  secured: boolean;
  /** Smallest documented 2xx status, used as the expected status of a drafted step. */
  successStatus?: number;
  /** Every numeric response status the contract documents for the operation. */
  declaredStatuses: number[];
  /** Repository path of the contract that documents the operation, when the inventory has several. */
  contract?: string;
  /** Other contracts documenting the same method and path. */
  alsoIn?: string[];
}
export interface ApiInventory {
  title?: string;
  version?: string;
  operations: ApiOperation[];
  /** Operations the contract documents but the runner cannot exercise, with the reason. */
  excluded: Array<{ method: string; path: string; reason: string }>;
  /**
   * Gaps in the inventory itself: a path item behind a $ref that could not be resolved, a contract
   * file that could not be read or parsed, a repository listing the host cut short. Operations
   * hidden there cannot be counted, so a non-empty list keeps every verdict NOT_PROVEN.
   */
  incomplete?: Array<{ source: string; reason: string }>;
}

const contractMethods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

function hasSecurity(requirements: unknown): boolean {
  return Array.isArray(requirements) && requirements.some((entry) => isRecord(entry) && Object.keys(entry).length > 0);
}

/** Reads every operation a contract documents. Throws when the document is not a contract. */
export function extractApiOperations(document: unknown): ApiInventory {
  if (!isRecord(document) || !(typeof document["openapi"] === "string" || document["swagger"] === "2.0"))
    throw new InvalidState("API inventory requires an OpenAPI 3.x or Swagger 2.0 document");
  const paths = document["paths"];
  if (!isRecord(paths)) throw new InvalidState("OpenAPI document has no paths object");
  const info = isRecord(document["info"]) ? document["info"] : {};
  const documentSecured = hasSecurity(document["security"]);
  const operations: ApiOperation[] = [];
  const excluded: ApiInventory["excluded"] = [];
  const seen = new Set<string>();
  const incomplete: NonNullable<ApiInventory["incomplete"]> = [];
  for (const [rawPath, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    const path = normalizeApiPath(rawPath);
    if (typeof item["$ref"] === "string" && !contractMethods.some((lower) => isRecord(item[lower]))) {
      incomplete.push({ source: path, reason: `path item is an unresolved $ref to ${String(item["$ref"]).slice(0, 200)}` });
      continue;
    }
    for (const lower of contractMethods) {
      const operation = item[lower];
      if (!isRecord(operation)) continue;
      const method = lower.toUpperCase();
      if (!supportedMethods.has(method as HttpMethod)) {
        excluded.push({ method, path, reason: `${method} is not executable by the HTTP runner` });
        continue;
      }
      const key = `${method} ${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (operations.length >= collectionLimits.maxOperations)
        throw new PolicyViolation(`API contract documents more than ${collectionLimits.maxOperations} operations`);
      const responses = isRecord(operation["responses"]) ? Object.keys(operation["responses"]) : [];
      const declaredStatuses = [...new Set(responses.filter((code) => /^[1-5]\d\d$/.test(code)).map(Number))].sort((a, b) => a - b);
      const successStatus = declaredStatuses.find((code) => code >= 200 && code < 300);
      operations.push({
        method: method as HttpMethod,
        path,
        ...(typeof operation["operationId"] === "string" ? { operationId: operation["operationId"] } : {}),
        secured: "security" in operation ? hasSecurity(operation["security"]) : documentSecured,
        ...(successStatus === undefined ? {} : { successStatus }),
        declaredStatuses,
      });
    }
  }
  return {
    ...(typeof info["title"] === "string" ? { title: info["title"] } : {}),
    ...(typeof info["version"] === "string" ? { version: info["version"] } : {}),
    operations,
    excluded,
    ...(incomplete.length ? { incomplete } : {}),
  };
}

/**
 * Inventory from the project's own API_CONTRACT artifacts, as the execution runner records them
 * (`{contracts:[{path,document}]}`). Several contract files are merged, duplicates collapse.
 */
export function inventoryFromContractArtifact(content: unknown): ApiInventory | undefined {
  const contracts = isRecord(content) && Array.isArray(content["contracts"]) ? content["contracts"] : [];
  const merged: ApiInventory = { operations: [], excluded: [] };
  const seen = new Set<string>();
  for (const contract of contracts) {
    if (!isRecord(contract)) continue;
    let inventory: ApiInventory;
    try {
      inventory = extractApiOperations(contract["document"]);
    } catch {
      continue;
    }
    if (merged.title === undefined && inventory.title !== undefined) merged.title = inventory.title;
    if (merged.version === undefined && inventory.version !== undefined) merged.version = inventory.version;
    for (const operation of inventory.operations) {
      const key = `${operation.method} ${operation.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.operations.push(operation);
    }
    merged.excluded.push(...inventory.excluded);
    if (inventory.incomplete?.length) merged.incomplete = [...(merged.incomplete ?? []), ...inventory.incomplete];
  }
  return merged.operations.length || merged.excluded.length ? merged : undefined;
}

/** The documented operation a request exercises: the most specific matching template. */
export function matchOperation(operations: ApiOperation[], method: string, path: string): ApiOperation | undefined {
  let best: ApiOperation | undefined;
  let bestScore = -1;
  for (const operation of operations) {
    if (operation.method !== method.toUpperCase()) continue;
    const score = templateMatchScore(operation.path, path);
    if (score > bestScore) {
      best = operation;
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Coverage and verdict
// ---------------------------------------------------------------------------

export interface ExercisedRequest {
  scenario: string;
  step: string;
  method: string;
  path: string;
  /** Present for an executed request; absent when coverage is computed from saved definitions. */
  status?: StepStatus;
  httpStatus?: number;
}
export type CoverageBasis = "DECLARED" | "EXECUTED";
export type CoverageStatus = "COMPLETE" | "INCOMPLETE" | "NO_INVENTORY";
export interface ApiCoverageReport {
  basis: CoverageBasis;
  status: CoverageStatus;
  totalOperations: number;
  coveredOperations: number;
  uncoveredOperations: number;
  /** Covered share with one decimal, 0 when there is no inventory. */
  coveragePercent: number;
  covered: Array<{
    method: HttpMethod;
    path: string;
    by: string[];
    observedStatuses: number[];
    missingStatuses: number[];
  }>;
  uncovered: Array<ApiOperation & { reason: "NOT_EXERCISED" | "NOT_PASSING" }>;
  /** Requests that match no documented operation: an undocumented endpoint or a contract gap. */
  undocumented: Array<{ method: string; path: string; scenario: string; step: string }>;
  responseCoverage: { declared: number; observed: number };
  excluded: ApiInventory["excluded"];
  /** Present when the inventory spans several contracts: coverage of each one on its own. */
  byContract?: Array<{
    contract: string;
    totalOperations: number;
    coveredOperations: number;
    coveragePercent: number;
    status: "COMPLETE" | "INCOMPLETE";
  }>;
  incomplete: NonNullable<ApiInventory["incomplete"]>;
}

/**
 * Which documented operations a set of requests exercises. On the EXECUTED basis an operation
 * counts only when a request against it PASSED -- a failing or skipped request is "attempted",
 * not covered, because it proves nothing about the endpoint.
 */
export function computeApiCoverage(
  inventory: ApiInventory | undefined,
  requests: ExercisedRequest[],
  basis: CoverageBasis,
): ApiCoverageReport {
  if (!inventory)
    return {
      basis,
      status: "NO_INVENTORY",
      totalOperations: 0,
      coveredOperations: 0,
      uncoveredOperations: 0,
      coveragePercent: 0,
      covered: [],
      uncovered: [],
      undocumented: requests.slice(0, collectionLimits.maxListed).map(({ method, path, scenario, step }) => ({ method, path, scenario, step })),
      responseCoverage: { declared: 0, observed: 0 },
      excluded: [],
      incomplete: [],
    };
  const hits = new Map<ApiOperation, { by: string[]; passed: boolean; observed: Set<number> }>();
  const undocumented: ApiCoverageReport["undocumented"] = [];
  for (const request of requests) {
    const operation = matchOperation(inventory.operations, request.method, request.path);
    if (!operation) {
      undocumented.push({ method: request.method, path: request.path, scenario: request.scenario, step: request.step });
      continue;
    }
    const entry = hits.get(operation) ?? { by: [], passed: false, observed: new Set<number>() };
    entry.by.push(`${request.scenario} › ${request.step}`);
    if (basis === "DECLARED" || request.status === "PASSED") entry.passed = true;
    if (request.httpStatus !== undefined) entry.observed.add(request.httpStatus);
    hits.set(operation, entry);
  }
  const covered: ApiCoverageReport["covered"] = [];
  const uncovered: ApiCoverageReport["uncovered"] = [];
  let observedResponses = 0;
  for (const operation of inventory.operations) {
    const entry = hits.get(operation);
    if (entry?.passed) {
      const observedStatuses = [...entry.observed].sort((a, b) => a - b);
      observedResponses += operation.declaredStatuses.filter((code) => entry.observed.has(code)).length;
      covered.push({
        method: operation.method,
        path: operation.path,
        by: entry.by.slice(0, 5),
        observedStatuses,
        missingStatuses: operation.declaredStatuses.filter((code) => !entry.observed.has(code)),
      });
    } else uncovered.push({ ...operation, reason: entry ? "NOT_PASSING" : "NOT_EXERCISED" });
  }
  const total = inventory.operations.length;
  // An operation documented by two contracts counts toward both: each contract is a separate
  // claim about the API, and "the check-in contract is fully covered" must be answerable alone.
  const perContract = new Map<string, { total: number; covered: number }>();
  const coveredKeys = new Set(covered.map((value) => `${value.method} ${value.path}`));
  for (const operation of inventory.operations)
    for (const contract of operation.contract ? [operation.contract, ...(operation.alsoIn ?? [])] : []) {
      const entry = perContract.get(contract) ?? { total: 0, covered: 0 };
      entry.total += 1;
      if (coveredKeys.has(`${operation.method} ${operation.path}`)) entry.covered += 1;
      perContract.set(contract, entry);
    }
  const byContract = [...perContract.entries()].map(([contract, entry]) => ({
    contract,
    totalOperations: entry.total,
    coveredOperations: entry.covered,
    coveragePercent: entry.total ? Math.floor((entry.covered / entry.total) * 1000) / 10 : 0,
    status: entry.covered === entry.total ? ("COMPLETE" as const) : ("INCOMPLETE" as const),
  }));
  const incomplete = inventory.incomplete ?? [];
  return {
    basis,
    status: total > 0 && uncovered.length === 0 && incomplete.length === 0 ? "COMPLETE" : "INCOMPLETE",
    totalOperations: total,
    coveredOperations: covered.length,
    uncoveredOperations: uncovered.length,
    coveragePercent: total ? Math.floor((covered.length / total) * 1000) / 10 : 0,
    covered: covered.slice(0, collectionLimits.maxListed),
    uncovered: uncovered.slice(0, collectionLimits.maxListed),
    undocumented: undocumented.slice(0, collectionLimits.maxListed),
    responseCoverage: {
      declared: inventory.operations.reduce((sum, operation) => sum + operation.declaredStatuses.length, 0),
      observed: observedResponses,
    },
    excluded: inventory.excluded.slice(0, collectionLimits.maxListed),
    ...(byContract.length ? { byContract } : {}),
    incomplete: incomplete.slice(0, collectionLimits.maxListed),
  };
}

export type CollectionVerdict = "PROVEN" | "NOT_PROVEN";

/** The claim a collection run is allowed to make, with every reason it falls short. */
export function collectionVerdict(input: {
  scenarios: number;
  passedScenarios: number;
  skippedScenarios: number;
  coverage: ApiCoverageReport;
}): { verdict: CollectionVerdict; reasons: string[] } {
  const reasons: string[] = [];
  if (input.scenarios === 0) reasons.push("no scenarios were executed");
  const notPassing = input.scenarios - input.passedScenarios - input.skippedScenarios;
  if (notPassing > 0) reasons.push(`${notPassing} of ${input.scenarios} scenarios did not pass`);
  if (input.skippedScenarios > 0)
    reasons.push(`${input.skippedScenarios} of ${input.scenarios} scenarios were not started within the collection budget; run them with scenarioIds`);
  if (input.coverage.status === "NO_INVENTORY")
    reasons.push("no API inventory: without the project's OpenAPI contract the run cannot show it covers the whole API");
  else if (input.coverage.totalOperations === 0) reasons.push("the API contract documents no executable operations");
  else if (input.coverage.uncoveredOperations > 0)
    reasons.push(
      `${input.coverage.uncoveredOperations} of ${input.coverage.totalOperations} documented operations were not exercised by a passing request`,
    );
  if (input.coverage.incomplete.length)
    reasons.push(
      `the API inventory is incomplete (${input.coverage.incomplete.length} gap(s), e.g. ${input.coverage.incomplete[0]?.source}: ${input.coverage.incomplete[0]?.reason})`,
    );
  const partial = (input.coverage.byContract ?? []).filter((value) => value.status === "INCOMPLETE");
  if (partial.length)
    reasons.push(
      `contracts not fully covered: ${partial
        .slice(0, 10)
        .map((value) => `${value.contract} (${value.coveredOperations}/${value.totalOperations})`)
        .join(", ")}`,
    );
  return { verdict: reasons.length ? "NOT_PROVEN" : "PROVEN", reasons };
}

// ---------------------------------------------------------------------------
// Drafts for the operations nothing exercises yet
// ---------------------------------------------------------------------------

/**
 * Turns a free-form variable name (Postman `authToken`, `base-url`, an OpenAPI `{userId}`) into
 * the scenario variable grammar `^[a-z][a-z0-9_]{0,63}$`. Undefined for a dynamic variable
 * (`$guid`) or a name with no usable character.
 */
export function normalizeVariableName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed || trimmed.startsWith("$")) return undefined;
  let value = trimmed
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!value) return undefined;
  if (!/^[a-z]/.test(value)) value = `v_${value}`;
  return value.slice(0, 64).replace(/_+$/g, "");
}

export interface DraftStep {
  operation: string;
  step: ValidationScenarioStep;
  /** Variables the step references that an earlier step (usually a create) must extract. */
  requiredVariables: string[];
  note: string;
}

/**
 * A runnable skeleton per uncovered operation. Drafts are returned, never saved: a request body
 * and the identifiers of real sandbox data are project knowledge the contract does not carry,
 * so the agent completes each draft and saves it through superadmin_scenario_create.
 */
export function draftStepsFor(operations: ApiOperation[]): DraftStep[] {
  return operations.slice(0, collectionLimits.maxListed).map((operation) => {
    const requiredVariables: string[] = [];
    const path = operation.path.replace(templateParam, (match) => {
      const name = normalizeVariableName(match.slice(1, -1)) ?? "param";
      if (!requiredVariables.includes(name)) requiredVariables.push(name);
      return `{{${name}}}`;
    });
    const step = validationScenarioStepSchema.parse({
      name: `${operation.method} ${operation.path}`.slice(0, 120),
      method: operation.method,
      path,
      ...(operation.successStatus === undefined ? {} : { expectedStatus: operation.successStatus }),
    });
    const needsBody = ["POST", "PUT", "PATCH"].includes(operation.method);
    return {
      operation: `${operation.method} ${operation.path}`,
      step,
      requiredVariables,
      note: [
        requiredVariables.length ? `extract ${requiredVariables.join(", ")} in an earlier step` : "",
        needsBody ? "add a request body that satisfies the contract" : "",
        operation.successStatus === undefined ? "the contract documents no 2xx response; set expectedStatus" : "",
        operation.secured ? "secured: authenticate through the resource secretRef or bearerFrom" : "",
      ]
        .filter(Boolean)
        .join("; ") || "ready to save as-is",
    };
  });
}

// ---------------------------------------------------------------------------
// Postman collection import
// ---------------------------------------------------------------------------

export interface ImportedScenario {
  name: string;
  description: string;
  steps: ValidationScenarioStep[];
}
export interface PostmanImportResult {
  collectionName: string;
  requestCount: number;
  importedSteps: number;
  scenarios: ImportedScenario[];
  /** Requests not imported, each with the reason -- the import is never silently partial. */
  skipped: Array<{ request: string; reason: string }>;
  warnings: Array<{ request?: string; message: string }>;
  /** Original Postman variable name -> scenario variable name. */
  variables: Record<string, string>;
}
export interface PostmanImportOptions {
  /** Path prefix the registered resource base URL already carries, e.g. "/api/v1". */
  stripPathPrefix?: string;
}

interface FlatRequest {
  group: string;
  name: string;
  item: Record<string, unknown>;
  auth: unknown;
}

/** Marks a placeholder that stood outside a JSON string in a raw Postman body. */
export const unquotedPlaceholder = "\u0000";

class ImportContext {
  readonly variables: Record<string, string> = {};
  readonly warnings: PostmanImportResult["warnings"] = [];
  private readonly reverse = new Map<string, string>();
  constructor(readonly staticValues: Map<string, string>) {}

  warn(message: string, request?: string) {
    if (this.warnings.length >= collectionLimits.maxListed) return;
    if (this.warnings.some((entry) => entry.message === message && entry.request === request)) return;
    this.warnings.push({ ...(request ? { request } : {}), message });
  }

  name(original: string, request?: string): string | undefined {
    const normalized = normalizeVariableName(original);
    if (!normalized) {
      this.warn(`variable {{${original}}} is a Postman dynamic variable or has no usable name and is not supported`, request);
      return undefined;
    }
    const previous = this.reverse.get(normalized);
    if (previous && previous !== original)
      this.warn(`variables {{${previous}}} and {{${original}}} both map to {{${normalized}}}`, request);
    this.reverse.set(normalized, original);
    this.variables[original] = normalized;
    return normalized;
  }

  /** Rewrites `{{postmanName}}` into the scenario grammar, inlining static collection values. */
  text(value: string, request: string): string {
    return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, original: string) => {
      const known = this.staticValues.get(original);
      if (known !== undefined) return known;
      const name = this.name(original, request);
      return name ? `{{${name}}}` : match;
    });
  }

  deep(value: unknown, request: string): unknown {
    if (typeof value === "string" && value.startsWith(unquotedPlaceholder)) {
      // `"size": {{pageSize}}` -- Postman substitutes text, so a static value keeps its JSON type.
      const placeholder = value.slice(unquotedPlaceholder.length);
      const known = this.staticValues.get(placeholder.slice(2, -2).trim());
      if (known === undefined) return this.text(placeholder, request);
      const literal = literalValue(known);
      return literal.ok ? literal.value : known;
    }
    if (typeof value === "string") return this.text(value, request);
    if (Array.isArray(value)) return value.map((entry) => this.deep(entry, request));
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, this.deep(entry, request)]));
    return value;
  }
}

function postmanString(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value["value"] === "string") return value["value"];
  return "";
}

function scriptLines(item: Record<string, unknown>, listen: "test" | "prerequest"): string[] {
  const events = Array.isArray(item["event"]) ? item["event"] : [];
  return events
    .filter((event): event is Record<string, unknown> => isRecord(event) && event["listen"] === listen && event["disabled"] !== true)
    .flatMap((event) => {
      const script = isRecord(event["script"]) ? event["script"]["exec"] : undefined;
      return Array.isArray(script) ? script.map(String) : typeof script === "string" ? script.split("\n") : [];
    })
    .flatMap((line) => line.split("\n"));
}

function flatten(collection: Record<string, unknown>): FlatRequest[] {
  const requests: FlatRequest[] = [];
  const rootName = postmanString(isRecord(collection["info"]) ? collection["info"]["name"] : "") || "Collection";
  const walk = (items: unknown, group: string, prefix: string, auth: unknown, depth: number) => {
    if (!Array.isArray(items)) return;
    if (depth > collectionLimits.maxDepth)
      throw new PolicyViolation(`Postman collection nests folders deeper than ${collectionLimits.maxDepth} levels`);
    for (const entry of items) {
      if (!isRecord(entry)) continue;
      const name = postmanString(entry["name"]) || "Unnamed";
      const inherited = entry["auth"] === undefined ? auth : entry["auth"];
      if (Array.isArray(entry["item"])) {
        const nextGroup = depth === 0 ? name : group;
        const nextPrefix = depth === 0 ? "" : `${prefix}${name} / `;
        walk(entry["item"], nextGroup, nextPrefix, inherited, depth + 1);
        continue;
      }
      if (entry["request"] === undefined) continue;
      if (requests.length >= collectionLimits.maxRequests)
        throw new PolicyViolation(`Postman collection has more than ${collectionLimits.maxRequests} requests`);
      requests.push({ group, name: `${prefix}${name}`, item: entry, auth: inherited });
    }
  };
  walk(collection["item"], rootName, "", collection["auth"], 0);
  return requests;
}

/** `pm.response.json().a[0]["b"]` or `jsonData.a.b` -> `response.body.a.0.b`. */
function expressionToPath(expression: string, jsonAliases: Set<string>): string | undefined {
  const trimmed = expression.trim().replace(/;$/, "");
  const head = /^(pm\.response\.json\(\)|JSON\.parse\(\s*responseBody\s*\)|[A-Za-z_$][\w$]*)/.exec(trimmed);
  if (!head?.[1]) return undefined;
  if (!/^(pm\.response\.json\(\)|JSON\.parse)/.test(head[1]) && !jsonAliases.has(head[1])) return undefined;
  let rest = trimmed.slice(head[1].length);
  const parts: string[] = [];
  while (rest) {
    const access = /^(?:\.([A-Za-z0-9_-]+)|\[\s*(\d+)\s*\]|\[\s*(['"])([A-Za-z0-9_-]+)\3\s*\])/.exec(rest);
    if (!access) return undefined;
    parts.push(access[1] ?? access[2] ?? access[4] ?? "");
    rest = rest.slice(access[0].length);
  }
  return parts.length ? `response.body.${parts.join(".")}` : undefined;
}

function literalValue(source: string): { ok: true; value: unknown } | { ok: false } {
  const text = source.trim().replace(/;$/, "");
  const quoted = /^'((?:[^'\\]|\\.)*)'$/.exec(text);
  try {
    return { ok: true, value: JSON.parse(quoted ? JSON.stringify(quoted[1]) : text) };
  } catch {
    return { ok: false };
  }
}

const structuralLine = /^(?:\/\/.*|\/\*.*|\*.*|[{}()[\];,\s]*|pm\.test\(.*(?:function\s*\([^)]*\)|=>)\s*\{?|(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=\s*(?:pm\.response\.json\(\)|JSON\.parse\(\s*responseBody\s*\))\s*;?)$/;

interface TranslatedTests {
  expectedStatus?: number;
  extract: Record<string, { path: string; sensitive: boolean }>;
  assertions: ValidationAssertion[];
  untranslated: string[];
}

/** Translates the deterministic subset of Postman test scripts; reports every other line. */
function translatePostmanTests(lines: string[], context: ImportContext, request: string): TranslatedTests {
  const result: TranslatedTests = { extract: {}, assertions: [], untranslated: [] };
  const aliases = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim();
    const alias = /^(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:pm\.response\.json\(\)|JSON\.parse\(\s*responseBody\s*\))/.exec(line);
    if (alias?.[1]) aliases.add(alias[1]);
  }
  for (const raw of lines) {
    const line = raw.trim();
    let match: RegExpExecArray | null;
    if ((match = /pm\.response\.to\.have\.status\(\s*(\d{3})\s*\)/.exec(line)) ||
      (match = /pm\.expect\(\s*pm\.response\.(?:code|status)\s*\)\.to\.(?:eql|equal|eq|be\.equal|deep\.equal)\(\s*(\d{3})\s*\)/.exec(line)) ||
      (match = /tests\[[^\]]*\]\s*=\s*responseCode\.code\s*===?\s*(\d{3})/.exec(line))) {
      result.expectedStatus = Number(match[1]);
      continue;
    }
    if (/pm\.response\.to\.be\.ok\b/.test(line)) {
      result.expectedStatus = 200;
      continue;
    }
    if ((match = /pm\.(?:environment|collectionVariables|globals|variables)\.set\(\s*(['"])([^'"]+)\1\s*,\s*(.+?)\s*\)\s*;?\s*$/.exec(line))) {
      const name = context.name(match[2] ?? "", request);
      const path = expressionToPath(match[3] ?? "", aliases);
      if (name && path) {
        result.extract[name] = { path, sensitive: secretLike(name) || secretLike(path) };
        continue;
      }
    }
    if ((match = /pm\.response\.to\.have\.header\(\s*(['"])([A-Za-z0-9-]{1,64})\1\s*(?:,\s*(['"])((?:[^'"\\]|\\.)*)\3\s*)?\)/.exec(line))) {
      result.assertions.push(
        match[4] === undefined
          ? { type: "HEADER_EXISTS", header: match[2] ?? "" }
          : { type: "HEADER_EQUALS", header: match[2] ?? "", value: match[4] },
      );
      continue;
    }
    if ((match = /pm\.response\.to\.have\.jsonBody\(\s*(['"])([A-Za-z0-9_.-]+)\1\s*\)/.exec(line))) {
      const path = `response.body.${match[2]}`;
      if (/^response\.body(?:\.[a-zA-Z0-9_-]+)+$/.test(path)) {
        result.assertions.push({ type: "BODY_FIELD_EXISTS", path });
        continue;
      }
    }
    if ((match = /pm\.expect\(\s*pm\.response\.responseTime\s*\)\.to\.be\.(?:below|lessThan|lt)\(\s*(\d+)\s*\)/.exec(line))) {
      result.assertions.push({ type: "MAX_DURATION_MS", maxDurationMs: Math.max(1, Math.min(600_000, Number(match[1]))) });
      continue;
    }
    if ((match = /pm\.expect\((.+?)\)\.to\.(?:exist|not\.be\.undefined|not\.be\.null)\b/.exec(line))) {
      const path = expressionToPath(match[1] ?? "", aliases);
      if (path) {
        result.assertions.push({ type: "BODY_FIELD_EXISTS", path });
        continue;
      }
    }
    if ((match = /pm\.expect\((.+?)\)\.to\.(?:eql|equal|eq|deep\.equal|be\.equal)\((.+)\)\s*;?\s*$/.exec(line))) {
      const path = expressionToPath(match[1] ?? "", aliases);
      const literal = literalValue(match[2] ?? "");
      if (path && literal.ok) {
        result.assertions.push({ type: "BODY_FIELD_EQUALS", path, value: literal.value });
        continue;
      }
    }
    if (structuralLine.test(line)) continue;
    result.untranslated.push(line.slice(0, 200));
  }
  return result;
}

/**
 * Parses a raw JSON body that may hold unquoted `{{variables}}` (`"age": {{age}}`), which is not
 * JSON until the placeholders are lifted out. An unquoted placeholder becomes a string marked
 * with `unquotedPlaceholder`, so the import can tell `{{n}}` from `"{{n}}"`: a static value is
 * inlined with its JSON type, a run-time variable stays `"{{name}}"`, which the runner renders
 * back into the variable's own type.
 */
export function parseTemplatedJson(text: string): { ok: true; value: unknown } | { ok: false } {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "{" && text[index + 1] === "{") {
      const end = text.indexOf("}}", index + 2);
      if (end < 0) return { ok: false };
      output += JSON.stringify(`${unquotedPlaceholder}${text.slice(index, end + 2)}`);
      index = end + 1;
      continue;
    }
    output += char;
  }
  try {
    return { ok: true, value: JSON.parse(output) };
  } catch {
    return { ok: false };
  }
}

function requestPath(url: unknown, context: ImportContext, request: string, options: PostmanImportOptions) {
  let rawPath = "";
  let query: Record<string, string> = {};
  const pathVariables = new Map<string, string>();
  if (isRecord(url)) {
    if (Array.isArray(url["variable"]))
      for (const variable of url["variable"])
        if (isRecord(variable) && typeof variable["key"] === "string")
          pathVariables.set(variable["key"], postmanString(variable["value"]));
    if (Array.isArray(url["query"]))
      query = Object.fromEntries(
        url["query"]
          .filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry["disabled"] !== true && typeof entry["key"] === "string")
          .map((entry) => [String(entry["key"]), postmanString(entry["value"])]),
      );
    if (Array.isArray(url["path"])) rawPath = `/${url["path"].map(postmanString).join("/")}`;
    else if (typeof url["path"] === "string") rawPath = url["path"];
    else rawPath = postmanString(url["raw"]);
  } else rawPath = postmanString(url);
  const [withoutQuery = "", search = ""] = rawPath.split("?", 2);
  let path = withoutQuery.trim();
  if (search && !Object.keys(query).length)
    for (const pair of search.split("&")) {
      const [key = "", value = ""] = pair.split("=", 2);
      if (key) query[decodeURIComponent(key)] = decodeURIComponent(value);
    }
  const absolute = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(path);
  if (absolute) {
    context.warn(`the request host ${absolute[0]} is ignored; the target is always the registered HTTP_API resource`, request);
    path = path.slice(absolute[0].length);
  } else path = path.replace(/^\{\{[^{}]+\}\}/, "");
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/(^|\/):([A-Za-z_][\w-]*)/g, (_match, slash: string, name: string) => {
    const value = pathVariables.get(name);
    return `${slash}${value ? value : `{{${name}}}`}`;
  });
  const prefix = options.stripPathPrefix ? normalizeApiPath(options.stripPathPrefix) : "";
  if (prefix && prefix !== "/" && (path === prefix || path.startsWith(`${prefix}/`))) path = path.slice(prefix.length) || "/";
  return {
    path: context.text(path, request),
    query: Object.fromEntries(Object.entries(query).map(([key, value]) => [key, context.text(value, request)])),
  };
}

// A non-bearer scheme is imported without its credential rather than skipped: the step still
// runs, the resource secretRef may satisfy it, and if it does not the failure is run evidence.
function bearerVariable(auth: unknown, context: ImportContext, request: string): { bearerFrom?: string } {
  if (!isRecord(auth) || auth["type"] === "noauth" || auth["type"] === undefined) return {};
  if (auth["type"] !== "bearer") {
    context.warn(`${String(auth["type"])} auth is not supported by the HTTP runner; only the resource secretRef (Bearer) authenticates this request`, request);
    return {};
  }
  const entries = Array.isArray(auth["bearer"]) ? auth["bearer"] : [];
  const token = entries.find((entry) => isRecord(entry) && entry["key"] === "token");
  const value = isRecord(token) ? postmanString(token["value"]) : "";
  const variable = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(value.trim());
  if (!variable?.[1]) {
    context.warn("an inline bearer token was dropped; the resource secretRef authenticates instead", request);
    return {};
  }
  const name = context.name(variable[1], request);
  return name ? { bearerFrom: name } : {};
}

function importRequest(flat: FlatRequest, context: ImportContext, options: PostmanImportOptions): { step?: ValidationScenarioStep; skip?: string } {
  const request = flat.item["request"];
  const label = `${flat.group} › ${flat.name}`;
  const definition: Record<string, unknown> = isRecord(request) ? request : { url: request, method: "GET" };
  const method = String(definition["method"] ?? "GET").toUpperCase();
  if (!supportedMethods.has(method as HttpMethod)) return { skip: `${method} is not executable by the HTTP runner` };
  const { path, query } = requestPath(definition["url"], context, label, options);
  const headers: Record<string, string> = {};
  let bearerFrom: string | undefined;
  for (const header of Array.isArray(definition["header"]) ? definition["header"] : []) {
    if (!isRecord(header) || header["disabled"] === true || typeof header["key"] !== "string") continue;
    const key = header["key"].trim();
    const value = postmanString(header["value"]);
    if (/^authorization$/i.test(key)) {
      const variable = /^Bearer\s+\{\{\s*([^{}]+?)\s*\}\}$/i.exec(value.trim());
      if (variable?.[1]) bearerFrom = context.name(variable[1], label);
      else context.warn("an Authorization header without a {{variable}} bearer was dropped; the resource secretRef authenticates instead", label);
      continue;
    }
    if (/^(cookie|proxy-authorization|x-api-key)$/i.test(key)) {
      context.warn(`the ${key} header was dropped; credentials travel only through the resource secretRef`, label);
      continue;
    }
    headers[key] = context.text(value, label);
  }
  if (!bearerFrom)
    bearerFrom = bearerVariable(definition["auth"] === undefined ? flat.auth : definition["auth"], context, label).bearerFrom;
  let body: unknown;
  const rawBody = isRecord(definition["body"]) ? definition["body"] : undefined;
  if (rawBody && rawBody["disabled"] !== true && rawBody["mode"] !== undefined) {
    if (rawBody["mode"] !== "raw")
      return { skip: `${String(rawBody["mode"])} bodies are not supported by the HTTP runner (JSON and text only)` };
    const text = typeof rawBody["raw"] === "string" ? rawBody["raw"] : "";
    if (text.trim()) {
      const parsed = parseTemplatedJson(text);
      if (parsed.ok) body = context.deep(parsed.value, label);
      else {
        body = context.text(text, label);
        if (!Object.keys(headers).some((key) => /^content-type$/i.test(key)))
          headers["content-type"] = "text/plain";
      }
    }
  }
  try {
    validatedHeaders(headers);
    validateNoInlineSecrets(body);
  } catch (error) {
    return { skip: `${sanitizedError(error).message}; authenticate through the resource secretRef or a bearerFrom variable instead` };
  }
  const prerequest = scriptLines(flat.item, "prerequest").filter((line) => !structuralLine.test(line.trim()));
  if (prerequest.length) context.warn(`${prerequest.length} pre-request script line(s) are not executed by the HTTP runner`, label);
  const tests = translatePostmanTests(scriptLines(flat.item, "test"), context, label);
  if (tests.untranslated.length)
    context.warn(`${tests.untranslated.length} test script line(s) have no runner equivalent, e.g. ${tests.untranslated[0]}`, label);
  if (tests.expectedStatus === undefined)
    context.warn("no status assertion in the request's tests: the step passes on any HTTP status", label);
  if (tests.assertions.length > 20) context.warn(`${tests.assertions.length - 20} assertion(s) beyond the 20-per-step limit were dropped`, label);
  const parsed = validationScenarioStepSchema.safeParse({
    name: flat.name.slice(0, 120),
    method,
    path,
    headers,
    query,
    ...(body === undefined ? {} : { body }),
    ...(tests.expectedStatus === undefined ? {} : { expectedStatus: tests.expectedStatus }),
    extract: tests.extract,
    ...(bearerFrom ? { bearerFrom } : {}),
    assertions: tests.assertions.slice(0, 20),
  });
  if (!parsed.success) return { skip: `the request does not form a valid scenario step: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  return { step: parsed.data };
}

function referencedVariables(step: ValidationScenarioStep): string[] {
  const text = JSON.stringify([step.path, step.query, step.headers, step.body ?? null]);
  return [...text.matchAll(/\{\{([a-z][a-z0-9_]{0,63})\}\}/g)].map((match) => match[1] ?? "");
}

/**
 * Imports a Postman v2.0/v2.1 collection into scenario definitions, in collection order. Each
 * top-level folder becomes one scenario (split into parts of 20 steps); requests at the root form
 * a scenario named after the collection. Static collection variables are inlined, a host
 * variable is dropped because the target is always the registered resource, and variables an
 * earlier step does not extract are reported, since the run would stop on them.
 */
export function importPostmanCollection(document: unknown, options: PostmanImportOptions = {}): PostmanImportResult {
  if (!isRecord(document) || !Array.isArray(document["item"]))
    throw new InvalidState("Postman import requires a v2.0 or v2.1 collection with an item array");
  const info = isRecord(document["info"]) ? document["info"] : {};
  const schema = postmanString(info["schema"]);
  if (schema && !/schema\.getpostman\.com|postman/i.test(schema))
    throw new InvalidState("The document is not a Postman collection");
  const staticValues = new Map<string, string>();
  const ignoredVariables: string[] = [];
  for (const variable of Array.isArray(document["variable"]) ? document["variable"] : []) {
    if (!isRecord(variable) || typeof variable["key"] !== "string" || variable["disabled"] === true) continue;
    const value = variable["value"] === undefined ? "" : String(variable["value"]);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || secretLike(variable["key"]) || value === "") ignoredVariables.push(variable["key"]);
    else staticValues.set(variable["key"], value);
  }
  const context = new ImportContext(staticValues);
  for (const name of ignoredVariables)
    if (secretLike(name)) context.warn(`collection variable {{${name}}} looks secret-bearing and was not inlined`);
  const collectionName = postmanString(info["name"]) || "Collection";
  const flat = flatten(document);
  const skipped: PostmanImportResult["skipped"] = [];
  const groups = new Map<string, ValidationScenarioStep[]>();
  const defined = new Set<string>();
  for (const request of flat) {
    const label = `${request.group} › ${request.name}`;
    const imported = importRequest(request, context, options);
    if (!imported.step) {
      skipped.push({ request: label, reason: imported.skip ?? "not importable" });
      continue;
    }
    const step = imported.step;
    for (const name of referencedVariables(step).concat(step.bearerFrom ? [step.bearerFrom] : []))
      if (!defined.has(name))
        context.warn(`{{${name}}} is not extracted by any earlier request; the run will stop at this step until a scenario before it extracts it`, label);
    for (const name of Object.keys(step.extract)) defined.add(name);
    groups.set(request.group, [...(groups.get(request.group) ?? []), step]);
  }
  const scenarios: ImportedScenario[] = [];
  const description = postmanString(info["description"]).slice(0, 800);
  for (const [group, steps] of groups) {
    const parts = Math.ceil(steps.length / collectionLimits.maxStepsPerScenario);
    for (let part = 0; part < parts; part += 1) {
      const suffix = parts > 1 ? ` (${part + 1}/${parts})` : "";
      scenarios.push({
        name: `${group.slice(0, 120 - suffix.length)}${suffix}`,
        description: `Imported from Postman collection "${collectionName}"${description ? `: ${description}` : ""}`.slice(0, 1_000),
        steps: steps.slice(part * collectionLimits.maxStepsPerScenario, (part + 1) * collectionLimits.maxStepsPerScenario),
      });
    }
  }
  return {
    collectionName,
    requestCount: flat.length,
    importedSteps: scenarios.reduce((sum, scenario) => sum + scenario.steps.length, 0),
    scenarios,
    skipped,
    warnings: context.warnings,
    variables: context.variables,
  };
}

// ---------------------------------------------------------------------------
// Whole-collection run
// ---------------------------------------------------------------------------

/** The saved scenarios of one resource, in the order they were created (import order). */
export function collectionScenarios(artifacts: Artifact[], resourceId: string): Artifact[] {
  const order = (artifact: Artifact) => {
    const collection = (artifact.content as { collection?: { index?: unknown } } | undefined)?.collection;
    return typeof collection?.index === "number" ? collection.index : 0;
  };
  return artifacts
    .filter(
      (artifact) =>
        artifact.kind === "VALIDATION_SCENARIO" &&
        artifact.status !== "DELETED" &&
        (artifact.content as { resourceId?: unknown } | undefined)?.resourceId === resourceId,
    )
    .map((artifact, position) => ({ artifact, position }))
    .sort(
      (left, right) =>
        left.artifact.createdAt.localeCompare(right.artifact.createdAt) ||
        order(left.artifact) - order(right.artifact) ||
        left.position - right.position,
    )
    .map(({ artifact }) => artifact);
}

/** Every request a set of saved scenarios declares, for DECLARED coverage. */
export function declaredRequests(artifacts: Artifact[]): ExercisedRequest[] {
  return artifacts.flatMap((artifact) => {
    const content = (artifact.content ?? {}) as { name?: unknown; steps?: unknown };
    const steps = Array.isArray(content.steps) ? content.steps : [];
    return steps.filter(isRecord).map((step) => ({
      scenario: typeof content.name === "string" ? content.name : artifact.id,
      step: typeof step["name"] === "string" ? step["name"] : "",
      method: typeof step["method"] === "string" ? step["method"] : "",
      path: typeof step["path"] === "string" ? step["path"] : "",
    }));
  });
}

export type CollectionScenarioStatus = "PASSED" | "FAILED" | "ERROR" | "SKIPPED";
export interface CollectionScenarioResult {
  scenarioId: string;
  scenarioName: string;
  status: CollectionScenarioStatus;
  executionId?: string;
  summary?: ScenarioExecutionResult["summary"];
  error?: { code: string; message: string };
}
export interface CollectionExecutionResult {
  executionId: string;
  projectId: string;
  resourceId: string;
  environment: Project["environment"];
  status: "PASSED" | "FAILED" | "ERROR";
  verdict: CollectionVerdict;
  reasons: string[];
  humanSummary: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  summary: {
    scenarios: number;
    passedScenarios: number;
    failedScenarios: number;
    skippedScenarios: number;
    requests: number;
    passedRequests: number;
  };
  inventorySource: "INLINE" | "REPOSITORY" | "API_CONTRACT" | "NONE";
  /** The exact repository commit the inventory was read from, for a REPOSITORY inventory. */
  inventoryCommitSha?: string;
  coverage: ApiCoverageReport;
  scenarios: CollectionScenarioResult[];
  resultArtifactId: string;
}

export interface HttpCollectionRunnerDependencies {
  store: StateStore;
  artifacts: ArtifactWriter;
  clock: Clock;
  secrets?: SecretResolver;
  fetchImpl?: FetchLike;
  limits?: HttpRunnerLimits;
  maxCollectionDurationMs?: number;
}

export class HttpCollectionRunner {
  constructor(private readonly deps: HttpCollectionRunnerDependencies) {}

  /**
   * Resolves the resource and the exact scenario list before anything is sent. Each scenario is
   * then executed by the single HttpScenarioRunner, which re-applies PolicyEngine authorization,
   * target containment and redaction per scenario -- this class adds ordering, shared variables,
   * coverage and the verdict, and no request capability of its own.
   */
  async run(input: {
    projectId: string;
    resourceId: string;
    scenarioIds?: string[];
    operationId: string;
    actor: string;
    inventory?: ApiInventory;
    inventorySource: CollectionExecutionResult["inventorySource"];
    inventoryCommitSha?: string;
  }): Promise<CollectionExecutionResult> {
    const project = await this.deps.store.getProject(input.projectId);
    if (!project) throw new NotFound("Project not found", { projectId: input.projectId });
    if (project.environment === "PRODUCTION" || project.autonomyMode === "AUTONOMOUS_PRODUCTION")
      throw new UnsupportedOperation("Production HTTP collection execution is NOT_SUPPORTED");
    const resource = await this.deps.store.getResource(input.resourceId);
    if (!resource || resource.projectId !== input.projectId)
      throw new PolicyViolation("Collection resource is not owned by this project", {
        projectId: input.projectId,
        resourceId: input.resourceId,
      });
    resolveHttpApiTarget(resource);
    const artifacts = await this.deps.store.listArtifacts(input.projectId);
    const all = collectionScenarios(artifacts, input.resourceId);
    let selected: Artifact[];
    if (input.scenarioIds?.length) {
      const byId = new Map(all.map((artifact) => [artifact.id, artifact]));
      selected = input.scenarioIds.map((id) => {
        const artifact = byId.get(id);
        if (!artifact)
          throw new PolicyViolation("Scenario is not a saved scenario of this project's resource", {
            scenarioId: id,
            resourceId: input.resourceId,
          });
        return artifact;
      });
    } else selected = all;
    if (!selected.length) throw new InvalidState("The resource has no saved scenarios; import a collection or create scenarios first");
    if (selected.length > collectionLimits.maxScenariosPerRun)
      throw new PolicyViolation(
        `A collection run executes at most ${collectionLimits.maxScenariosPerRun} scenarios; pass scenarioIds to run it in parts`,
      );
    const runner = new HttpScenarioRunner({
      store: this.deps.store,
      artifacts: this.deps.artifacts,
      clock: this.deps.clock,
      ...(this.deps.secrets ? { secrets: this.deps.secrets } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.limits ? { limits: this.deps.limits } : {}),
    });
    const budget = this.deps.maxCollectionDurationMs ?? collectionLimits.maxCollectionDurationMs;
    const startedAt = this.deps.clock.now();
    const startedMs = performance.now();
    const variables: ScenarioVariables = new Map();
    const scenarios: CollectionScenarioResult[] = [];
    const requests: ExercisedRequest[] = [];
    for (const [index, artifact] of selected.entries()) {
      const scenarioName = String((artifact.content as { name?: unknown }).name ?? artifact.id);
      if (performance.now() - startedMs > budget) {
        scenarios.push({ scenarioId: artifact.id, scenarioName, status: "SKIPPED" });
        continue;
      }
      try {
        const result = await runner.run({
          projectId: input.projectId,
          scenarioId: artifact.id,
          operationId: `${input.operationId}#${index}`,
          actor: input.actor,
          variables,
        });
        scenarios.push({
          scenarioId: artifact.id,
          scenarioName,
          status: result.status,
          executionId: result.executionId,
          summary: result.summary,
        });
        for (const step of result.steps)
          requests.push({
            scenario: scenarioName,
            step: step.name,
            method: step.method,
            path: step.path,
            status: step.status,
            ...(step.httpStatus === undefined ? {} : { httpStatus: step.httpStatus }),
          });
      } catch (error) {
        scenarios.push({ scenarioId: artifact.id, scenarioName, status: "ERROR", error: sanitizedError(error) });
      }
    }
    const coverage = computeApiCoverage(input.inventory, requests, "EXECUTED");
    const passedScenarios = scenarios.filter((value) => value.status === "PASSED").length;
    const skippedScenarios = scenarios.filter((value) => value.status === "SKIPPED").length;
    const failedScenarios = scenarios.length - passedScenarios - skippedScenarios;
    const { verdict, reasons } = collectionVerdict({ scenarios: scenarios.length, passedScenarios, skippedScenarios, coverage });
    const status = scenarios.some((value) => value.status === "ERROR")
      ? "ERROR"
      : passedScenarios === scenarios.length
        ? "PASSED"
        : "FAILED";
    const summary = {
      scenarios: scenarios.length,
      passedScenarios,
      failedScenarios,
      skippedScenarios,
      requests: requests.filter((value) => value.status !== "SKIPPED").length,
      passedRequests: requests.filter((value) => value.status === "PASSED").length,
    };
    const coverageLine =
      coverage.status === "NO_INVENTORY"
        ? "покрытие API не определено: нет контракта OpenAPI"
        : `покрыто ${coverage.coveredOperations} из ${coverage.totalOperations} операций API (${coverage.coveragePercent}%)`;
    const humanSummary =
      verdict === "PROVEN"
        ? `Коллекция доказана: ${passedScenarios} сценариев пройдено, ${coverageLine}.`
        : `Коллекция НЕ доказана: ${passedScenarios} из ${scenarios.length} сценариев пройдено, ${coverageLine}.`;
    const completedAt = this.deps.clock.now();
    const durationMs = Math.round(performance.now() - startedMs);
    const artifact = await this.deps.artifacts.write(input.projectId, "VALIDATION_REPORT", {
      reportVersion: COLLECTION_REPORT_VERSION,
      operationId: input.operationId,
      projectId: input.projectId,
      environment: project.environment,
      suite: "COLLECTION",
      resourceId: input.resourceId,
      actor: input.actor,
      startedAt,
      finishedAt: completedAt,
      completedAt,
      durationMs,
      // `result` and `counts` keep the VALIDATION_REPORT shape the Console already reads; PASS is
      // reserved for a PROVEN collection, never for "the requests that exist happened to pass".
      result: verdict === "PROVEN" ? "PASS" : "FAIL",
      status,
      verdict,
      reasons,
      counts: { passed: passedScenarios, failed: failedScenarios, skipped: skippedScenarios },
      summary,
      humanSummary,
      inventorySource: input.inventorySource,
      ...(input.inventoryCommitSha ? { inventoryCommitSha: input.inventoryCommitSha } : {}),
      coverage,
      scenarios,
    });
    return {
      executionId: artifact.id,
      projectId: input.projectId,
      resourceId: input.resourceId,
      environment: project.environment,
      status,
      verdict,
      reasons,
      humanSummary,
      startedAt,
      completedAt,
      durationMs,
      summary,
      inventorySource: input.inventorySource,
      ...(input.inventoryCommitSha ? { inventoryCommitSha: input.inventoryCommitSha } : {}),
      coverage,
      scenarios,
      resultArtifactId: artifact.id,
    };
  }
}

// ---------------------------------------------------------------------------
// Published tool contracts
// ---------------------------------------------------------------------------

export const collectionImportToolName = "superadmin_collection_import";
export const collectionImportToolDescription =
  "Import a project's whole Postman collection (v2.0/v2.1) as saved validation scenarios bound to its registered HTTP_API resource: one scenario per top-level folder in collection order, split into parts of 20 steps; status, header, body-field and response-time tests become assertions and pm.*.set(...) from the response body becomes extraction. Static collection variables are inlined, the host is always the registered resource, credentials travel only through the resource secretRef or bearerFrom. Every request or script line the runner cannot express is returned in skipped/warnings, never dropped silently.";
export const collectionRunToolName = "superadmin_collection_run";
export const collectionRunToolDescription =
  "Run the whole API collection of one registered HTTP_API resource (every saved scenario, in order, with variables shared across scenarios like a Postman collection run) and measure it against the project's OpenAPI inventory. The verdict is PROVEN only when every scenario passed AND every documented operation was exercised by a passing request; otherwise NOT_PROVEN with the reasons and the list of uncovered operations. Persists one redacted VALIDATION_REPORT (suite COLLECTION) plus one report per scenario.";
export const apiCoverageToolName = "superadmin_api_coverage";
export const apiCoverageToolDescription =
  "Read-only: compare the saved validation scenarios of a project (optionally one HTTP_API resource) with the project's whole OpenAPI inventory and list every operation no scenario exercises yet, with a runnable draft step for each, so the full collection can be completed before superadmin_collection_run.";

const toolRef = z.string().min(1).max(255);
/** Read the inventory from every contract in a registered GitHub repository at one commit. */
const contractRepository = z
  .object({ resourceId: z.string().uuid(), ref: toolRef.optional() })
  .optional()
  .describe("Build the inventory from every OpenAPI contract in this registered GitHub repository at ref (default branch when omitted)");
const inlineDocument = z.union([z.record(z.unknown()), z.string().max(collectionLimits.maxDocumentBytes)]);
const toolEntityId = z.string().uuid();
const toolOperationId = z.string().min(8).max(200);
export const collectionImportToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
export const collectionImportToolInputSchema = {
  operationId: toolOperationId,
  projectId: toolEntityId,
  resourceId: toolEntityId,
  taskId: toolEntityId.optional(),
  collection: inlineDocument
    .optional()
    .describe("The Postman collection export (v2.0/v2.1), as an object or JSON text; or name it with collectionSource"),
  collectionSource: z
    .object({ resourceId: toolEntityId, ref: toolRef.optional(), path: z.string().min(1).max(500) })
    .optional()
    .describe("A Postman collection file in a registered GitHub repository, read at the exact commit of ref (default branch when omitted)"),
  stripPathPrefix: z
    .string()
    .regex(/^\/[A-Za-z0-9._~/-]{0,200}$/)
    .optional()
    .describe('Path prefix the registered resource base URL already carries, e.g. "/api/v1"'),
};
export const collectionRunToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
export const collectionRunToolInputSchema = {
  operationId: toolOperationId,
  projectId: toolEntityId,
  resourceId: toolEntityId,
  scenarioIds: z
    .array(toolEntityId)
    .min(1)
    .max(collectionLimits.maxScenariosPerRun)
    .optional()
    .describe("Run only these saved scenarios, in this order; omitted, every scenario of the resource runs in creation order"),
  contractRepository,
  openapi: inlineDocument
    .optional()
    .describe("The API's OpenAPI document; omitted, the project's latest API_CONTRACT artifact is the inventory"),
};
export const apiCoverageToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
export const apiCoverageToolInputSchema = {
  projectId: toolEntityId,
  resourceId: toolEntityId.optional(),
  contractRepository,
  openapi: inlineDocument
    .optional()
    .describe("The API's OpenAPI document; omitted, the project's latest API_CONTRACT artifact is the inventory"),
};
