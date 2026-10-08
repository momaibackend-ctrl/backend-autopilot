import { describe, expect, it } from "vitest";
import {
  collectionLimits,
  collectionScenarios,
  collectionVerdict,
  computeApiCoverage,
  declaredRequests,
  draftStepsFor,
  extractApiOperations,
  importPostmanCollection,
  inventoryFromContractArtifact,
  matchOperation,
  normalizeApiPath,
  normalizeVariableName,
  parseTemplatedJson,
  templateMatchScore,
  unquotedPlaceholder,
  type ApiInventory,
  type ExercisedRequest,
} from "../../packages/http-runner/src/collection.js";
import {
  validationScenarioStepSchema,
  type Artifact,
} from "../../packages/schemas/src/index.js";

// A small but realistic contract: a public health probe, a secured CRUD resource with a literal
// sub-route that competes with the templated one, and an OPTIONS route the runner cannot send.
const notesContract = {
  openapi: "3.1.0",
  info: { title: "Notes", version: "1.0.0" },
  security: [{ bearer: [] }],
  paths: {
    "/health": { get: { security: [], responses: { "200": {} } } },
    "/notes": {
      get: { operationId: "listNotes", responses: { "200": {}, "401": {} } },
      post: { responses: { "201": {}, "400": {}, "401": {} } },
      options: { responses: { "204": {} } },
    },
    "/notes/search": { get: { responses: { "200": {} } } },
    "/notes/{noteId}": {
      get: { responses: { "200": {}, "404": {} } },
      put: { responses: { "200": {} } },
      delete: { responses: { "204": {} } },
    },
    "/files/{name}.json": { get: { responses: { default: {} } } },
  },
};

function inventory(): ApiInventory {
  return extractApiOperations(notesContract);
}

describe("API inventory", () => {
  it("reads every executable operation of an OpenAPI document with security and statuses", () => {
    const value = inventory();
    expect(value.title).toBe("Notes");
    expect(value.operations.map((op) => `${op.method} ${op.path}`)).toEqual([
      "GET /health",
      "GET /notes",
      "POST /notes",
      "GET /notes/search",
      "GET /notes/{noteId}",
      "PUT /notes/{noteId}",
      "DELETE /notes/{noteId}",
      "GET /files/{name}.json",
    ]);
    const byKey = new Map(value.operations.map((op) => [`${op.method} ${op.path}`, op]));
    expect(byKey.get("GET /health")?.secured).toBe(false);
    expect(byKey.get("GET /notes")?.secured).toBe(true);
    expect(byKey.get("GET /notes")?.operationId).toBe("listNotes");
    expect(byKey.get("POST /notes")).toMatchObject({ successStatus: 201, declaredStatuses: [201, 400, 401] });
    expect(byKey.get("GET /files/{name}.json")?.successStatus).toBeUndefined();
    expect(value.excluded).toEqual([
      { method: "OPTIONS", path: "/notes", reason: "OPTIONS is not executable by the HTTP runner" },
    ]);
  });

  it("accepts Swagger 2.0 and refuses anything that is not a contract", () => {
    expect(
      extractApiOperations({ swagger: "2.0", paths: { "/a/": { get: { responses: { "200": {} } } } } }).operations,
    ).toMatchObject([{ method: "GET", path: "/a", secured: false }]);
    expect(() => extractApiOperations({ info: {} })).toThrow(/OpenAPI 3.x or Swagger 2.0/);
    expect(() => extractApiOperations({ openapi: "3.0.0" })).toThrow(/no paths/);
    expect(() => extractApiOperations("not a document")).toThrow();
  });

  it("refuses a contract larger than the operation limit instead of truncating it", () => {
    const paths = Object.fromEntries(
      Array.from({ length: collectionLimits.maxOperations + 1 }, (_, index) => [`/r${index}`, { get: { responses: {} } }]),
    );
    expect(() => extractApiOperations({ openapi: "3.0.0", paths })).toThrow(/more than/);
  });

  it("merges the contracts the execution runner records in an API_CONTRACT artifact", () => {
    const merged = inventoryFromContractArtifact({
      contracts: [
        { path: "openapi.json", document: notesContract },
        { path: "admin/openapi.json", document: { openapi: "3.0.0", paths: { "/admin/stats": { get: { responses: { "200": {} } } }, "/health": { get: {} } } } },
        { path: "broken.json", document: { nope: true } },
      ],
    });
    expect(merged?.operations).toHaveLength(9);
    expect(inventoryFromContractArtifact({ contracts: [] })).toBeUndefined();
    expect(inventoryFromContractArtifact("garbage")).toBeUndefined();
  });
});

