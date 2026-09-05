import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateTaskFormulation } from "../../packages/core/src/task-formulation.js";
import { taskComponentSchema } from "../../packages/schemas/src/index.js";
import { inferComponent } from "../../packages/core/src/task-formulation.js";

// A task that cannot be planned is not rejected by anything downstream in a way its author can act
// on: the planner produces a plan nobody asked for, or a READY gate demands evidence the task was
// never scoped to create, several minutes later. An autonomous author reads that as a platform
// fault and retries the same wording. These tests pin the verdict to the moment of authoring, and
// pin that every finding says which field to change and to what.
const root = resolve(__dirname, "../..");

/** A task worded well enough to plan, used as the baseline every negative case perturbs. */
const wellFormed = {
  title: "Add idempotent refund endpoint to the payments module",
  description:
    "Refunds are currently issued by hand against the provider dashboard, so they are not recorded in our ledger. Add a POST /payments/refunds endpoint that records the refund and calls the provider once per idempotency key. Existing payment capture behaviour must not change.",
  requirements: [
    "POST /payments/refunds returns 201 and a refund id for a captured payment",
    "POST /payments/refunds returns 409 when the payment is already fully refunded",
    "Repeating a request with the same Idempotency-Key returns the first result and calls the provider once",
  ],
  externalKey: "PAYMENTS-API-02",
  component: { kind: "MODULE" as const, name: "payments" },
};

describe("a well-formed task is accepted", () => {
  const verdict = validateTaskFormulation(wellFormed);

  it("is acceptable and raises nothing blocking", () => {
    expect(verdict.acceptable).toBe(true);
    expect(verdict.findings.filter((finding) => finding.severity === "BLOCKING")).toEqual([]);
  });

  it("reports how the text was read, so the author can see the reading it will be planned against", () => {
    expect(verdict.understoodAs.apiChange).toBe(true);
  });
});

describe("every finding is actionable", () => {
  // The point of this gate is not to say no. A finding that does not name the replacement leaves an
  // autonomous author guessing, which is the behaviour this whole change exists to stop.
  const cases = [
    { ...wellFormed, description: "" },
    { ...wellFormed, requirements: [] },
    { ...wellFormed, component: undefined },
    { ...wellFormed, requirements: ["Make the endpoint fast"] },
    { ...wellFormed, description: "Add a refund endpoint. Amount limits are TBD." },
    { ...wellFormed, title: "" },
  ];

  it("names a field, a problem and a fix on every finding it produces", () => {
    for (const input of cases)
      for (const finding of validateTaskFormulation(input).findings) {
        expect(finding.field, JSON.stringify(finding)).toBeTruthy();
        expect(finding.problem.length).toBeGreaterThan(10);
        expect(finding.fix.length).toBeGreaterThan(10);
        expect(finding.code).toMatch(/^[A-Z][A-Z_]+$/);
      }
  });

  it("never answers with a bare instruction to add more detail", () => {
    for (const input of cases)
      for (const finding of validateTaskFormulation(input).findings)
        expect(finding.fix.toLowerCase()).not.toMatch(/^(add|provide|write) more detail/);
  });
});

