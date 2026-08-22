import { describe, expect, it } from "vitest";
import {
  basePathPrefix,
  classifyHost,
  defaultHttpRunnerLimits,
  evaluateAssertions,
  executeHttpRequest,
  extractResponseValue,
  renderTemplate,
  requiredBearer,
  resolveHttpApiTarget,
  resolveStepUrl,
  restoreScenarioDefinition,
  sanitizedError,
  scenarioHttpRunnerLimits,
  scenarioRunToolInputSchema,
  scenarioRunToolName,
  validatedHeaders,
  validateNoInlineSecrets,
  type HttpExecution,
  type ScenarioVariables,
} from "../../packages/http-runner/src/index.js";
import type {
  Environment,
  Resource,
  ValidationAssertion,
} from "../../packages/schemas/src/index.js";

function httpResource(
  externalReference: string,
  environment: Environment = "SANDBOX",
  overrides: Partial<Resource> = {},
): Resource {
  return {
    resourceId: "11111111-1111-4111-8111-111111111111",
    type: "HTTP_API",
    provider: "http",
    externalReference,
    projectId: "22222222-2222-4222-8222-222222222222",
    environment,
    permissions: ["READ"],
    status: "ACTIVE",
    secretRefs: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("host classification", () => {
  it("recognises loopback, private, link-local and metadata targets", () => {
    expect(classifyHost("127.0.0.1")).toBe("LOOPBACK");
    expect(classifyHost("localhost")).toBe("LOOPBACK");
    expect(classifyHost("::1")).toBe("LOOPBACK");
    expect(classifyHost("[::1]")).toBe("LOOPBACK");
    expect(classifyHost("10.1.2.3")).toBe("PRIVATE");
    expect(classifyHost("172.16.0.9")).toBe("PRIVATE");
    expect(classifyHost("172.32.0.9")).toBe("PUBLIC");
    expect(classifyHost("192.168.5.5")).toBe("PRIVATE");
    expect(classifyHost("100.64.0.1")).toBe("PRIVATE");
    expect(classifyHost("169.254.169.254")).toBe("METADATA");
    expect(classifyHost("169.254.10.10")).toBe("LINK_LOCAL");
    expect(classifyHost("metadata.google.internal")).toBe("METADATA");
    expect(classifyHost("db.svc.internal")).toBe("PRIVATE");
    expect(classifyHost("fd00::1")).toBe("UNIQUE_LOCAL");
    expect(classifyHost("fe80::1")).toBe("LINK_LOCAL");
    expect(classifyHost("::ffff:169.254.169.254")).toBe("METADATA");
    expect(classifyHost("api.example.com")).toBe("PUBLIC");
  });
});

describe("HTTP_API target resolution", () => {
  it("accepts HTTPS public targets and loopback HTTP for LOCAL/SANDBOX", () => {
    expect(resolveHttpApiTarget(httpResource("https://api.example.com")).origin)
      .toBe("https://api.example.com");
    expect(resolveHttpApiTarget(httpResource("http://127.0.0.1:4010")).origin)
      .toBe("http://127.0.0.1:4010");
    expect(
      resolveHttpApiTarget(httpResource("http://localhost:4010", "LOCAL"))
        .origin,
    ).toBe("http://localhost:4010");
  });

  it("rejects every unsafe or unregistered target shape", () => {
    const cases: Array<[string, Environment]> = [
      ["http://api.example.com", "SANDBOX"],
      ["https://10.0.0.5", "SANDBOX"],
      ["https://169.254.169.254", "SANDBOX"],
      ["https://metadata.google.internal", "SANDBOX"],
      ["https://[fd00::1]", "SANDBOX"],
      ["https://user:pass@api.example.com", "SANDBOX"],
      ["ftp://api.example.com", "SANDBOX"],
      ["https://api.example.com/v1?token=1", "SANDBOX"],
      ["not-a-url", "SANDBOX"],
    ];
    for (const [reference, environment] of cases)
      expect(
        () => resolveHttpApiTarget(httpResource(reference, environment)),
        reference,
      ).toThrowError();
  });

  it("refuses loopback for STAGING resources and production or disabled resources", () => {
    expect(() =>
      resolveHttpApiTarget(httpResource("http://127.0.0.1:9", "STAGING")),
    ).toThrowError(/LOCAL or SANDBOX/);
    expect(() =>
      resolveHttpApiTarget(httpResource("https://api.example.com", "PRODUCTION")),
    ).toThrowError(/NOT_SUPPORTED/);
    expect(() =>
      resolveHttpApiTarget(
        httpResource("https://api.example.com", "SANDBOX", {
          status: "DISABLED",
        }),
      ),
    ).toThrowError(/not ACTIVE/);
    expect(() =>
      resolveHttpApiTarget(
        httpResource("https://api.example.com", "SANDBOX", {
          type: "DATABASE",
        }),
      ),
    ).toThrowError(/HTTP_API/);
  });
});

describe("path and origin containment", () => {
  const base = new URL("https://api.example.com");
  it("keeps requests on the registered origin", () => {
    expect(resolveStepUrl(base, "/health").href).toBe(
      "https://api.example.com/health",
    );
    expect(() => resolveStepUrl(base, "//evil.example.com/steal")).toThrowError(
      /Protocol-relative/,
    );
    expect(() => resolveStepUrl(base, "health")).toThrowError(/must start/);
    expect(() => resolveStepUrl(base, "/a\r\nHost: evil")).toThrowError(
      /control characters/,
    );
  });

  it("contains requests inside a registered base path prefix", () => {
    const prefixed = new URL("https://api.example.com/v1/");
    expect(basePathPrefix(prefixed)).toBe("/v1");
    expect(resolveStepUrl(prefixed, "/notes").href).toBe(
      "https://api.example.com/v1/notes",
    );
    expect(() => resolveStepUrl(prefixed, "/../admin")).toThrowError(
      /escape the registered base path/,
    );
    expect(basePathPrefix(base)).toBe("");
  });

  it("rejects unsafe query parameters", () => {
    expect(() => resolveStepUrl(base, "/x", { "bad\nkey": "1" })).toThrowError(
      /Unsafe query parameter/,
    );
    expect(resolveStepUrl(base, "/x", { page: "2" }).search).toBe("?page=2");
  });
});

describe("header and inline-secret policy", () => {
  it("refuses caller-supplied credential headers and header injection", () => {
    expect(() => validatedHeaders({ authorization: "Bearer x" })).toThrowError();
    expect(() => validatedHeaders({ cookie: "a=b" })).toThrowError();
    expect(() => validatedHeaders({ "x-api-key": "k" })).toThrowError();
    expect(() => validatedHeaders({ "x-a": "v\r\nX-Injected: 1" })).toThrowError();
    expect(validatedHeaders({ "x-trace": "abc" }).get("x-trace")).toBe("abc");
    expect(validatedHeaders({}).get("content-type")).toBe("application/json");
  });

  it("refuses raw secret values passed inline instead of through secretRefs", () => {
    expect(() => validateNoInlineSecrets({ password: "leak" })).toThrowError();
    expect(() =>
      validateNoInlineSecrets({ nested: [{ api_key: "leak" }] }),
    ).toThrowError();
    expect(() => validateNoInlineSecrets({ title: "safe" })).not.toThrowError();
  });
});

describe("variable interpolation, extraction and bearer handoff", () => {
  const variables: ScenarioVariables = new Map([
    ["note_id", { value: "note-1", sensitive: false }],
    ["access_token", { value: "s3cret-value", sensitive: true }],
  ]);

  it("substitutes non-sensitive variables in every request part", () => {
    expect(renderTemplate("/notes/{{note_id}}", variables)).toBe("/notes/note-1");
    expect(renderTemplate({ id: "{{note_id}}" }, variables)).toEqual({
      id: "note-1",
    });
    expect(renderTemplate(["{{note_id}}"], variables)).toEqual(["note-1"]);
  });

  it("never allows a sensitive variable outside bearerFrom", () => {
    expect(() => renderTemplate("/x/{{access_token}}", variables)).toThrowError(
      /may only be used as bearerFrom/,
    );
    expect(requiredBearer(variables, "access_token")).toBe("s3cret-value");
    expect(() => requiredBearer(variables, "missing")).toThrowError(/missing/);
  });

  it("extracts nested response values and fails loudly when absent", () => {
    const body = { data: { id: "abc" }, items: [{ id: "first" }] };
    expect(extractResponseValue(body, "response.body.data.id")).toBe("abc");
    expect(extractResponseValue(body, "response.body.items.0.id")).toBe("first");
    expect(() =>
      extractResponseValue(body, "response.body.data.nope"),
    ).toThrowError(/was not found/);
  });
});

describe("stored scenario restoration", () => {
  const commonStep = {
    name: "Login",
    method: "POST",
    path: "/login",
    expectedStatus: 200,
  };
  const shared = {
    resourceId: "33333333-3333-4333-8333-333333333333",
    name: "Scenario",
    description: "",
  };

  it("restores both the Console array form and the MCP record form of `extract`", () => {
    const consoleForm = restoreScenarioDefinition({
      ...shared,
      steps: [
        {
          ...commonStep,
          extract: [
            { variable: "token", path: "response.body.token", sensitive: true },
          ],
        },
      ],
    });
    const mcpForm = restoreScenarioDefinition({
      ...shared,
      operationId: "created-by-mcp",
      steps: [
        {
          ...commonStep,
          extract: { token: { path: "response.body.token", sensitive: true } },
        },
      ],
    });
    expect(consoleForm.steps[0]?.extract).toEqual(mcpForm.steps[0]?.extract);
    expect(mcpForm.steps[0]?.assertions).toEqual([]);
  });

  it("rejects a stored scenario without steps", () => {
    expect(() => restoreScenarioDefinition({ ...shared })).toThrowError(
      /no steps/,
    );
    expect(() => restoreScenarioDefinition("nope")).toThrowError(/invalid/);
  });
});

describe("assertions", () => {
  const execution = {
    rawBody: { id: "note-1", count: 2 },
    rawHeaders: new Headers({ "content-type": "application/json" }),
    durationMs: 20,
  } as unknown as HttpExecution;
  const run = (assertions: ValidationAssertion[]) =>
    evaluateAssertions(assertions, execution).map((value) => value.passed);

  it("evaluates header, body-field and response-time assertions", () => {
    expect(
      run([
        { type: "HEADER_EXISTS", header: "content-type" },
        { type: "HEADER_EXISTS", header: "x-missing" },
        {
          type: "HEADER_EQUALS",
          header: "content-type",
          value: "application/json",
        },
        { type: "HEADER_EQUALS", header: "content-type", value: "text/plain" },
        { type: "BODY_FIELD_EXISTS", path: "response.body.id" },
        { type: "BODY_FIELD_EXISTS", path: "response.body.nope" },
        { type: "BODY_FIELD_EQUALS", path: "response.body.count", value: 2 },
        { type: "BODY_FIELD_EQUALS", path: "response.body.count", value: 3 },
        { type: "MAX_DURATION_MS", maxDurationMs: 1000 },
        { type: "MAX_DURATION_MS", maxDurationMs: 1 },
      ]),
    ).toEqual([true, false, true, false, true, false, true, false, true, false]);
  });
});

describe("bounded transport", () => {
  const base = new URL("https://api.example.com");

  it("applies a request timeout signal and never follows redirects by default", async () => {
    let seenSignal: AbortSignal | undefined;
    const execution = await executeHttpRequest({
      base,
      method: "GET",
      path: "/redirect",
      fetchImpl: async (_url, init) => {
        seenSignal = init?.signal ?? undefined;
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example.com/" },
        });
      },
    });
    expect(execution.response.status).toBe(302);
    expect(execution.redirects).toBe(0);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(defaultHttpRunnerLimits.maxRedirects).toBe(0);
  });

  it("follows bounded same-origin redirects and blocks cross-origin ones", async () => {
    const followed = await executeHttpRequest({
      base,
      method: "GET",
      path: "/a",
      limits: scenarioHttpRunnerLimits,
      fetchImpl: async (url) =>
        String(url).endsWith("/a")
          ? new Response(null, { status: 307, headers: { location: "/b" } })
          : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
    expect(followed.redirects).toBe(1);
    expect(followed.response.status).toBe(200);

    await expect(
      executeHttpRequest({
        base,
        method: "GET",
        path: "/a",
        limits: scenarioHttpRunnerLimits,
        fetchImpl: async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.example.com/steal" },
          }),
      }),
    ).rejects.toThrowError(/leave the registered origin/);

    await expect(
      executeHttpRequest({
        base,
        method: "GET",
        path: "/loop",
        limits: scenarioHttpRunnerLimits,
        fetchImpl: async () =>
          new Response(null, { status: 302, headers: { location: "/loop" } }),
      }),
    ).rejects.toThrowError(/maximum redirect count/);
  });

  it("caps the response body it reads and the evidence it stores", async () => {
    const huge = "x".repeat(20_000);
    const execution = await executeHttpRequest({
      base,
      method: "GET",
      path: "/big",
      limits: { ...scenarioHttpRunnerLimits, maxResponseBytes: 1_000 },
      fetchImpl: async () => new Response(huge, { status: 200 }),
    });
    expect(execution.response.truncated).toBe(true);
    expect(String(execution.rawBody).length).toBe(1_000);

    const evidence = await executeHttpRequest({
      base,
      method: "GET",
      path: "/medium",
      limits: { ...scenarioHttpRunnerLimits, maxEvidenceBodyBytes: 50 },
      fetchImpl: async () =>
        new Response(JSON.stringify({ blob: "y".repeat(400) }), {
          status: 200,
        }),
    });
    expect(evidence.response.body).toMatchObject({ truncated: true });
  });

  it("redacts credentials out of request and response evidence", async () => {
    const execution = await executeHttpRequest({
      base,
      method: "POST",
      path: "/login",
      bearer: "super-secret-token",
      fetchImpl: async () =>
        new Response(JSON.stringify({ access_token: "super-secret-token" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "session=super-secret-token",
          },
        }),
    });
    const serialized = JSON.stringify({
      request: execution.request,
      response: execution.response,
    });
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("set-cookie");
    // The parsed body is still available in-process so extraction can chain it.
    expect(execution.rawBody).toMatchObject({
      access_token: "super-secret-token",
    });
  });

  it("sanitises transport errors before they reach evidence", () => {
    expect(
      sanitizedError(new Error("failed with Bearer abcdefghijk")),
    ).toMatchObject({ code: "EXECUTION_FAILED" });
    expect(
      sanitizedError(new Error("failed with Bearer abcdefghijk")).message,
    ).not.toContain("abcdefghijk");
  });
});

describe("published tool contract", () => {
  it("accepts only an operationId, projectId and scenarioId", () => {
    expect(scenarioRunToolName).toBe("superadmin_scenario_run");
    expect(Object.keys(scenarioRunToolInputSchema).sort()).toEqual([
      "operationId",
      "projectId",
      "scenarioId",
    ]);
  });
});
