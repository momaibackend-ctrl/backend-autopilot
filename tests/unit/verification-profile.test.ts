import { describe, expect, it } from "vitest";
import { buildVerificationProfile, layerStatus, requiredSuites } from "../../packages/core/src/verification-profile.js";

const statusOf = (text: string, layer: Parameters<typeof layerStatus>[1]) => layerStatus(buildVerificationProfile(text), layer);
const reasonsOf = (text: string, layer: Parameters<typeof layerStatus>[1]) =>
  buildVerificationProfile(text).decisions.find((decision) => decision.layer === layer)!.reasons.join(" ");

// The two examples below are the ones the gap was actually found on: a rollout bucketing rule and a
// local-day boundary. Both were covered by passing example-based tests and neither had its
// invariant checked over generated inputs.
describe("verification profile", () => {
  it("requires a generative layer for deterministic rollout bucketing", () => {
    const text =
      "Implement deterministic rollout bucketing: a user assigned at threshold X must remain assigned when the rollout percentage increases.";
    expect(statusOf(text, "PROPERTY")).toBe("REQUIRED");
    expect(reasonsOf(text, "PROPERTY")).toContain("deterministic hashing/bucketing");
    expect(requiredSuites(buildVerificationProfile(text))).toContain("PROPERTY");
  });

  it("requires a generative layer for local-day and timezone arithmetic", () => {
    const text =
      "Resolve the start of the local day for an instant in an arbitrary timezone, including zones that observe DST.";
    expect(statusOf(text, "PROPERTY")).toBe("REQUIRED");
    expect(reasonsOf(text, "PROPERTY")).toContain("time/DST");
  });

  it("requires it for lifecycle state machines and for idempotency", () => {
    expect(statusOf("Model the task lifecycle and its state transitions.", "PROPERTY")).toBe("REQUIRED");
    expect(statusOf("Make the ingestion endpoint idempotent under retries and deduplicate replayed events.", "PROPERTY")).toBe("REQUIRED");
  });

  it("refuses it -- with a stated reason -- for a shape that carries no invariant", () => {
    const text = "Add CRUD endpoints over the notes table and map each row to its DTO.";
    expect(statusOf(text, "PROPERTY")).toBe("NOT_APPLICABLE");
    // A silent skip and a justified absence must not look the same in the evidence chain.
    expect(reasonsOf(text, "PROPERTY")).toContain("crud");
  });

  it("records why a layer does not apply even when nothing matched an exclusion", () => {
    const reasons = reasonsOf("Rename the internal logger field on the audit record.", "PROPERTY");
    expect(reasons).toContain("would only restate the unit tests");
  });

  it("separates the contract suite from the HTTP evidence a refused surface must not owe", () => {
    // Exactly the CORE-QA-02 shape: an API is mentioned only to be forbidden.
    const text = "Add property-based tests for the core invariants. Do not add public HTTP APIs. No migrations.";
    const profile = buildVerificationProfile(text);
    expect(layerStatus(profile, "CONTRACT")).toBe("REQUIRED");
    expect(layerStatus(profile, "HTTP_CONTRACT")).toBe("NOT_APPLICABLE");
    expect(layerStatus(profile, "MIGRATION_MANIFEST")).toBe("NOT_APPLICABLE");
    expect(reasonsOf(text, "HTTP_CONTRACT")).toContain("rules a public HTTP surface out");
  });

  it("always requires the layers every task owes", () => {
    const profile = buildVerificationProfile("Rename a field.");
    for (const layer of ["UNIT", "INTEGRATION", "SECURITY", "REGRESSION"] as const) {
      expect(layerStatus(profile, layer)).toBe("REQUIRED");
    }
    expect(requiredSuites(profile)).toEqual(["UNIT", "INTEGRATION", "SECURITY", "REGRESSION"]);
  });

  it("gives every decision a reason, including the negative ones", () => {
    for (const decision of buildVerificationProfile("Rename a field.").decisions) {
      expect(decision.reasons.length).toBeGreaterThan(0);
      expect(decision.reasons.every((reason) => reason.trim().length > 0)).toBe(true);
    }
  });
});