describe("what blocks planning", () => {
  const codesFor = (input: Parameters<typeof validateTaskFormulation>[0]) =>
    validateTaskFormulation(input).findings.filter((finding) => finding.severity === "BLOCKING").map((finding) => finding.code);

  it("rejects a task with nothing to plan from", () => {
    expect(codesFor({ ...wellFormed, description: "" })).toContain("DESCRIPTION_MISSING");
    expect(codesFor({ ...wellFormed, description: "Fix the refunds." })).toContain("DESCRIPTION_TOO_THIN");
  });

  it("rejects a task no gate could decide", () => {
    expect(codesFor({ ...wellFormed, requirements: [] })).toContain("REQUIREMENTS_MISSING");
  });

  it("rejects a requirement with no failing value", () => {
    // "Fast" cannot be refuted by any test, so a READY gate asserting it would be theatre.
    expect(codesFor({ ...wellFormed, requirements: ["The endpoint should be fast and robust"] })).toContain("REQUIREMENT_NOT_VERIFIABLE");
    expect(codesFor({ ...wellFormed, requirements: ["p95 latency stays under 200 ms at 50 rps"] })).not.toContain("REQUIREMENT_NOT_VERIFIABLE");
  });

  it("rejects an unresolved decision", () => {
    expect(codesFor({ ...wellFormed, description: `${wellFormed.description} Maximum refund amount is TBD.` })).toContain("DESCRIPTION_PLACEHOLDER");
    expect(codesFor({ ...wellFormed, requirements: [...wellFormed.requirements, "Rate limit is TODO"] })).toContain("REQUIREMENT_PLACEHOLDER");
  });

  it("rejects a task bound to neither the core nor a module, and whose key implies neither", () => {
    // The binding is what makes one implementation exportable on its own, so a task that has none
    // and offers no way to derive one is refused.
    expect(codesFor({ ...wellFormed, component: undefined, externalKey: undefined })).toContain("COMPONENT_MISSING");
  });

  it("rejects a description that both asks for and denies an HTTP surface", () => {
    const contradictory = {
      ...wellFormed,
      description: "Add a POST /payments/refunds endpoint for the operator console. Do not add public HTTP APIs as part of this task.",
    };
    expect(codesFor(contradictory)).toContain("SCOPE_API_CONTRADICTION");
  });
});

describe("what is advisory rather than blocking", () => {
  const verdictFor = (input: Parameters<typeof validateTaskFormulation>[0]) => validateTaskFormulation(input);

  it("flags an off-convention key without refusing the task", () => {
    const verdict = verdictFor({ ...wellFormed, externalKey: "some random key" });
    expect(verdict.findings.map((finding) => finding.code)).toContain("EXTERNAL_KEY_SHAPE");
    expect(verdict.acceptable).toBe(true);
  });

  it("flags two deliverables in one task without refusing it", () => {
    const verdict = verdictFor({
      ...wellFormed,
      description: `${wellFormed.description} Additionally migrate the subscriptions table to the new billing schema.`,
    });
    expect(verdict.findings.map((finding) => finding.code)).toContain("MULTIPLE_DELIVERABLES");
    expect(verdict.acceptable).toBe(true);
  });
});

describe("the core/module binding", () => {
  it("requires a module to be named and forbids naming the core", () => {
    // CORE is the single shared foundation, so a named core would silently become a second one.
    expect(taskComponentSchema.safeParse({ kind: "MODULE" }).success).toBe(false);
    expect(taskComponentSchema.safeParse({ kind: "MODULE", name: "payments" }).success).toBe(true);
    expect(taskComponentSchema.safeParse({ kind: "CORE" }).success).toBe(true);
    expect(taskComponentSchema.safeParse({ kind: "CORE", name: "payments" }).success).toBe(false);
  });

  it("keeps the module name usable unchanged as a directory, branch segment and bundle name", () => {
    expect(taskComponentSchema.safeParse({ kind: "MODULE", name: "Payments" }).success).toBe(false);
    expect(taskComponentSchema.safeParse({ kind: "MODULE", name: "billing-invoices" }).success).toBe(true);
    expect(taskComponentSchema.safeParse({ kind: "MODULE", name: "billing_invoices" }).success).toBe(false);
  });

  it("stays optional on the stored task, so tasks written before it remain readable", () => {
    // It is required going forward by task_validate and by the MCP creation boundary, not by a
    // schema change that would make 96 existing task documents unparseable.
    const schemas = readFileSync(join(root, "packages/schemas/src/index.ts"), "utf8");
    expect(schemas).toContain("component: taskComponentSchema.optional()");
  });
});

