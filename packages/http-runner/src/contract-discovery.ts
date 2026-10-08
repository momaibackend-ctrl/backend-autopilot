// Every API contract and Postman collection a repository holds, found by the autopilot itself.
//
// The collection run measured coverage against one document: whatever OpenAPI file a caller
// passed, or the last API_CONTRACT the execution runner recorded. A product whose API is split
// into several contracts -- a root openapi.json plus separate check-in and onboarding contracts,
// say -- then had most of its surface outside the denominator, and "100% covered" could mean
// "100% of the one file somebody remembered". This module reads the repository at one exact
// commit, finds every contract and collection in it, resolves split path items behind $ref, and
// merges the result into one inventory that remembers which contract documents each operation.
//
// Anything it could not see -- a contract that does not parse, a $ref that does not resolve, a
// tree listing the host cut short, a candidate past the read budget -- is recorded as an inventory
// gap, and a gap keeps every collection verdict NOT_PROVEN. Like the rest of the runner it uses
// Web APIs only (plus the pure `yaml` parser), so it runs in the Deno Edge MCP and in Node.
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { extractApiOperations, importPostmanCollection, type ApiInventory, type ApiOperation } from "./collection.js";

export const discoveryLimits = {
  /** Files read from one repository in one discovery; the rest is recorded as a gap. */
  maxReads: 150,
  /** A candidate larger than this is not read. */
  maxFileBytes: 4 * 1024 * 1024,
  /** Distinct files followed through external $ref per discovery. */
  maxRefFiles: 100,
};

/** A repository pinned to one commit. Implemented over an already authorized resource. */
export interface RepositoryContentSource {
  commitSha: string;
  listFiles(): Promise<{ files: Array<{ path: string; size: number }>; truncated: boolean }>;
  readFile(path: string): Promise<string | undefined>;
}

const structuredFile = /\.(json|ya?ml)$/i;
// Directories that hold build output, dependencies or VCS state: a contract copied there is a
// generated duplicate, never the source of truth.
const ignoredDirectory = /(^|\/)(node_modules|\.git|\.gradle|\.idea|\.vscode|build|dist|out|target|vendor|coverage|\.next|bin|obj)(\/|$)/i;
const contractName = /(openapi|swagger|api[-_.]?(spec|docs?|contract)|postman|collection|\.api\.)/i;
const contractDirectory = /(^|\/)(api|apis|contracts?|openapi|swagger|specs?|docs?|postman|collections?|schemas?)(\/|$)/i;
// Configuration files that are JSON/YAML but never an API document; reading them only spends budget.
const knownNonContract = /(^|\/)(package(-lock)?\.json|tsconfig[^/]*\.json|composer\.(json|lock)|\.eslintrc[^/]*|renovate\.json|docker-compose[^/]*\.ya?ml|pnpm-lock\.yaml|yarn\.lock|\.github\/[^]*|application[^/]*\.ya?ml|bootstrap[^/]*\.ya?ml|logback[^/]*)$/i;

/**
 * Files worth opening, best candidates first: anything named like a contract or a collection, then
 * structured files inside an api/contracts/docs/spec-like directory. Content decides in the end.
 */
export function contractCandidatePaths(files: Array<{ path: string; size: number }>): {
  candidates: string[];
  oversized: string[];
} {
  const named: string[] = [];
  const located: string[] = [];
  const oversized: string[] = [];
  for (const file of files) {
    if (!structuredFile.test(file.path) || ignoredDirectory.test(file.path) || knownNonContract.test(file.path)) continue;
    const name = file.path.split("/").at(-1) ?? "";
    const isNamed = contractName.test(name);
    if (!isNamed && !contractDirectory.test(file.path)) continue;
    if (file.size > discoveryLimits.maxFileBytes) {
      oversized.push(file.path);
      continue;
    }
    (isNamed ? named : located).push(file.path);
  }
  const order = (left: string, right: string) => left.split("/").length - right.split("/").length || left.localeCompare(right);
  return { candidates: [...named.sort(order), ...located.sort(order)], oversized: oversized.sort(order) };
}

