import { describe, expect, it } from "vitest";
import { diagnoseHttpE2e, errorLines } from "../../packages/ephemeral-environment/src/diagnosis.js";
import { ENVIRONMENT_EVIDENCE_VERSION, type EnvironmentEvidence } from "../../packages/ephemeral-environment/src/evidence.js";

function evidence(failure: { class: string; step: string; message: string }, extra: Partial<EnvironmentEvidence> = {}): EnvironmentEvidence {
  return {
    evidenceVersion: ENVIRONMENT_EVIDENCE_VERSION,
    startedAt: "2026-10-09T10:00:00.000Z",
    completedAt: "2026-10-09T10:05:00.000Z",
    durationMs: 300_000,
    plan: { port: 8080, health: ["/actuator/health", "/health", "/"] },
    outcome: { verdict: "NOT_PROVEN", failure: failure as never, reasons: [] },
    steps: [],
    scenarioReports: [],
    ...extra,
  } as EnvironmentEvidence;
}

const gradleCompileError = `> Task :compileKotlin FAILED
e: file:///workspace/src/main/kotlin/NotesController.kt:42:17 Unresolved reference: findByOwner
e: file:///workspace/src/main/kotlin/NotesController.kt:57:9 Type mismatch: inferred type is String but Long was expected
FAILURE: Build failed with an exception.`;