describe("formulation is enforced where authored input enters", () => {
  const mcp = readFileSync(join(root, "supabase/functions/mcp/index.ts"), "utf8");

  it("validates before creating, and refuses with the findings attached", () => {
    const create = mcp.slice(mcp.indexOf("server.registerTool('superadmin_task_create'"), mcp.indexOf("server.registerTool('superadmin_task_update'"));
    expect(create).toContain("validateTaskFormulation");
    expect(create).toContain("findings:verdict.findings");
  });

  it("offers a check that does not create anything, so a draft can be corrected first", () => {
    expect(mcp).toContain("server.registerTool('task_validate'");
  });

  it("leaves the core primitive alone, so internal callers are not gated on authored prose", () => {
    // Migrations, fixtures and recovery paths construct tasks directly; the policy belongs at the
    // untrusted boundary, not in the mechanism.
    expect(readFileSync(join(root, "packages/core/src/application.ts"), "utf8")).not.toContain("validateTaskFormulation");
  });
});

describe("the component binding is read from the key when it is not given", () => {
  // `component` was introduced as an immediately BLOCKING field. That hard-blocked any client still
  // holding the previous tool schema: the policy demanded a parameter the caller's cached schema did
  // not offer, so no rewording could satisfy it -- CORE-BE-26 could not be created at all. A rule a
  // client cannot satisfy is a platform defect, not a formulation problem. Task keys have carried
  // this information all along (CORE-* is the shared foundation; every other prefix names an area),
  // so deriving it removes the class of block without weakening the binding.

  it("reads CORE from a CORE-prefixed key", () => {
    expect(inferComponent("CORE-BE-26")).toEqual({ kind: "CORE" });
    expect(inferComponent("core-be-26")).toEqual({ kind: "CORE" });
  });

  it("reads a module from any other prefix, lowercased into a usable slug", () => {
    expect(inferComponent("PAYMENTS-API-02")).toEqual({ kind: "MODULE", name: "payments" });
    expect(inferComponent("INFRA-07")).toEqual({ kind: "MODULE", name: "infra" });
  });

  it("declines rather than guessing when a key implies nothing", () => {
    for (const key of [undefined, "", "   ", "123-45", "-LEADING"]) expect(inferComponent(key), String(key)).toBeUndefined();
  });

  it("accepts a task whose key implies the binding, and says it inferred one", () => {
    const verdict = validateTaskFormulation({ ...wellFormed, component: undefined, externalKey: "CORE-BE-26" });
    expect(verdict.acceptable).toBe(true);
    expect(verdict.component).toEqual({ kind: "CORE" });
    const finding = verdict.findings.find((value) => value.code === "COMPONENT_INFERRED");
    expect(finding?.severity).toBe("ADVISORY");
    expect(finding?.problem).toContain("CORE-BE-26");
  });

  it("never overrides a component the caller stated", () => {
    const verdict = validateTaskFormulation({ ...wellFormed, externalKey: "CORE-BE-26", component: { kind: "MODULE", name: "payments" } });
    expect(verdict.component).toEqual({ kind: "MODULE", name: "payments" });
    expect(verdict.findings.map((value) => value.code)).not.toContain("COMPONENT_INFERRED");
  });

  it("still refuses a MODULE the caller named badly", () => {
    const verdict = validateTaskFormulation({ ...wellFormed, component: { kind: "MODULE" } });
    expect(verdict.acceptable).toBe(false);
    expect(verdict.findings.map((value) => value.code)).toContain("COMPONENT_MODULE_UNNAMED");
  });

  it("is what the creation path persists, so an inferred binding is not dropped", () => {
    const mcp = readFileSync(join(root, "supabase/functions/mcp/index.ts"), "utf8");
    const create = mcp.slice(mcp.indexOf("server.registerTool('superadmin_task_create'"), mcp.indexOf("server.registerTool('superadmin_task_update'"));
    expect(create).toContain("verdict.component?{component:verdict.component}");
  });
});
