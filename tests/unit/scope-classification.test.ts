import { describe, expect, it } from "vitest";
import { classifyScope } from "../../packages/core/src/scope-classification.js";

// CORE-QA-02 is the case that motivated this module. Its requirements forbid a public HTTP surface
// and involve no migration whatsoever, yet the planner recorded both apiChanges and databaseChanges
// and the READY gate then demanded MISSING_API_CONTRACT and MISSING_MIGRATION_MANIFEST for evidence
// the task was never allowed to produce. The phrasing below reproduces that shape.
describe("scope classification", () => {
  it("reads a forbidden HTTP surface as evidence against an API change, not for one", () => {
    const scope = classifyScope(
      "Add property-based tests for the core algorithmic invariants. Do not add public HTTP APIs. No schema migrations are part of this task.",
    );
    expect(scope.api.mentioned).toBe(true);
    expect(scope.api.intended).toBe(false);
    expect(scope.api.negatedEvidence.join(" ")).toContain("Do not add public HTTP APIs");
    expect(scope.database.intended).toBe(false);
  });

  it("still reads a genuine request to expose an endpoint as intent", () => {
    const scope = classifyScope(
      "Expose a new REST endpoint so external billing providers can post webhook events. Document it in openapi.json.",
    );
    expect(scope.api.intended).toBe(true);
    expect(scope.api.evidence[0]).toContain("REST endpoint");
  });

  it("treats a promise to preserve an existing surface as a refusal to change it", () => {
    // CORE-BE-09's actual phrasing. Nothing here asks for a new contract.
    const scope = classifyScope("Preserve existing REST paths, status codes and product behavior.");
    expect(scope.api.mentioned).toBe(true);
    expect(scope.api.intended).toBe(false);
  });

  it("keeps INTERNAL_ONLY working as the author's explicit declaration", () => {
    const scope = classifyScope(
      // CORE-BE-10's actual requirement text.
      "Expose a typed INTERNAL_ONLY Context Platform contract. Do not invent public product HTTP APIs solely for this task.",
    );
    expect(scope.api.intended).toBe(false);
    expect(scope.api.negatedEvidence.length).toBeGreaterThan(0);
  });

  it("does not read a negation that follows the subject as a refusal", () => {
    const scope = classifyScope("Add a REST endpoint for exports; the pagination parameter is not optional.");
    expect(scope.api.intended).toBe(true);
  });

  it("no longer counts a Zod or JSON schema as a database change", () => {
    // "schema" is in nearly every control-plane task and used to make databaseChanges non-empty on
    // its own, which is how a task with no migration at all ended up owing a MIGRATION_MANIFEST.
    const scope = classifyScope(
      "Validate the request with a Zod schema and record the artifact schema version alongside it.",
    );
    expect(scope.database.mentioned).toBe(false);
    expect(scope.database.intended).toBe(false);
  });

  it("still recognises a real migration", () => {
    const scope = classifyScope("Add a versioned PostgreSQL migration that creates the rollout_assignments table.");
    expect(scope.database.intended).toBe(true);
  });

  it("recognises a qualified database schema change without the word migration", () => {
    const scope = classifyScope("Apply the database schema change that adds the tenant column.");
    expect(scope.database.intended).toBe(true);
  });

  it("reads 'restart' as recovery language rather than a REST mention", () => {
    // Present verbatim in the standard requirement template on every task.
    const scope = classifyScope(
      "If an attempt leaves a dirty or inconsistent workspace, restart from a clean checkout.",
    );
    expect(scope.api.mentioned).toBe(false);
  });
});
