import { describe, expect, it } from "vitest";
import { GitHubRestRepositoryProvider } from "../../packages/adapters/github/src/repository-provider.js";
import { collectionVerdict, computeApiCoverage, extractApiOperations } from "../../packages/http-runner/src/collection.js";
import {
  contractCandidatePaths,
  discoverRepositoryApi,
  discoveryLimits,
  documentKind,
  parseStructuredDocument,
  resolvePathItemRefs,
  resolveRelativePath,
  type RepositoryContentSource,
} from "../../packages/http-runner/src/contract-discovery.js";

const SHA = "a".repeat(40);

function source(files: Record<string, string>, truncated = false): RepositoryContentSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    commitSha: SHA,
    reads,
    async listFiles() {
      return { files: Object.entries(files).map(([path, content]) => ({ path, size: content.length })), truncated };
    },
    async readFile(path) {
      reads.push(path);
      return files[path];
    },
  };
}

// A product whose API is split the way real ones are: a root contract, a separate check-in
// contract in YAML, an onboarding contract whose paths live in their own files, a Postman
// collection, and generated copies that must not be counted twice.
const rootContract = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Product", version: "2.0.0" },
  paths: {
    "/health": { get: { responses: { "200": {} } } },
    "/users/{id}": { get: { responses: { "200": {}, "404": {} } } },
  },
});
const checkinContract = `
openapi: 3.1.0
info:
  title: Check-in
  version: 1.0.0
paths:
  /checkins:
    get:
      responses:
        "200": {}
    post:
      responses:
        "201": {}
  /checkins/{checkinId}:
    get:
      responses:
        "200": {}
  /health:
    get:
      responses:
        "200": {}
`;
const onboardingContract = `
openapi: 3.0.0
info: { title: Onboarding, version: 1.0.0 }
paths:
  /onboarding/start:
    $ref: './paths/start.yaml'
  /onboarding/{step}:
    $ref: 'paths/steps.yaml#/step'
  /onboarding/finish:
    $ref: '#/components/pathItems/finish'
  /onboarding/missing:
    $ref: './paths/does-not-exist.yaml'
components:
  pathItems:
    finish:
      post:
        responses:
          "204": {}
`;
const repository = {
  "openapi.json": rootContract,
  "contracts/checkin.yaml": checkinContract,
  "contracts/onboarding/onboarding.openapi.yaml": onboardingContract,
  "contracts/onboarding/paths/start.yaml": "post:\n  responses:\n    '201': {}\n",
  "contracts/onboarding/paths/steps.yaml": "step:\n  put:\n    responses:\n      '200': {}\n",
  "postman/product.postman_collection.json": JSON.stringify({
    info: { name: "Product", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    item: [{ name: "Health", request: { method: "GET", url: "{{baseUrl}}/health" } }],
  }),
  "build/generated/openapi.json": rootContract,
  "node_modules/some-lib/openapi.json": rootContract,
  "docs/notes.json": '{"hello": "world"}',
  "package.json": '{"name":"x"}',
  "src/main/resources/application.yml": "server:\n  port: 8080\n",
  "src/Main.kt": "fun main() {}",
};

describe("candidate selection", () => {
  it("opens contract-like files, skips build output, dependencies and configuration", () => {
    const { candidates } = contractCandidatePaths(Object.entries(repository).map(([path, content]) => ({ path, size: content.length })));
    expect(candidates).toEqual([
      "openapi.json",
      "postman/product.postman_collection.json",
      "contracts/onboarding/onboarding.openapi.yaml",
      "contracts/checkin.yaml",
      "docs/notes.json",
      "contracts/onboarding/paths/start.yaml",
      "contracts/onboarding/paths/steps.yaml",
    ]);
  });

  it("reports oversized candidates instead of reading them", () => {
    const value = contractCandidatePaths([{ path: "api/openapi.json", size: discoveryLimits.maxFileBytes + 1 }]);
    expect(value).toEqual({ candidates: [], oversized: ["api/openapi.json"] });
  });
});

describe("document parsing and classification", () => {
  it("reads JSON and YAML and classifies by content, not by name", () => {
    expect(documentKind(parseStructuredDocument("a.yaml", checkinContract))).toBe("OPENAPI");
    expect(documentKind(JSON.parse(repository["postman/product.postman_collection.json"]))).toBe("POSTMAN");
    expect(documentKind({ swagger: "2.0", paths: {} })).toBe("OPENAPI");
    expect(documentKind({ openapi: "3.0.0" })).toBe("OTHER");
    expect(documentKind({ item: [] })).toBe("OTHER");
    expect(() => parseStructuredDocument("a.json", "{nope")).toThrow();
  });

  it("resolves relative references and refuses to leave the repository", () => {
    expect(resolveRelativePath("contracts/a/b.yaml", "./paths/c.yaml")).toBe("contracts/a/paths/c.yaml");
    expect(resolveRelativePath("contracts/a/b.yaml", "../shared.yaml")).toBe("contracts/shared.yaml");
    expect(resolveRelativePath("b.yaml", "../escape.yaml")).toBeUndefined();
    expect(resolveRelativePath("b.yaml", "https://example.test/x.yaml")).toBeUndefined();
    expect(resolveRelativePath("b.yaml", "/etc/passwd")).toBeUndefined();
  });

  it("inlines local and external path-item references and leaves unresolvable ones visible", async () => {
    const document = parseStructuredDocument("contracts/onboarding/onboarding.openapi.yaml", onboardingContract) as Record<string, unknown>;
    const files = repository as Record<string, string>;
    const expanded = await resolvePathItemRefs(document, "contracts/onboarding/onboarding.openapi.yaml", async (path) =>
      files[path] === undefined ? undefined : parseStructuredDocument(path, files[path] as string),
    );
    const inventory = extractApiOperations(expanded);
    expect(inventory.operations.map((op) => `${op.method} ${op.path}`)).toEqual([
      "POST /onboarding/start",
      "PUT /onboarding/{step}",
      "POST /onboarding/finish",
    ]);
    expect(inventory.incomplete).toEqual([
      { source: "/onboarding/missing", reason: "path item is an unresolved $ref to ./paths/does-not-exist.yaml" },
    ]);
  });
});

describe("repository discovery", () => {
  it("finds every contract and collection and merges them with provenance", async () => {
    const discovery = await discoverRepositoryApi(source(repository));
    expect(discovery.commitSha).toBe(SHA);
    expect(discovery.contracts.map((value) => [value.path, value.operations, value.gaps])).toEqual([
      ["openapi.json", 2, 0],
      ["contracts/onboarding/onboarding.openapi.yaml", 3, 1],
      ["contracts/checkin.yaml", 4, 0],
    ]);
    expect(discovery.collections).toEqual([{ path: "postman/product.postman_collection.json", name: "Product", requestCount: 1 }]);
    const operations = discovery.inventory.operations;
    expect(operations).toHaveLength(8);
    expect(operations.find((op) => op.path === "/health")).toMatchObject({ contract: "openapi.json", alsoIn: ["contracts/checkin.yaml"] });
    expect(operations.find((op) => op.path === "/checkins/{checkinId}")?.contract).toBe("contracts/checkin.yaml");
    expect(discovery.inventory.incomplete).toEqual([
      {
        source: "contracts/onboarding/onboarding.openapi.yaml /onboarding/missing",
        reason: "path item is an unresolved $ref to ./paths/does-not-exist.yaml",
      },
    ]);
  });

  it("measures coverage per contract and never proves an inventory with gaps", async () => {
    const discovery = await discoverRepositoryApi(source(repository));
    const requests = discovery.inventory.operations
      .filter((op) => !op.path.startsWith("/onboarding"))
      .map((op) => ({ scenario: "S", step: op.path, method: op.method, path: op.path.replace(/\{[^}]+\}/g, "1"), status: "PASSED" as const }));
    const coverage = computeApiCoverage(discovery.inventory, requests, "EXECUTED");
    expect(coverage.byContract).toEqual([
      { contract: "openapi.json", totalOperations: 2, coveredOperations: 2, coveragePercent: 100, status: "COMPLETE" },
      { contract: "contracts/checkin.yaml", totalOperations: 4, coveredOperations: 4, coveragePercent: 100, status: "COMPLETE" },
      { contract: "contracts/onboarding/onboarding.openapi.yaml", totalOperations: 3, coveredOperations: 0, coveragePercent: 0, status: "INCOMPLETE" },
    ]);
    const verdict = collectionVerdict({ scenarios: 1, passedScenarios: 1, skippedScenarios: 0, coverage });
    expect(verdict.verdict).toBe("NOT_PROVEN");
    expect(verdict.reasons).toEqual([
      "3 of 8 documented operations were not exercised by a passing request",
      "the API inventory is incomplete (1 gap(s), e.g. contracts/onboarding/onboarding.openapi.yaml /onboarding/missing: path item is an unresolved $ref to ./paths/does-not-exist.yaml)",
      "contracts not fully covered: contracts/onboarding/onboarding.openapi.yaml (0/3)",
    ]);

    const complete = computeApiCoverage(
      { ...discovery.inventory, incomplete: [] },
      discovery.inventory.operations.map((op) => ({ scenario: "S", step: "s", method: op.method, path: op.path.replace(/\{[^}]+\}/g, "1"), status: "PASSED" as const })),
      "EXECUTED",
    );
    expect(collectionVerdict({ scenarios: 1, passedScenarios: 1, skippedScenarios: 0, coverage: complete }).verdict).toBe("PROVEN");
  });

  it("records every reason it could not see the whole API as a gap", async () => {
    const files: Record<string, string> = {
      "api/openapi-broken.yaml": "openapi: [unclosed",
      "api/openapi.json": JSON.stringify({ openapi: "3.0.0", paths: { "/a": { get: {} } } }),
      "api/empty-collection.postman_collection.json": JSON.stringify({ info: { schema: "postman" }, item: [] }),
    };
    for (let index = 0; index < discoveryLimits.maxReads + 2; index += 1) files[`specs/x${String(index).padStart(3, "0")}.json`] = "{}";
    const discovery = await discoverRepositoryApi(source(files, true));
    const reasons = (discovery.inventory.incomplete ?? []).map((gap) => `${gap.source}: ${gap.reason}`);
    expect(reasons[0]).toBe("repository tree: the host truncated the recursive file listing; contracts beyond it were not seen");
    expect(reasons).toContain("api/openapi-broken.yaml: could not be parsed as JSON or YAML");
    expect(reasons.filter((value) => value.includes("read budget"))).toHaveLength(5);
    expect(discovery.contracts.map((value) => value.path)).toEqual(["api/openapi.json"]);
    expect(discovery.collections).toEqual([{ path: "api/empty-collection.postman_collection.json", name: "Collection", requestCount: 0 }]);
  });

  it("does not report a malformed non-contract file as a gap", async () => {
    const discovery = await discoverRepositoryApi(source({ "docs/broken.json": "{nope", "openapi.yaml": checkinContract }));
    expect(discovery.inventory.incomplete).toBeUndefined();
    expect(discovery.inventory.operations).toHaveLength(4);
  });
});

