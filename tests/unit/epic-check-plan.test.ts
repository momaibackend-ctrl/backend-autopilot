import { describe, expect, it } from "vitest";
import { dimensionOutcome, parseJUnitResults, type ExecutedTest } from "../../packages/core/src/epic-check-plan.js";

const test = (className: string, outcome: ExecutedTest["outcome"] = "PASSED", name = "case"): ExecutedTest => ({ className, name, outcome });

describe("epic check attribution", () => {
  it("refuses to pass a dimension no test covered", () => {
    // The whole point of the epic gate restated one level down: a green suite says nothing about a
    // dimension nothing in it exercises, and "no failures" is not "verified".
    const outcome = dimensionOutcome("JOURNEYS", [test("com.momna.platform.CacheContractTest")]);
    expect(outcome.passed).toBe(false);
    expect(outcome.matched).toBe(0);
    expect(outcome.detail).toContain("proves nothing about it");
  });

  it("refuses to pass a dimension whose every test opted itself out", () => {
    // Real shape: Optional*SmokeTest skips when its service connection variable is absent, so an
    // integration dimension can look green with no database ever contacted.
    const outcome = dimensionOutcome("INTEGRATION_DEPENDENCIES", [
      test("com.momna.platform.cache.redis.OptionalRedisSmokeTest", "SKIPPED"),
      test("com.momna.platform.storage.OptionalS3SmokeTest", "SKIPPED"),
    ]);
    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("opted itself out");
    expect(outcome.matched).toBe(2);
  });

  it("passes when attributed tests actually ran, and says how many", () => {
    const outcome = dimensionOutcome("INTEGRATION_DEPENDENCIES", [
      test("com.momna.platform.database.PostgresContractIntegrationTest"),
      test("com.momna.platform.cache.redis.OptionalRedisSmokeTest"),
      test("com.momna.platform.storage.OptionalS3SmokeTest", "SKIPPED"),
    ]);
    expect(outcome.passed).toBe(true);
    expect(outcome.detail).toContain("2 attributed test(s) passed");
    expect(outcome.detail).toContain("1 skipped");
  });

  it("names the failures rather than reporting a bare false", () => {
    const outcome = dimensionOutcome("CONTRACTS", [
      test("com.momna.architecture.ApiContractTest", "FAILED", "openapi matches routes"),
      test("com.momna.platform.PlatformContractSemanticsTest"),
    ]);
    expect(outcome.passed).toBe(false);
    expect(outcome.failedTests).toEqual(["com.momna.architecture.ApiContractTest.openapi matches routes"]);
  });

  it("takes the invariants verdict from the parsed generative report, not from the suite", () => {
    // A property suite exits zero having generated nothing; only the counts can tell.
    const green = [test("com.momna.platform.featureflags.RolloutInvariantPropertyTest")];
    const unverified = dimensionOutcome("INVARIANTS", green, undefined, {
      passed: false,
      detail: "the framework was present but executed no properties",
    });
    expect(unverified.passed).toBe(false);
    expect(unverified.detail).toContain("executed no properties");

    const verified = dimensionOutcome("INVARIANTS", green, undefined, { passed: true, detail: "14 properties generated 8600 cases" });
    expect(verified.passed).toBe(true);
    expect(verified.matched).toBe(1);
  });

  it("reads outcomes out of real JUnit XML, including skips and errors", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.momna.Example" tests="4">
  <testcase name="passes" classname="com.momna.platform.PlatformContractSemanticsTest" time="0.01"/>
  <testcase name="skips" classname="com.momna.platform.cache.redis.OptionalRedisSmokeTest" time="0">
    <skipped message="REDIS_URL not set"/>
  </testcase>
  <testcase name="fails" classname="com.momna.architecture.ApiContractTest" time="0.2">
    <failure message="expected 200"/>
  </testcase>
  <testcase name="errors" classname="com.momna.architecture.ApiContractTest" time="0.2">
    <error message="boom"/>
  </testcase>
</testsuite>`;
    const parsed = parseJUnitResults(xml);
    expect(parsed).toHaveLength(4);
    expect(parsed.map((value) => value.outcome)).toEqual(["PASSED", "SKIPPED", "FAILED", "FAILED"]);
    expect(dimensionOutcome("CONTRACTS", parsed).passed).toBe(false);
  });

  it("attributes by the simple class name, so package layout does not decide the verdict", () => {
    const outcome = dimensionOutcome("SECURITY_PRIVACY", [test("some.deeply.nested.pkg.PrivacyBoundaryArchitectureTest")]);
    expect(outcome.passed).toBe(true);
  });
});