describe("operation matching", () => {
  it("prefers a literal route over a templated one, like OpenAPI itself", () => {
    const ops = inventory().operations;
    expect(matchOperation(ops, "GET", "/notes/search")?.path).toBe("/notes/search");
    expect(matchOperation(ops, "GET", "/notes/42")?.path).toBe("/notes/{noteId}");
  });

  it("treats a scenario variable as some value: it fills a parameter, never a literal", () => {
    const ops = inventory().operations;
    expect(matchOperation(ops, "GET", "/notes/{{note_id}}")?.path).toBe("/notes/{noteId}");
    expect(matchOperation(ops, "DELETE", "/notes/{{note_id}}")?.path).toBe("/notes/{noteId}");
    expect(templateMatchScore("/notes/search", "/notes/{{x}}")).toBe(-1);
  });

  it("matches partially templated segments, ignores query and trailing slash, and respects the method", () => {
    const ops = inventory().operations;
    expect(matchOperation(ops, "get", "/files/report.json?x=1")?.path).toBe("/files/{name}.json");
    expect(matchOperation(ops, "GET", "/files/report.xml")).toBeUndefined();
    expect(matchOperation(ops, "GET", "/notes/")?.path).toBe("/notes");
    expect(matchOperation(ops, "PATCH", "/notes/1")).toBeUndefined();
    expect(normalizeApiPath("//a//b/?q=1")).toBe("/a/b");
    expect(normalizeApiPath("")).toBe("/");
  });
});

// The reported gap, reduced to its shape: seven requests -- health, version, auth and a 404 --
// all green, against an API with many more operations. That must never read as proven.
const thinCollection: ExercisedRequest[] = [
  { scenario: "Smoke", step: "health", method: "GET", path: "/health", status: "PASSED", httpStatus: 200 },
  { scenario: "Smoke", step: "health head", method: "HEAD", path: "/health", status: "PASSED", httpStatus: 200 },
  { scenario: "Smoke", step: "version", method: "GET", path: "/version", status: "PASSED", httpStatus: 200 },
  { scenario: "Smoke", step: "no token", method: "GET", path: "/notes", status: "PASSED", httpStatus: 401 },
  { scenario: "Smoke", step: "bad token", method: "GET", path: "/notes", status: "PASSED", httpStatus: 401 },
  { scenario: "Smoke", step: "unknown route", method: "GET", path: "/nope", status: "PASSED", httpStatus: 404 },
  { scenario: "Smoke", step: "unknown note", method: "GET", path: "/notes/0", status: "PASSED", httpStatus: 404 },
];