/** JSON first (it is valid YAML too, but JSON errors are clearer), then YAML. */
export function parseStructuredDocument(path: string, text: string): unknown {
  if (/\.json$/i.test(path)) return JSON.parse(text);
  return parseYaml(text, { maxAliasCount: 100 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Classifies a parsed document without trusting its file name. */
export function documentKind(document: unknown): "OPENAPI" | "POSTMAN" | "OTHER" {
  if (!isRecord(document)) return "OTHER";
  if ((typeof document["openapi"] === "string" || document["swagger"] === "2.0") && isRecord(document["paths"])) return "OPENAPI";
  const info = isRecord(document["info"]) ? document["info"] : undefined;
  const schema = typeof info?.["schema"] === "string" ? info["schema"] : "";
  if (Array.isArray(document["item"]) && (/postman/i.test(schema) || typeof info?.["_postman_id"] === "string")) return "POSTMAN";
  return "OTHER";
}

/** Joins a relative $ref file onto the directory of the document that names it. */
export function resolveRelativePath(fromFile: string, reference: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith("/")) return undefined;
  const parts = fromFile.split("/").slice(0, -1);
  for (const segment of reference.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join("/");
}

function pointer(document: unknown, fragment: string): unknown {
  if (!fragment || fragment === "/") return document;
  let value = document;
  for (const raw of fragment.replace(/^\//, "").split("/")) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isRecord(value) && !Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * Inlines path items that live behind a `$ref` -- local (`#/components/pathItems/X`) or in another
 * repository file (`./paths/checkin.yaml`, `common.yaml#/paths/~1health`). A path item that still
 * cannot be resolved stays a `$ref`, which `extractApiOperations` records as an inventory gap.
 */
export async function resolvePathItemRefs(
  document: Record<string, unknown>,
  documentPath: string,
  load: (path: string) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const paths = document["paths"];
  if (!isRecord(paths)) return document;
  const resolved: Record<string, unknown> = {};
  for (const [path, item] of Object.entries(paths)) {
    const reference = isRecord(item) && typeof item["$ref"] === "string" ? item["$ref"] : undefined;
    if (!reference) {
      resolved[path] = item;
      continue;
    }
    const [file = "", fragment = ""] = reference.split("#", 2);
    let target: unknown;
    if (!file) target = pointer(document, fragment);
    else {
      const filePath = resolveRelativePath(documentPath, file);
      target = filePath ? pointer(await load(filePath), fragment) : undefined;
    }
    resolved[path] = isRecord(target) ? { ...target, ...Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([key]) => key !== "$ref")) } : item;
  }
  return { ...document, paths: resolved };
}

export interface DiscoveredContract {
  path: string;
  title?: string;
  version?: string;
  operations: number;
  excluded: number;
  gaps: number;
}
export interface DiscoveredCollection {
  path: string;
  name: string;
  requestCount: number;
}
export interface RepositoryApiDiscovery {
  commitSha: string;
  scannedFiles: number;
  candidates: number;
  contracts: DiscoveredContract[];
  collections: DiscoveredCollection[];
  /** Every operation of every contract; `contract`/`alsoIn` say which files document it. */
  inventory: ApiInventory;
}

/**
 * Reads one repository commit and returns every contract and collection in it, with the merged
 * inventory. Duplicates across contracts collapse into one operation that lists every contract
 * documenting it, so a shared endpoint is neither double-counted nor attributed to one file only.
 */
export async function discoverRepositoryApi(source: RepositoryContentSource): Promise<RepositoryApiDiscovery> {
  const listing = await source.listFiles();
  const gaps: NonNullable<ApiInventory["incomplete"]> = [];
  if (listing.truncated)
    gaps.push({ source: "repository tree", reason: "the host truncated the recursive file listing; contracts beyond it were not seen" });
  const { candidates, oversized } = contractCandidatePaths(listing.files);
  for (const path of oversized) gaps.push({ source: path, reason: `larger than ${discoveryLimits.maxFileBytes} bytes; not read` });
  const toRead = candidates.slice(0, discoveryLimits.maxReads);
  for (const path of candidates.slice(discoveryLimits.maxReads))
    gaps.push({ source: path, reason: `beyond the ${discoveryLimits.maxReads}-file read budget; not read` });

  const parsed = new Map<string, Promise<unknown>>();
  let refFiles = 0;
  const load = (path: string, followed = false): Promise<unknown> => {
    const cached = parsed.get(path);
    if (cached) return cached;
    if (followed && ++refFiles > discoveryLimits.maxRefFiles) return Promise.resolve(undefined);
    const value = source
      .readFile(path)
      .then((text) => (text === undefined ? undefined : parseStructuredDocument(path, text)))
      .catch(() => undefined);
    parsed.set(path, value);
    return value;
  };

  const contracts: DiscoveredContract[] = [];
  const collections: DiscoveredCollection[] = [];
  const operations: ApiOperation[] = [];
  const byKey = new Map<string, ApiOperation>();
  const excluded: ApiInventory["excluded"] = [];
  let title: string | undefined;
  let version: string | undefined;
  for (const path of toRead) {
    let document: unknown;
    try {
      const text = await source.readFile(path);
      if (text === undefined) {
        gaps.push({ source: path, reason: "listed in the tree but could not be read" });
        continue;
      }
      document = parseStructuredDocument(path, text);
      parsed.set(path, Promise.resolve(document));
    } catch {
      // A candidate that does not parse is only a gap when it looked like a contract by name;
      // a malformed fixture in a docs/ directory is not a hole in the API.
      if (contractName.test(path.split("/").at(-1) ?? "")) gaps.push({ source: path, reason: "could not be parsed as JSON or YAML" });
      continue;
    }
    const kind = documentKind(document);
    if (kind === "POSTMAN") {
      try {
        const imported = importPostmanCollection(document);
        collections.push({ path, name: imported.collectionName, requestCount: imported.requestCount });
      } catch (error) {
        gaps.push({ source: path, reason: `Postman collection could not be read: ${error instanceof Error ? error.message : "invalid"}` });
      }
      continue;
    }
    if (kind !== "OPENAPI") continue;
    let inventory: ApiInventory;
    try {
      const expanded = await resolvePathItemRefs(document as Record<string, unknown>, path, (target) => load(target, true));
      inventory = extractApiOperations(expanded);
    } catch (error) {
      gaps.push({ source: path, reason: `OpenAPI document could not be read: ${error instanceof Error ? error.message : "invalid"}` });
      continue;
    }
    title ??= inventory.title;
    version ??= inventory.version;
    contracts.push({
      path,
      ...(inventory.title === undefined ? {} : { title: inventory.title }),
      ...(inventory.version === undefined ? {} : { version: inventory.version }),
      operations: inventory.operations.length,
      excluded: inventory.excluded.length,
      gaps: inventory.incomplete?.length ?? 0,
    });
    for (const gap of inventory.incomplete ?? []) gaps.push({ source: `${path} ${gap.source}`, reason: gap.reason });
    excluded.push(...inventory.excluded);
    for (const operation of inventory.operations) {
      const key = `${operation.method} ${operation.path}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.alsoIn = [...(existing.alsoIn ?? []), path];
        continue;
      }
      const owned: ApiOperation = { ...operation, contract: path };
      byKey.set(key, owned);
      operations.push(owned);
    }
  }
  return {
    commitSha: source.commitSha,
    scannedFiles: listing.files.length,
    candidates: candidates.length,
    contracts,
    collections,
    inventory: {
      ...(title === undefined ? {} : { title }),
      ...(version === undefined ? {} : { version }),
      operations,
      excluded,
      ...(gaps.length ? { incomplete: gaps } : {}),
    },
  };
}

export const repositoryApiDiscoveryToolName = "superadmin_repository_api_discovery";
export const repositoryApiDiscoveryToolDescription =
  "Read-only: find every OpenAPI/Swagger contract and Postman collection in a registered GitHub repository at one exact commit, resolve path items split across files through $ref, and return the merged API inventory with the contract that documents each operation, plus every gap (unparseable contract, unresolved $ref, truncated listing) that would keep a collection run NOT_PROVEN.";
export const repositoryApiDiscoveryToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
export const repositoryApiDiscoveryToolInputSchema = {
  projectId: z.string().uuid(),
  resourceId: z.string().uuid(),
  ref: z.string().min(1).max(255).optional().describe("Branch, tag or exact commit SHA; the default branch when omitted"),
};
