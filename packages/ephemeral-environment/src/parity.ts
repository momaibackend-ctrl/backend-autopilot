// Behavioural parity between two implementations of one API (ADR 018, stage 3).
//
// Two PROVEN verdicts against the same contract say each implementation passed the checks; they
// do not say the implementations behave the same. A Kotlin original and its Java port can both
// answer 200 with bodies that differ in a field, a nested shape or an error code, and every
// assertion the collection happens to make can still pass. Parity runs the same scenarios against
// both and compares every exchanged response step by step.
//
// Values that legitimately differ between two runs -- generated ids, UUIDs, timestamps, tokens --
// are replaced by their type before comparison, so they are compared as "an id is present" rather
// than byte for byte. Anything that cannot be compared (a body truncated in the evidence, a step
// one side never reached) is reported as such and keeps the verdict from MATCH: a check that was
// not made is not a match.
import { z } from "zod";

export const PARITY_MAX_DIFFERENCES = 500;

export interface ComparableStep {
  scenario: string;
  index: number;
  step: string;
  method: string;
  path: string;
  status: string;
  httpStatus?: number;
  contentType?: string;
  body?: unknown;
  bodyTruncated: boolean;
}

export const parityDifferenceSchema = z.object({
  scenario: z.string(),
  step: z.string(),
  kind: z.enum(["MISSING_IN_SUBJECT", "MISSING_IN_REFERENCE", "OUTCOME", "STATUS", "CONTENT_TYPE", "BODY", "UNCOMPARED"]),
  path: z.string().optional(),
  reference: z.unknown().optional(),
  subject: z.unknown().optional(),
});
export type ParityDifference = z.infer<typeof parityDifferenceSchema>;
export const parityReportSchema = z.object({
  verdict: z.enum(["MATCH", "MISMATCH"]),
  comparedSteps: z.number().int().nonnegative(),
  matchedSteps: z.number().int().nonnegative(),
  uncomparedSteps: z.number().int().nonnegative(),
  differences: z.array(parityDifferenceSchema),
  differenceCount: z.number().int().nonnegative(),
});
export type ParityReport = z.infer<typeof parityReportSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Reads the per-scenario VALIDATION_REPORT contents an environment run collects. */
export function stepsFromReports(reports: unknown[]): ComparableStep[] {
  const steps: ComparableStep[] = [];
  for (const report of reports) {
    if (!isRecord(report)) continue;
    const scenario = typeof report["scenarioName"] === "string" ? report["scenarioName"] : "";
    for (const raw of Array.isArray(report["steps"]) ? report["steps"] : []) {
      if (!isRecord(raw)) continue;
      const response = isRecord(raw["response"]) ? raw["response"] : undefined;
      const headers = response && isRecord(response["headers"]) ? response["headers"] : {};
      const contentType = typeof headers["content-type"] === "string" ? headers["content-type"].split(";")[0]?.trim().toLowerCase() : undefined;
      const body = response?.["body"];
      steps.push({
        scenario,
        index: typeof raw["index"] === "number" ? raw["index"] : steps.length,
        step: typeof raw["name"] === "string" ? raw["name"] : "",
        method: typeof raw["method"] === "string" ? raw["method"] : "",
        path: typeof raw["path"] === "string" ? raw["path"] : "",
        status: typeof raw["status"] === "string" ? raw["status"] : "",
        ...(typeof raw["httpStatus"] === "number" ? { httpStatus: raw["httpStatus"] } : {}),
        ...(contentType ? { contentType } : {}),
        ...(response ? { body } : {}),
        bodyTruncated: response?.["truncated"] === true || (isRecord(body) && body["truncated"] === true && "preview" in body),
      });
    }
  }
  return steps;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isoDateTime = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const jwt = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
// Keys whose values are generated per run: identifiers, timestamps, versions, ETags. Business
// dates (birthDate, dueDate) are NOT here -- they are data, and a port that changes one is wrong.
const volatileKey = /^(id|uuid|guid|etag|version|timestamp)$|(_id|Id|_uuid|Uuid|_at|At)$|^(created|updated|modified|deleted|expires|issued)(_?at|_?on)?$/;

function marker(value: unknown): string {
  if (value === null) return "<null>";
  return `<${Array.isArray(value) ? "array" : typeof value}>`;
}

/** Replaces run-specific values by their type. Idempotent: normalizing twice changes nothing. */
export function normalizeBody(value: unknown, key?: string): unknown {
  // A marker is already normalized; turning "<number>" into "<string>" would break idempotence.
  if (typeof value === "string" && /^<[^<>]+>$/.test(value)) return value;
  // The instant differs per run; its format is API behaviour, so the format is what is compared --
  // also under a volatile key such as createdAt, where the value alone would be erased.
  if (typeof value === "string" && isoDateTime.test(value)) return `<datetime:${value.replace(/\d/g, "d")}>`;
  if (key !== undefined && volatileKey.test(key) && (typeof value === "string" || typeof value === "number")) return marker(value);
  if (typeof value === "string") {
    if (uuid.test(value)) return "<uuid>";
    if (jwt.test(value)) return "<token>";
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => normalizeBody(entry));
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((name) => [name, normalizeBody(value[name], name)]));
  return value;
}