describe("API coverage and verdict", () => {
  it("reports seven green smoke requests as NOT_PROVEN with the exact uncovered operations", () => {
    const coverage = computeApiCoverage(inventory(), thinCollection, "EXECUTED");
    expect(coverage.status).toBe("INCOMPLETE");
    expect(coverage.totalOperations).toBe(8);
    expect(coverage.coveredOperations).toBe(3);
    expect(coverage.coveragePercent).toBe(37.5);
    expect(coverage.uncovered.map((op) => `${op.method} ${op.path}`)).toEqual([
      "POST /notes",
      "GET /notes/search",
      "PUT /notes/{noteId}",
      "DELETE /notes/{noteId}",
      "GET /files/{name}.json",
    ]);
    expect(coverage.undocumented.map((value) => value.path)).toEqual(["/health", "/version", "/nope"]);
    const listNotes = coverage.covered.find((value) => value.path === "/notes");
    expect(listNotes).toMatchObject({ observedStatuses: [401], missingStatuses: [200] });
    expect(coverage.excluded).toHaveLength(1);
    const verdict = collectionVerdict({ scenarios: 1, passedScenarios: 1, skippedScenarios: 0, coverage });
    expect(verdict.verdict).toBe("NOT_PROVEN");
    expect(verdict.reasons).toEqual(["5 of 8 documented operations were not exercised by a passing request"]);
  });

  it("counts an attempted but failing request as NOT_PASSING, not as coverage", () => {
    const coverage = computeApiCoverage(
      inventory(),
      [{ scenario: "S", step: "create", method: "POST", path: "/notes", status: "FAILED", httpStatus: 500 }],
      "EXECUTED",
    );
    expect(coverage.coveredOperations).toBe(0);
    expect(coverage.uncovered.find((op) => op.method === "POST")?.reason).toBe("NOT_PASSING");
    expect(coverage.uncovered.find((op) => op.method === "PUT")?.reason).toBe("NOT_EXERCISED");
  });

  it("counts a declared request on the DECLARED basis without any execution", () => {
    const coverage = computeApiCoverage(
      inventory(),
      [{ scenario: "S", step: "create", method: "POST", path: "/notes" }],
      "DECLARED",
    );
    expect(coverage.coveredOperations).toBe(1);
    expect(coverage.basis).toBe("DECLARED");
  });

  it("is PROVEN only when every operation passed and every scenario passed", () => {
    const all = inventory().operations.map<ExercisedRequest>((op) => ({
      scenario: "Full",
      step: `${op.method} ${op.path}`,
      method: op.method,
      path: op.path.replace(/\{[^}]+\}/g, "x"),
      status: "PASSED",
      httpStatus: op.successStatus ?? 200,
    }));
    const coverage = computeApiCoverage(inventory(), all, "EXECUTED");
    expect(coverage.status).toBe("COMPLETE");
    expect(coverage.coveragePercent).toBe(100);
    expect(collectionVerdict({ scenarios: 2, passedScenarios: 2, skippedScenarios: 0, coverage })).toEqual({
      verdict: "PROVEN",
      reasons: [],
    });
    expect(collectionVerdict({ scenarios: 2, passedScenarios: 1, skippedScenarios: 0, coverage }).reasons).toEqual([
      "1 of 2 scenarios did not pass",
    ]);
    expect(collectionVerdict({ scenarios: 2, passedScenarios: 1, skippedScenarios: 1, coverage }).reasons[0]).toMatch(
      /not started within the collection budget/,
    );
  });

  it("never proves anything without an inventory or without scenarios", () => {
    const coverage = computeApiCoverage(undefined, thinCollection, "EXECUTED");
    expect(coverage.status).toBe("NO_INVENTORY");
    expect(coverage.undocumented).toHaveLength(7);
    expect(collectionVerdict({ scenarios: 1, passedScenarios: 1, skippedScenarios: 0, coverage }).reasons).toEqual([
      "no API inventory: without the project's OpenAPI contract the run cannot show it covers the whole API",
    ]);
    const empty = computeApiCoverage({ operations: [], excluded: [] }, [], "EXECUTED");
    expect(empty.status).toBe("INCOMPLETE");
    expect(collectionVerdict({ scenarios: 0, passedScenarios: 0, skippedScenarios: 0, coverage: empty }).reasons).toEqual([
      "no scenarios were executed",
      "the API contract documents no executable operations",
    ]);
  });
});

describe("draft steps for uncovered operations", () => {
  it("produces a schema-valid step per operation with the variables it needs", () => {
    const drafts = draftStepsFor(inventory().operations);
    expect(drafts).toHaveLength(8);
    const put = drafts.find((value) => value.operation === "PUT /notes/{noteId}");
    expect(put?.step).toMatchObject({ method: "PUT", path: "/notes/{{note_id}}", expectedStatus: 200 });
    expect(put?.requiredVariables).toEqual(["note_id"]);
    expect(put?.note).toMatch(/extract note_id/);
    expect(put?.note).toMatch(/request body/);
    expect(put?.note).toMatch(/secured/);
    expect(drafts.find((value) => value.operation === "GET /health")?.note).toBe("ready to save as-is");
    expect(drafts.find((value) => value.operation === "GET /files/{name}.json")?.note).toMatch(/no 2xx/);
    for (const draft of drafts) expect(validationScenarioStepSchema.safeParse(draft.step).success).toBe(true);
  });
});

