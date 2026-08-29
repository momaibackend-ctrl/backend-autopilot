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

  it("does not read a list of test kinds as a request to change what they test", () => {
    // Verbatim from CORE-QA-02 requirement 7. A roster of suites to re-run is not a migration, but
    // it names PostgreSQL and migrations, and negation does not catch it -- the clause refuses
    // nothing, it simply asks for nothing. This is what made the task owe a MIGRATION_MANIFEST.
    const scope = classifyScope(
      "Retain and rerun all existing unit, domain invariant, architecture, contract, PostgreSQL migration/repository, Redis, object-storage, durable-job, privacy/security, regression and existing supplemental runtime tests in the normal CI suite.",
    );
    expect(scope.database.mentioned).toBe(true);
    expect(scope.database.intended).toBe(false);
    expect(scope.database.verificationOnlyEvidence.length).toBe(1);
  });

  it("does not read a statement about which evidence counts as a request for that surface", () => {
    // Verbatim from CORE-QA-02 requirement 8, which produced MISSING_API_CONTRACT.
    const scope = classifyScope(
      "Treat HTTP/load/E2E evidence as supplemental for this Core QA task rather than the primary domain-correctness criterion; do not invent new network tests.",
    );
    expect(scope.api.intended).toBe(false);
  });

  it("keeps reading a surface as intended when the clause carries an implementation verb", () => {
    // The demotion above must not swallow real work that mentions its own tests in one breath.
    const scope = classifyScope("Add a REST endpoint for exports and its contract tests.");
    expect(scope.api.intended).toBe(true);
    const db = classifyScope("Implement the PostgreSQL migration and its migration tests.");
    expect(db.database.intended).toBe(true);
  });

  it("does not read a hyphenated compound as the word it merely contains", () => {
    // Found by the gate on a real task: "direct-table-access" names a test rule, and  treats the
    // hyphen as a boundary, so the fragment read as the whole word "table" and the task was made
    // to owe a MIGRATION_MANIFEST for work touching no database at all.
    const scope = classifyScope(
      "IntegrationContractGateTest derives its owned-executor exemption and its direct-table-access skip from Path.toString().",
    );
    expect(scope.database.mentioned).toBe(false);
    expect(classifyScope("Rename the rest-parameter helper.").api.mentioned).toBe(false);
  });

  it("still matches the bare words those compounds contain", () => {
    expect(classifyScope("Add a column to the users table.").database.intended).toBe(true);
    expect(classifyScope("Treat HTTP/load evidence as supplemental.").api.mentioned).toBe(true);
  });

  it("reads 'restart' as recovery language rather than a REST mention", () => {
    // Present verbatim in the standard requirement template on every task.
    const scope = classifyScope(
      "If an attempt leaves a dirty or inconsistent workspace, restart from a clean checkout.",
    );
    expect(scope.api.mentioned).toBe(false);
  });
});