/** The first few JSON paths where two normalized values differ. */
export function differingPaths(left: unknown, right: unknown, path = "$", limit = 5): Array<{ path: string; reference: unknown; subject: unknown }> {
  if (JSON.stringify(left) === JSON.stringify(right)) return [];
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return [{ path: `${path}.length`, reference: left.length, subject: right.length }];
    const found: Array<{ path: string; reference: unknown; subject: unknown }> = [];
    for (let index = 0; index < left.length && found.length < limit; index += 1) found.push(...differingPaths(left[index], right[index], `${path}[${index}]`, limit - found.length));
    return found;
  }
  if (isRecord(left) && isRecord(right)) {
    const found: Array<{ path: string; reference: unknown; subject: unknown }> = [];
    for (const name of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      if (found.length >= limit) break;
      if (!(name in left)) found.push({ path: `${path}.${name}`, reference: "<absent>", subject: marker(right[name]) });
      else if (!(name in right)) found.push({ path: `${path}.${name}`, reference: marker(left[name]), subject: "<absent>" });
      else found.push(...differingPaths(left[name], right[name], `${path}.${name}`, limit - found.length));
    }
    return found;
  }
  return [{ path, reference: left, subject: right }];
}

/**
 * Compares the reference implementation's run with the subject's, step by step. Steps are paired
 * by scenario and position, since both runs execute the same scenarios in the same order.
 */
export function compareExecutions(reference: ComparableStep[], subject: ComparableStep[]): ParityReport {
  const key = (step: ComparableStep) => `${step.scenario}\u0000${step.index}`;
  const subjectByKey = new Map(subject.map((step) => [key(step), step]));
  const referenceKeys = new Set(reference.map(key));
  const differences: ParityDifference[] = [];
  let matched = 0;
  let uncompared = 0;
  const add = (difference: ParityDifference) => {
    differences.push(difference);
  };
  for (const left of reference) {
    const right = subjectByKey.get(key(left));
    const label = { scenario: left.scenario, step: left.step || `${left.method} ${left.path}` };
    if (!right) {
      add({ ...label, kind: "MISSING_IN_SUBJECT" });
      continue;
    }
    const before = differences.length;
    if (left.status !== right.status) add({ ...label, kind: "OUTCOME", reference: left.status, subject: right.status });
    if (left.httpStatus !== right.httpStatus) add({ ...label, kind: "STATUS", reference: left.httpStatus ?? "<none>", subject: right.httpStatus ?? "<none>" });
    if (left.contentType !== right.contentType) add({ ...label, kind: "CONTENT_TYPE", reference: left.contentType ?? "<none>", subject: right.contentType ?? "<none>" });
    if (left.bodyTruncated || right.bodyTruncated) {
      uncompared += 1;
      add({ ...label, kind: "UNCOMPARED", reference: left.bodyTruncated ? "<truncated>" : "<complete>", subject: right.bodyTruncated ? "<truncated>" : "<complete>" });
    } else
      for (const found of differingPaths(normalizeBody(left.body), normalizeBody(right.body)))
        add({ ...label, kind: "BODY", path: found.path, reference: found.reference, subject: found.subject });
    if (differences.length === before) matched += 1;
  }
  for (const right of subject)
    if (!referenceKeys.has(key(right))) add({ scenario: right.scenario, step: right.step || `${right.method} ${right.path}`, kind: "MISSING_IN_REFERENCE" });
  return {
    verdict: differences.length ? "MISMATCH" : "MATCH",
    comparedSteps: reference.length,
    matchedSteps: matched,
    uncomparedSteps: uncompared,
    differences: differences.slice(0, PARITY_MAX_DIFFERENCES),
    differenceCount: differences.length,
  };
}
