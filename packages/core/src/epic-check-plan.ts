import type { EpicDimension } from "../../schemas/src/index.js";

// Which executed tests answer which epic dimension.
//
// The epic gate judges evidence; something has to produce it. A run of the target project's whole
// suite at one commit produces hundreds of test results, and the question "did CONSUMERS pass?"
// is answered by a subset of them. This module is that attribution, kept pure so the rule can be
// argued about and tested without a checkout.
//
// The rule that matters is what counts as a pass. A dimension passes only when tests attributed to
// it actually ran and actually passed. Three things that look like success and are not:
//
//   - no attributed test ran at all. A green build says nothing about a dimension nothing covers,
//     and treating "no failures" as "verified" is exactly the mistake the whole epic gate exists
//     to stop.
//   - every attributed test was skipped. The Optional*SmokeTest classes in a real target skip
//     themselves when their service connection variable is absent, so an integration dimension can
//     be "green" with no database ever contacted.
//   - the suite passed but the generative layer inside it generated nothing. That verdict comes
//     from the parsed property report, not from exit codes -- see property-based-report.ts.

export type TestOutcome = "PASSED" | "FAILED" | "SKIPPED";

export interface ExecutedTest {
  className: string;
  name: string;
  outcome: TestOutcome;
}

/** Which test classes answer a dimension. Conventions, not domain knowledge; overridable per project. */
export type DimensionPatterns = Record<EpicDimension, RegExp[]>;

export const defaultDimensionPatterns: DimensionPatterns = {
  CONTRACTS: [/Contract(?:Gate)?Test$/, /ApiContract\w*Test$/, /ContractSemanticsTest$/],
  CONSUMERS: [/ConsumerContractTest$/, /ModuleContractCatalogTest$/, /IntegrationContractGateTest$/, /DependencyTest$/],
  INVARIANTS: [/PropertyTest$/, /InvariantTest$/],
  INTEGRATION_DEPENDENCIES: [/IntegrationTest$/, /SmokeTest$/, /Postgres\w*Test$/, /Redis\w*Test$/, /S3\w*Test$/, /InfrastructureTest$/],
  SECURITY_PRIVACY: [/Security\w*Test$/, /Privacy\w*Test$/, /Safety\w*Test$/, /BoundaryTest$/, /AuditContractTest$/],
  MIGRATIONS: [/Migration\w*Test$/, /\w*MigrationTest$/],
  JOURNEYS: [/JourneyTest$/, /E2ETest$/, /RegressionTest$/, /HandoverOperationalDrillTest$/, /FoundationIntegrationTest$/],
};

export interface DimensionOutcome {
  dimension: EpicDimension;
  passed: boolean;
  detail: string;
  matched: number;
  failedTests: string[];
}

function matches(patterns: RegExp[], className: string) {
  const simple = className.split(".").pop() ?? className;
  return patterns.some((pattern) => pattern.test(simple));
}

/**
 * Attributes one dimension's verdict to the tests that actually ran for it.
 *
 * `propertyPassed` overrides the INVARIANTS verdict when the caller parsed a generative report:
 * a property suite can exit zero having generated nothing, and only the parsed counts can tell.
 */
export function dimensionOutcome(
  dimension: EpicDimension,
  tests: ExecutedTest[],
  patterns: DimensionPatterns = defaultDimensionPatterns,
  propertyPassed?: { passed: boolean; detail: string } | undefined,
): DimensionOutcome {
  if (dimension === "INVARIANTS" && propertyPassed) {
    const matched = tests.filter((test) => matches(patterns.INVARIANTS, test.className));
    return {
      dimension,
      passed: propertyPassed.passed,
      detail: propertyPassed.detail,
      matched: matched.length,
      failedTests: matched.filter((test) => test.outcome === "FAILED").map((test) => `${test.className}.${test.name}`),
    };
  }
  const matched = tests.filter((test) => matches(patterns[dimension], test.className));
  if (!matched.length) {
    return {
      dimension,
      passed: false,
      detail: `no test attributed to ${dimension} ran in this suite, so the run proves nothing about it`,
      matched: 0,
      failedTests: [],
    };
  }
  const failed = matched.filter((test) => test.outcome === "FAILED");
  if (failed.length) {
    return {
      dimension,
      passed: false,
      detail: `${failed.length} of ${matched.length} attributed test(s) failed`,
      matched: matched.length,
      failedTests: failed.map((test) => `${test.className}.${test.name}`),
    };
  }
  const executed = matched.filter((test) => test.outcome === "PASSED");
  if (!executed.length) {
    return {
      dimension,
      passed: false,
      detail: `all ${matched.length} attributed test(s) were skipped; a suite that opted itself out is not evidence`,
      matched: matched.length,
      failedTests: [],
    };
  }
  const skipped = matched.length - executed.length;
  return {
    dimension,
    passed: true,
    detail: `${executed.length} attributed test(s) passed${skipped ? `, ${skipped} skipped` : ""}`,
    matched: matched.length,
    failedTests: [],
  };
}

/** Parses the `<testcase>` rows out of JUnit XML, which every JVM and most other runners emit. */
export function parseJUnitResults(xml: string): ExecutedTest[] {
  const tests: ExecutedTest[] = [];
  const testcase = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(testcase)) {
    const attributes = match[1] ?? "";
    const body = match[3] ?? "";
    const name = /\bname="([^"]*)"/.exec(attributes)?.[1];
    const className = /\bclassname="([^"]*)"/.exec(attributes)?.[1];
    if (!name || !className) continue;
    const outcome: TestOutcome = /<(?:failure|error)\b/.test(body) ? "FAILED" : /<skipped\b/.test(body) ? "SKIPPED" : "PASSED";
    tests.push({ className, name, outcome });
  }
  return tests;
}
