import { describe, expect, it } from "vitest";
import {
  buildPropertyBasedReport,
  parsePropertyReportFile,
  parsePropertyRunnerOutput,
} from "../../packages/execution-engine/src/property-based-report.js";

// Real jqwik console output, which is what `gradlew test --console=plain` actually prints.
const passingJqwik = `
> Task :test

timestamp = 2026-08-29T10:11:12.001, RolloutProperties:assignmentIsMonotonic =
                              |-------------------jqwik-------------------
tries = 1000                  | # of calls to property
checks = 1000                 | # of not rejected calls
generation = RANDOMIZED       | parameters are randomly generated
after-failure = PREVIOUS_SEED | use the previous seed
edge-cases#total = 4          | # of all combined edge cases
seed = 8749914803276270960

timestamp = 2026-08-29T10:11:13.114, LocalDayProperties:dayContainsInstant =
                              |-------------------jqwik-------------------
tries = 2840                  | # of calls to property
checks = 2840                 | # of not rejected calls
generation = RANDOMIZED       | parameters are randomly generated
seed = -4410287861772430013

BUILD SUCCESSFUL in 41s
`;

const failingJqwik = `
timestamp = 2026-08-29T10:20:00.000, LocalDayProperties:dayContainsInstant =
                              |-------------------jqwik-------------------
tries = 13                    | # of calls to property
checks = 13                   | # of not rejected calls
seed = 42

Original Sample
---------------
  instant: 2026-03-08T07:00:00Z
  zone: America/New_York

Shrunk Sample (5 steps)
-----------------------
  instant: 2026-03-08T07:00:00Z
  zone: America/New_York
`;

describe("property-based evidence", () => {
  it("counts properties, generated cases and replay seeds from a real jqwik transcript", () => {
    const parsed = parsePropertyRunnerOutput(passingJqwik)!;
    expect(parsed.framework).toBe("jqwik");
    expect(parsed.properties).toBe(2);
    expect(parsed.generatedCases).toBe(3840);
    expect(parsed.shrinking).toBe("ENABLED");
    expect(parsed.replaySeeds).toEqual(["8749914803276270960", "-4410287861772430013"]);
    expect(parsed.counterexamples).toBe(0);
  });

  it("counts a shrunk counterexample and keeps the seed that replays it", () => {
    const parsed = parsePropertyRunnerOutput(failingJqwik)!;
    expect(parsed.counterexamples).toBe(1);
    const report = buildPropertyBasedReport({ required: true, suitePassed: false, parsed, source: "PARSED_RUNNER_OUTPUT" });
    expect(report.status).toBe("FAIL");
    expect(report.reasons.join(" ")).toContain("seed 42");
  });

  it("reports a required layer as UNVERIFIED when a green build says nothing about properties", () => {
    // This is the CORE-BE-01..21 situation exactly: every suite green, no generative layer at all.
    expect(parsePropertyRunnerOutput("BUILD SUCCESSFUL in 41s\n11 tests completed")).toBeUndefined();
    const report = buildPropertyBasedReport({ required: true, suitePassed: true, parsed: undefined, source: "NONE" });
    expect(report.status).toBe("UNVERIFIED");
    expect(report.evidence).toBe("NONE");
    expect(report.reasons.join(" ")).toContain("A passing build is not evidence");
  });

  it("passes a required layer only on parsed counts, never on the suite's exit code", () => {
    const report = buildPropertyBasedReport({
      required: true,
      suitePassed: true,
      parsed: parsePropertyRunnerOutput(passingJqwik),
      source: "PARSED_RUNNER_OUTPUT",
    });
    expect(report.status).toBe("PASS");
    expect(report.generatedCases).toBe(3840);
    expect(report.evidence).toBe("PARSED_RUNNER_OUTPUT");
  });

  it("refuses to pass a framework that ran zero properties", () => {
    const report = buildPropertyBasedReport({
      required: true,
      suitePassed: true,
      parsed: { framework: "jqwik", properties: 0, generatedCases: 0, shrinking: "ENABLED", replaySeeds: [], counterexamples: 0 },
      source: "PARSED_RUNNER_OUTPUT",
    });
    expect(report.status).toBe("UNVERIFIED");
  });

  it("accepts a project's own report file for a runner that stays silent on success", () => {
    // fast-check prints nothing when a property holds, so its evidence has to come from the file.
    const parsed = parsePropertyReportFile(
      JSON.stringify({ framework: "fast-check", properties: 6, generatedCases: 600, shrinking: true, replaySeeds: ["17"], counterexamples: 0 }),
    )!;
    const report = buildPropertyBasedReport({ required: true, suitePassed: true, parsed, source: "REPORT_FILE" });
    expect(report.status).toBe("PASS");
    expect(report.framework).toBe("fast-check");
    expect(report.evidence).toBe("REPORT_FILE");
  });

  it("records a run that happened even when the profile did not require one", () => {
    const report = buildPropertyBasedReport({
      required: false,
      suitePassed: true,
      parsed: parsePropertyRunnerOutput(passingJqwik),
      source: "PARSED_RUNNER_OUTPUT",
    });
    expect(report.status).toBe("NOT_APPLICABLE");
    expect(report.properties).toBe(2);
  });
});