function request(name: string, method: string, raw: string, extra: Record<string, unknown> = {}) {
  return { name, request: { method, url: { raw }, ...extra } };
}
function tests(...exec: string[]) {
  return { event: [{ listen: "test", script: { type: "text/javascript", exec } }] };
}

const postman = {
  info: {
    name: "Notes API",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: [
    { key: "baseUrl", value: "http://localhost:8080" },
    { key: "pageSize", value: "10" },
    { key: "adminPassword", value: "hunter2" },
  ],
  item: [
    {
      ...request("Health", "GET", "{{baseUrl}}/api/v1/health"),
      ...tests('pm.test("ok", function () {', "    pm.response.to.have.status(200);", "});"),
    },
    {
      name: "Auth",
      item: [
        {
          ...request("Login", "POST", "{{baseUrl}}/api/v1/auth/login", {
            body: { mode: "raw", raw: '{"user":"sandbox"}' },
            header: [{ key: "Content-Type", value: "application/json" }],
          }),
          ...tests(
            "var jsonData = pm.response.json();",
            'pm.test("Status code is 200", function () {',
            "    pm.response.to.have.status(200);",
            "});",
            'pm.environment.set("authToken", jsonData.access_token);',
            'pm.collectionVariables.set("userId", jsonData["user_id"]);',
          ),
        },
        request("Login with password", "POST", "{{baseUrl}}/api/v1/auth/login", {
          body: { mode: "raw", raw: '{"user":"sandbox","password":"{{adminPassword}}"}' },
        }),
      ],
    },
    {
      name: "Notes",
      auth: { type: "bearer", bearer: [{ key: "token", value: "{{authToken}}", type: "string" }] },
      item: [
        {
          ...request("Create note", "POST", "{{baseUrl}}/api/v1/notes?draft=true", {
            body: { mode: "raw", raw: '{"title":"from postman","owner":"{{userId}}","size": {{pageSize}},"priority": {{priority}}}' },
            header: [
              { key: "Cookie", value: "session=abc" },
              { key: "X-Trace", value: "{{traceId}}", disabled: true },
            ],
          }),
          ...tests(
            "pm.expect(pm.response.code).to.eql(201);",
            'pm.environment.set("noteId", pm.response.json().id);',
          ),
        },
        {
          name: "Read note",
          request: {
            method: "GET",
            url: {
              raw: "{{baseUrl}}/api/v1/notes/:id",
              host: ["{{baseUrl}}"],
              path: ["api", "v1", "notes", ":id"],
              variable: [{ key: "id", value: "{{noteId}}" }],
            },
          },
          ...tests(
            "const body = pm.response.json();",
            "pm.response.to.have.status(200);",
            "pm.expect(body.title).to.eql('from postman');",
            "pm.expect(body.owner).to.exist;",
            'pm.response.to.have.header("Content-Type");',
            "pm.expect(pm.response.responseTime).to.be.below(2000);",
            'pm.expect(body.tags).to.include("a");',
          ),
        },
        {
          ...request("Upload attachment", "POST", "{{baseUrl}}/api/v1/notes/:id/files", {
            body: { mode: "formdata", formdata: [{ key: "file", type: "file" }] },
          }),
        },
        request("Options", "OPTIONS", "{{baseUrl}}/api/v1/notes"),
        {
          ...request("Basic auth probe", "GET", "{{baseUrl}}/api/v1/notes", { auth: { type: "basic" } }),
          ...tests("pm.response.to.have.status(200);"),
        },
        {
          ...request("Delete note", "DELETE", "https://staging.example.test/api/v1/notes/{{noteId}}"),
          ...tests("pm.response.to.have.status(204);"),
        },
      ],
    },
    {
      name: "Bulk",
      item: Array.from({ length: 25 }, (_, index) => ({
        ...request(`Page ${index}`, "GET", `{{baseUrl}}/api/v1/notes?page=${index}`),
        ...tests("pm.response.to.have.status(200);"),
      })),
    },
  ],
};

describe("Postman collection import", () => {
  const imported = importPostmanCollection(postman, { stripPathPrefix: "/api/v1" });
  const steps = imported.scenarios.flatMap((scenario) => scenario.steps);
  const step = (name: string) => steps.find((value) => value.name === name);

  it("keeps collection order: root requests, then one scenario per folder, split at 20 steps", () => {
    expect(imported.collectionName).toBe("Notes API");
    expect(imported.requestCount).toBe(34);
    expect(imported.scenarios.map((scenario) => [scenario.name, scenario.steps.length])).toEqual([
      ["Notes API", 1],
      ["Auth", 1],
      ["Notes", 4],
      ["Bulk (1/2)", 20],
      ["Bulk (2/2)", 5],
    ]);
    expect(imported.importedSteps).toBe(31);
    for (const value of steps) expect(validationScenarioStepSchema.safeParse(value).success).toBe(true);
  });

  it("drops the host, strips the registered prefix and keeps the query", () => {
    expect(step("Health")).toMatchObject({ method: "GET", path: "/health", expectedStatus: 200 });
    expect(step("Create note")).toMatchObject({ path: "/notes", query: { draft: "true" } });
    expect(step("Page 3")).toMatchObject({ path: "/notes", query: { page: "3" } });
    expect(step("Delete note")?.path).toBe("/notes/{{note_id}}");
    expect(imported.warnings).toContainEqual({
      request: "Notes › Delete note",
      message: "the request host https://staging.example.test is ignored; the target is always the registered HTTP_API resource",
    });
  });

  it("translates status, extraction, header, body-field and timing tests", () => {
    expect(step("Login")).toMatchObject({
      expectedStatus: 200,
      body: { user: "sandbox" },
      extract: {
        auth_token: { path: "response.body.access_token", sensitive: true },
        user_id: { path: "response.body.user_id", sensitive: false },
      },
    });
    expect(step("Create note")).toMatchObject({ expectedStatus: 201, extract: { note_id: { path: "response.body.id" } } });
    expect(step("Read note")).toMatchObject({
      path: "/notes/{{note_id}}",
      expectedStatus: 200,
      assertions: [
        { type: "BODY_FIELD_EQUALS", path: "response.body.title", value: "from postman" },
        { type: "BODY_FIELD_EXISTS", path: "response.body.owner" },
        { type: "HEADER_EXISTS", header: "Content-Type" },
        { type: "MAX_DURATION_MS", maxDurationMs: 2000 },
      ],
    });
    expect(imported.warnings).toContainEqual({
      request: "Notes › Read note",
      message: '1 test script line(s) have no runner equivalent, e.g. pm.expect(body.tags).to.include("a");',
    });
  });

  it("maps folder bearer auth to bearerFrom and normalizes variable names", () => {
    expect(step("Create note")?.bearerFrom).toBe("auth_token");
    expect(step("Read note")?.bearerFrom).toBe("auth_token");
    expect(imported.variables).toMatchObject({ authToken: "auth_token", userId: "user_id", noteId: "note_id" });
  });

  it("inlines static collection variables with their JSON type and keeps run-time variables", () => {
    expect(step("Create note")?.body).toEqual({
      title: "from postman",
      owner: "{{user_id}}",
      size: 10,
      priority: "{{priority}}",
    });
    expect(imported.warnings).toContainEqual({
      request: "Notes › Create note",
      message: "{{priority}} is not extracted by any earlier request; the run will stop at this step until a scenario before it extracts it",
    });
    expect(imported.warnings).toContainEqual({
      message: "collection variable {{adminPassword}} looks secret-bearing and was not inlined",
    });
  });

  it("drops credential headers and disabled headers, and reports both", () => {
    expect(step("Create note")?.headers).toEqual({});
    expect(imported.warnings).toContainEqual({
      request: "Notes › Create note",
      message: "the Cookie header was dropped; credentials travel only through the resource secretRef",
    });
    expect(imported.warnings).toContainEqual({
      request: "Notes › Basic auth probe",
      message: "basic auth is not supported by the HTTP runner; only the resource secretRef (Bearer) authenticates this request",
    });
  });

  it("reports every request it cannot import, with the reason", () => {
    expect(imported.skipped).toEqual([
      {
        request: "Auth › Login with password",
        reason: "Caller-supplied secret-bearing request fields are forbidden; authenticate through the resource secretRef or a bearerFrom variable instead",
      },
      { request: "Notes › Upload attachment", reason: "formdata bodies are not supported by the HTTP runner (JSON and text only)" },
      { request: "Notes › Options", reason: "OPTIONS is not executable by the HTTP runner" },
    ]);
    expect(imported.requestCount).toBe(imported.importedSteps + imported.skipped.length);
  });

  it("warns when a request carries no status assertion", () => {
    const value = importPostmanCollection({ info: { name: "x" }, item: [request("Bare", "GET", "/bare")] });
    expect(value.scenarios[0]?.steps[0]?.expectedStatus).toBeUndefined();
    expect(value.warnings).toContainEqual({
      request: "x › Bare",
      message: "no status assertion in the request's tests: the step passes on any HTTP status",
    });
  });

  it("refuses documents that are not Postman collections", () => {
    expect(() => importPostmanCollection({ openapi: "3.0.0" })).toThrow(/item array/);
    expect(() => importPostmanCollection({ info: { schema: "https://example.test/other" }, item: [] })).toThrow(/not a Postman/);
    expect(() =>
      importPostmanCollection({ info: { name: "x" }, item: Array.from({ length: collectionLimits.maxRequests + 1 }, () => request("r", "GET", "/r")) }),
    ).toThrow(/more than/);
  });

  it("covers the contract from the imported definitions on the DECLARED basis", () => {
    const artifacts = imported.scenarios.map((scenario, index) => ({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      kind: "VALIDATION_SCENARIO",
      status: "AVAILABLE",
      createdAt: "2026-10-08T00:00:00.000Z",
      content: { ...scenario, resourceId: "r1", collection: { index } },
    })) as unknown as Artifact[];
    const ordered = collectionScenarios([...artifacts].reverse(), "r1");
    expect(ordered.map((value) => (value.content as { name: string }).name)).toEqual(imported.scenarios.map((s) => s.name));
    expect(collectionScenarios(artifacts, "other")).toEqual([]);
    const coverage = computeApiCoverage(inventory(), declaredRequests(ordered), "DECLARED");
    expect(coverage.uncovered.map((op) => `${op.method} ${op.path}`)).toEqual([
      "GET /notes/search",
      "PUT /notes/{noteId}",
      "GET /files/{name}.json",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Generative invariants. Seeded, so a failure names the case that reproduces it.
// ---------------------------------------------------------------------------

const SEED = 0x5eed_c011;
const CASES = 500;
function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(random: () => number, values: readonly T[]) => values[Math.floor(random() * values.length)] as T;
const word = (random: () => number) =>
  Array.from({ length: 1 + Math.floor(random() * 8) }, () => pick(random, "abcdefghijklmnopqrstuvwxyz0123456789-_".split(""))).join("");

describe("generative invariants", () => {
  it("every concrete or variable instantiation of a template matches that template", () => {
    const random = prng(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const parts = Array.from({ length: 1 + Math.floor(random() * 5) }, () =>
        random() < 0.4 ? { param: true, text: `{${word(random)}}` } : { param: false, text: `l${word(random)}` },
      );
      const template = `/${parts.map((part) => part.text).join("/")}`;
      const concrete = `/${parts.map((part) => (part.param ? `v${word(random)}` : part.text)).join("/")}`;
      const variable = `/${parts.map((part) => (part.param ? `{{${normalizeVariableName(part.text.slice(1, -1)) ?? "x"}}}` : part.text)).join("/")}`;
      const context = `seed=${SEED} case=${index} template=${template}`;
      expect(templateMatchScore(template, concrete), context).toBeGreaterThanOrEqual(0);
      expect(templateMatchScore(template, variable), context).toBeGreaterThanOrEqual(0);
      expect(templateMatchScore(template, `${concrete}/extra`), context).toBe(-1);
      expect(templateMatchScore(template, `${concrete}/`), context).toBeGreaterThanOrEqual(0);
    }
  });

  it("the chosen operation always matches, and no other match is more specific", () => {
    const random = prng(SEED + 1);
    for (let index = 0; index < CASES; index += 1) {
      const literals = ["a", "b", "c"];
      const operations = Array.from({ length: 1 + Math.floor(random() * 6) }, () => ({
        method: "GET" as const,
        path: `/${Array.from({ length: 1 + Math.floor(random() * 3) }, () => (random() < 0.5 ? "{p}" : pick(random, literals))).join("/")}`,
        secured: false,
        declaredStatuses: [],
      }));
      const path = `/${Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(random, [...literals, "z", "{{v}}"])).join("/")}`;
      const chosen = matchOperation(operations, "GET", path);
      const scores = operations.map((op) => templateMatchScore(op.path, path));
      const context = `seed=${SEED + 1} case=${index} path=${path} ops=${operations.map((op) => op.path).join(",")}`;
      if (!chosen) expect(scores.every((score) => score < 0), context).toBe(true);
      else expect(templateMatchScore(chosen.path, path), context).toBe(Math.max(...scores));
    }
  });

  it("variable name normalization yields the scenario grammar and is idempotent", () => {
    const random = prng(SEED + 2);
    const alphabet = "abcXYZ019_-. $é".split("");
    for (let index = 0; index < CASES; index += 1) {
      const name = Array.from({ length: Math.floor(random() * 80) }, () => pick(random, alphabet)).join("");
      const normalized = normalizeVariableName(name);
      const context = `seed=${SEED + 2} case=${index} name=${JSON.stringify(name)}`;
      if (normalized === undefined) continue;
      expect(normalized, context).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      expect(normalizeVariableName(normalized), context).toBe(normalized);
    }
  });

  it("templated JSON parsing round-trips plain JSON and marks only unquoted placeholders", () => {
    const random = prng(SEED + 3);
    const value = (depth: number): unknown => {
      const kind = Math.floor(random() * (depth > 2 ? 4 : 6));
      if (kind === 0) return Math.floor(random() * 1e6) - 5e5;
      if (kind === 1) return random() < 0.5;
      if (kind === 2) return null;
      if (kind === 3) return pick(random, ["", "x", '{"a"}', "{{quoted}}", "tab\there", 'q"uote', "back\\slash"]);
      if (kind === 4) return Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1));
      return Object.fromEntries(Array.from({ length: Math.floor(random() * 4) }, () => [word(random), value(depth + 1)]));
    };
    for (let index = 0; index < CASES; index += 1) {
      const document = value(0);
      const context = `seed=${SEED + 3} case=${index}`;
      const parsed = parseTemplatedJson(JSON.stringify(document));
      expect(parsed, context).toEqual({ ok: true, value: document });
      const templated = parseTemplatedJson(`{"n": {{count}}, "s": "{{name}}", "doc": ${JSON.stringify(document)}}`);
      expect(templated, context).toEqual({
        ok: true,
        value: { n: `${unquotedPlaceholder}{{count}}`, s: "{{name}}", doc: document },
      });
    }
  });

  it("coverage partitions the inventory and never shrinks when requests are added", () => {
    const random = prng(SEED + 4);
    const ops = inventory().operations;
    for (let index = 0; index < CASES; index += 1) {
      const requests: ExercisedRequest[] = Array.from({ length: Math.floor(random() * 12) }, () => {
        const op = pick(random, ops);
        return {
          scenario: "S",
          step: "s",
          method: random() < 0.9 ? op.method : "PATCH",
          path: op.path.replace(/\{[^}]+\}/g, () => `v${word(random)}`),
          status: pick(random, ["PASSED", "FAILED", "SKIPPED", "ERROR"] as const),
        };
      });
      const context = `seed=${SEED + 4} case=${index}`;
      const before = computeApiCoverage(inventory(), requests, "EXECUTED");
      expect(before.coveredOperations + before.uncoveredOperations, context).toBe(ops.length);
      const extra = { ...pick(random, requests.length ? requests : [{ scenario: "S", step: "s", method: "GET", path: "/health" }]), status: "PASSED" as const };
      const after = computeApiCoverage(inventory(), [...requests, extra], "EXECUTED");
      expect(after.coveredOperations, context).toBeGreaterThanOrEqual(before.coveredOperations);
      const declared = computeApiCoverage(inventory(), requests, "DECLARED");
      expect(declared.coveredOperations, context).toBeGreaterThanOrEqual(before.coveredOperations);
    }
  });
});