describe("HTTP E2E diagnosis", () => {
  it("is absent for a PROVEN verdict", () => {
    expect(diagnoseHttpE2e({ ...evidence({ class: "BUILD_FAILED", step: "x", message: "y" }), outcome: { verdict: "PROVEN", reasons: [] } })).toBeUndefined();
  });

  it("points a compile error at the implementation with the compiler's own lines", () => {
    const diagnosis = diagnoseHttpE2e(
      evidence({ class: "BUILD_FAILED", step: "build: ./gradlew --no-daemon assemble -x test", message: "exited with 1" }, {
        steps: [{ phase: "build", name: "./gradlew --no-daemon assemble -x test", status: "FAILED", durationMs: 9000, exitCode: 1, logTail: gradleCompileError }],
      }),
    );
    expect(diagnosis).toMatchObject({ area: "IMPLEMENTATION", failureClass: "BUILD_FAILED" });
    expect(diagnosis?.findings.map((finding) => finding.detail)).toEqual([
      "e: file:///workspace/src/main/kotlin/NotesController.kt:42:17 Unresolved reference: findByOwner",
      "e: file:///workspace/src/main/kotlin/NotesController.kt:57:9 Type mismatch: inferred type is String but Long was expected",
      "FAILURE: Build failed with an exception.",
    ]);
  });

  it("never blames the project for a command the environment could not execute (the Momna gradlew case)", () => {
    const diagnosis = diagnoseHttpE2e(
      evidence({ class: "BUILD_FAILED", step: "build: ./gradlew --no-daemon assemble -x test", message: "exited with 126" }, {
        steps: [{ phase: "build", name: "./gradlew --no-daemon assemble -x test", status: "FAILED", durationMs: 40, exitCode: 126, logTail: "/workspace/gradlew: Permission denied" }],
      }),
    );
    expect(diagnosis).toMatchObject({ area: "INFRASTRUCTURE", findings: [{ kind: "unexecutable-command", detail: "/workspace/gradlew: Permission denied" }] });
    expect(diagnosis?.nextSteps[0]).toMatch(/do not change the project/);
    const missingTool = diagnoseHttpE2e(
      evidence({ class: "BUILD_FAILED", step: "install: pnpm install", message: "exited with 127" }, {
        steps: [{ phase: "install", name: "pnpm install", status: "FAILED", durationMs: 5, exitCode: 127, logTail: "sh: 1: pnpm: not found" }],
      }),
    );
    expect(missingTool?.area).toBe("INFRASTRUCTURE");
  });

  it("tells a dependency download failure apart from a code error", () => {
    const diagnosis = diagnoseHttpE2e(
      evidence({ class: "BUILD_FAILED", step: "install: npm ci", message: "exited with 1" }, {
        steps: [{ phase: "install", name: "npm ci", status: "FAILED", durationMs: 1000, exitCode: 1, logTail: "npm ERR! code ENOTFOUND\nnpm ERR! network request to https://registry.npmjs.org/pg failed" }],
      }),
    );
    expect(diagnosis?.area).toBe("INFRASTRUCTURE");
  });

  it("names the configuration a Spring application could not resolve", () => {
    const diagnosis = diagnoseHttpE2e(
      evidence({ class: "ENVIRONMENT_BOOT_FAILED", step: "start", message: "the application exited before answering HTTP" }, {
        applicationLogTail: "Caused by: java.lang.IllegalArgumentException: Could not resolve placeholder 'APP_JWT_ISSUER' in value \"${APP_JWT_ISSUER}\"",
      }),
    );
    expect(diagnosis).toMatchObject({ area: "ENVIRONMENT_MANIFEST", summary: 'The application expects configuration "APP_JWT_ISSUER" that the environment does not provide.' });
    expect(diagnosis?.nextSteps[0]).toContain("APP_JWT_ISSUER");
  });

  it("recognises an application connecting to localhost instead of the provided database", () => {
    const diagnosis = diagnoseHttpE2e(
      evidence({ class: "ENVIRONMENT_BOOT_FAILED", step: "start", message: "exited" }, {
        applicationLogTail: "org.postgresql.util.PSQLException: Connection to localhost:5432 refused. Check that the hostname and port are correct",
      }),
    );
    expect(diagnosis?.area).toBe("ENVIRONMENT_MANIFEST");
    expect(diagnosis?.nextSteps[0]).toContain("{{postgres.host}}");
  });

  it("points a failing migration step at the implementation", () => {
    const diagnosis = diagnoseHttpE2e(
      evidence({ class: "ENVIRONMENT_BOOT_FAILED", step: "prepare: npx prisma migrate deploy", message: "exited with 1" }, {
        steps: [{ phase: "prepare", name: "npx prisma migrate deploy", status: "FAILED", durationMs: 2000, exitCode: 1, logTail: "Error: P3018 A migration failed to apply.\nERROR: column \"owner\" does not exist" }],
      }),
    );
    expect(diagnosis?.area).toBe("IMPLEMENTATION");
    expect(diagnosis?.findings.some((finding) => finding.kind === "prepare-error")).toBe(true);
  });

  it("detects an application listening on another port", () => {
    const diagnosis = diagnoseHttpE2e(
      evidence({ class: "HEALTH_CHECK_FAILED", step: "health", message: "no probe answered" }, { applicationLogTail: "INFO  Application - Responding at http://0.0.0.0:9090\nNetty started on port 9090" }),
    );
    expect(diagnosis).toMatchObject({ area: "ENVIRONMENT_MANIFEST", summary: "The application listens on port 9090, not on 8080." });
  });

  it("judges failing scenario steps by what the server answered", () => {
    const report = (steps: Array<Record<string, unknown>>) => ({ scenarioName: "Notes", steps });
    const implementation = diagnoseHttpE2e(
      evidence({ class: "SCENARIO_FAILED", step: "collection", message: "2 of 3 scenario(s) did not pass" }, {
        scenarioReports: [report([
          { name: "Create", method: "POST", path: "/notes", status: "FAILED", httpStatus: 500, expectedStatus: 201 },
          { name: "Read", method: "GET", path: "/notes/1", status: "FAILED", httpStatus: 404, expectedStatus: 200 },
          { name: "List", method: "GET", path: "/notes", status: "PASSED", httpStatus: 200 },
        ])],
      }),
    );
    expect(implementation?.area).toBe("IMPLEMENTATION");
    expect(implementation?.findings.map((finding) => finding.detail)).toEqual([
      "Notes › Create: POST /notes answered 500, expected 201 -- the application failed while handling the request (see the application log)",
      "Notes › Read: GET /notes/1 answered 404, expected 200 -- the route or the resource does not exist in this implementation",
    ]);
    const scenarios = diagnoseHttpE2e(
      evidence({ class: "SCENARIO_FAILED", step: "collection", message: "1 of 1" }, {
        scenarioReports: [report([
          { name: "Me", method: "GET", path: "/me", status: "FAILED", httpStatus: 401, expectedStatus: 200 },
          { name: "Read", method: "GET", path: "/notes/{{note_id}}", status: "ERROR", error: { message: "Scenario variable note_id is missing" } },
        ])],
      }),
    );
    expect(scenarios?.area).toBe("SCENARIOS");
  });

  it("lists uncovered operations, inventory gaps and parity differences", () => {
    const coverage = diagnoseHttpE2e(evidence({ class: "COVERAGE_INCOMPLETE", step: "collection", message: "2 operations" }, { collection: { coverage: { uncovered: [{ method: "PUT", path: "/notes/{id}" }], uncoveredOperations: 1, totalOperations: 5 } } }));
    expect(coverage).toMatchObject({ area: "SCENARIOS", findings: [{ kind: "uncovered-operation", detail: "PUT /notes/{id}" }] });
    const gap = diagnoseHttpE2e(evidence({ class: "CONTRACT_GAP", step: "collection", message: "gap" }, { collection: { coverage: { incomplete: [{ source: "checkin.yaml", reason: "unresolved $ref" }] } } }));
    expect(gap?.area).toBe("CONTRACT");
    const parity = diagnoseHttpE2e(
      evidence({ class: "PARITY_MISMATCH", step: "parity", message: "1 difference" }, {
        parity: { verdict: "MISMATCH", comparedSteps: 3, matchedSteps: 2, uncomparedSteps: 0, differenceCount: 1, differences: [{ scenario: "Notes", step: "Read", kind: "BODY", path: "$.archived", reference: "<boolean>", subject: "<absent>" }] },
      }),
    );
    expect(parity?.area).toBe("IMPLEMENTATION");
    expect(parity?.findings[0]?.detail).toContain("$.archived");
  });

  it("covers the infrastructure, plan, dependency, reference and empty-collection classes", () => {
    const area = (failureClass: string) => diagnoseHttpE2e(evidence({ class: failureClass, step: "x", message: "m" }))?.area;
    expect(area("INFRASTRUCTURE_UNAVAILABLE")).toBe("INFRASTRUCTURE");
    expect(area("PLAN_UNRESOLVED")).toBe("ENVIRONMENT_MANIFEST");
    expect(area("DEPENDENCY_UNAVAILABLE")).toBe("ENVIRONMENT_MANIFEST");
    expect(area("REFERENCE_NOT_PROVEN")).toBe("REFERENCE");
    expect(area("NO_SCENARIOS")).toBe("SCENARIOS");
  });

  it("fingerprints the cause, not the run: same error elsewhere matches, a different error does not", () => {
    const run = (log: string) =>
      diagnoseHttpE2e(
        evidence({ class: "BUILD_FAILED", step: "build", message: "exited with 1" }, { steps: [{ phase: "build", name: "build", status: "FAILED", durationMs: 1, exitCode: 1, logTail: log }] }),
      )?.fingerprint;
    const first = run("e: file:///workspace/a/Notes.kt:42:17 Unresolved reference: findByOwner");
    const later = run("e: file:///runner/b/c/Notes.kt:43:3 Unresolved reference: findByOwner");
    const different = run("e: file:///workspace/a/Notes.kt:42:17 Type mismatch: inferred type is String");
    expect(first).toMatch(/^[0-9a-f]{8}$/);
    expect(later).toBe(first);
    expect(different).not.toBe(first);
  });

  it("extracts error lines without duplicates and within the limit", () => {
    expect(errorLines("ok\nerror: one\nerror: one\nTypeError: two\nfine", 5)).toEqual(["error: one", "TypeError: two"]);
    expect(errorLines(undefined)).toEqual([]);
  });
});