describe("GitHub tree listing", () => {
  it("lists blobs at an exact commit and passes the host's truncation flag through", async () => {
    const calls: string[] = [];
    const provider = new GitHubRestRepositoryProvider("token", (async (url: string | URL) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({ truncated: true, tree: [{ path: "openapi.json", type: "blob", size: 10 }, { path: "contracts", type: "tree" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch);
    await expect(provider.listTree("owner/repo", SHA)).resolves.toEqual({ files: [{ path: "openapi.json", size: 10 }], truncated: true });
    expect(calls).toEqual([`https://api.github.com/repos/owner/repo/git/trees/${SHA}?recursive=1`]);
    await expect(provider.listTree("owner/repo", "main")).rejects.toThrow(/exact 40-character/);
    await expect(provider.listTree("https://evil.test/x", SHA)).rejects.toThrow(/Invalid repository identity/);
  });
});

// Generative: whatever a contract names as a $ref, resolution stays inside the repository.
describe("generative invariants", () => {
  it("a resolved reference never contains a dot segment and never climbs above the root", () => {
    const SEED = 0x2ef5;
    let state = SEED;
    const random = () => {
      state = (state * 1103515245 + 12345) >>> 0;
      return state / 4294967296;
    };
    const segment = () => ["..", ".", "", "a", "b", "paths", "x.yaml"][Math.floor(random() * 7)] as string;
    for (let index = 0; index < 1000; index += 1) {
      const from = Array.from({ length: 1 + Math.floor(random() * 4) }, () => ["a", "b", "c"][Math.floor(random() * 3)]).join("/") + "/doc.yaml";
      const reference = Array.from({ length: 1 + Math.floor(random() * 6) }, segment).join("/");
      const resolved = resolveRelativePath(from, reference);
      const context = `seed=${SEED} case=${index} from=${from} ref=${reference}`;
      if (resolved === undefined) continue;
      expect(resolved.split("/").some((part) => part === ".." || part === "."), context).toBe(false);
      const depth = from.split("/").length - 1;
      const climbs = reference.split("/").reduce((level, part) => (part === ".." ? level - 1 : part && part !== "." ? level + 1 : level), depth);
      expect(climbs, context).toBeGreaterThanOrEqual(0);
    }
  });
});
