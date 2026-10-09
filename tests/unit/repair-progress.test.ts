import { describe, expect, it } from "vitest";
import { STAGNATION_THRESHOLD, repairProgress, testFailureFingerprint } from "../../packages/core/src/repair-progress.js";
import type { Artifact, TestReport } from "../../packages/schemas/src/index.js";

let clock = 0;
function report(failed: Array<[string, number]>, passed = failed.length === 0): TestReport {
  return {
    passed,
    suites: [...failed.map(([type, exitCode]) => ({ type, command: ["pnpm", "test"], passed: false, exitCode })), { type: "SECURITY", command: ["pnpm", "test"], passed: true, exitCode: 0 }],
    finishedAt: "2026-10-09T10:00:00.000Z",
  };
}
function artifact(kind: string, content: unknown): Artifact {
  clock += 1;
  return { id: crypto.randomUUID(), projectId: "p", taskId: "t", kind, schemaVersion: "1", content, contentHash: "h", status: "AVAILABLE", createdAt: new Date(1_800_000_000_000 + clock * 1000).toISOString() } as Artifact;
}
const e2e = (fingerprint: string) => artifact("VALIDATION_REPORT", { suite: "HTTP_E2E", verdict: "NOT_PROVEN", diagnosis: { fingerprint } });

describe("test failure fingerprint", () => {
  it("is stable for the same failing suites and different otherwise", () => {
    expect(testFailureFingerprint(report([]))).toBeUndefined();
    expect(testFailureFingerprint(report([["UNIT", 1]]))).toBe(testFailureFingerprint(report([["UNIT", 1]])));
    expect(testFailureFingerprint(report([["UNIT", 1]]))).not.toBe(testFailureFingerprint(report([["INTEGRATION", 1]])));
    expect(testFailureFingerprint(report([["UNIT", 1], ["INTEGRATION", 2]]))).toBe(testFailureFingerprint(report([["INTEGRATION", 2], ["UNIT", 1]])));
  });
});

describe("repair progress", () => {
  it("treats a changing cause as progress and never counts passing runs", () => {
    const progress = repairProgress([
      artifact("TEST_REPORT", report([["UNIT", 1]])),
      artifact("TEST_REPORT", report([["INTEGRATION", 1]])),
      artifact("TEST_REPORT", report([])),
      artifact("TEST_REPORT", report([["SECURITY", 1]])),
    ]);
    expect(progress).toMatchObject({ failures: 3, consecutiveSameCause: 1, stagnating: false });
    expect(progress.guidance).toMatch(/progress/);
  });

  it(`flags the same cause ${STAGNATION_THRESHOLD} times in a row and asks for a new hypothesis`, () => {
    const same = () => artifact("TEST_REPORT", report([["UNIT", 1]]));
    const progress = repairProgress([artifact("TEST_REPORT", report([["INTEGRATION", 1]])), same(), same(), same()]);
    expect(progress).toMatchObject({ failures: 4, consecutiveSameCause: 3, stagnating: true });
    expect(progress.guidance).toMatch(/Do not send another variation of the same change/);
  });

  it("follows HTTP E2E diagnoses too, in order with test failures", () => {
    expect(repairProgress([e2e("aaaa"), e2e("aaaa"), e2e("aaaa")]).stagnating).toBe(true);
    expect(repairProgress([e2e("aaaa"), e2e("aaaa"), e2e("bbbb")])).toMatchObject({ consecutiveSameCause: 1, stagnating: false, latestFingerprint: "e2e:bbbb" });
    expect(repairProgress([])).toEqual({ failures: 0, consecutiveSameCause: 0, stagnating: false });
  });

  it("ignores deleted artifacts and PROVEN evidence", () => {
    const deleted = { ...artifact("TEST_REPORT", report([["UNIT", 1]])), status: "DELETED" } as Artifact;
    expect(repairProgress([deleted, artifact("VALIDATION_REPORT", { suite: "HTTP_E2E", verdict: "PROVEN" })]).failures).toBe(0);
  });
});

describe("generative invariants", () => {
  it("consecutive never exceeds failures, stagnation is exactly the threshold rule, and a new cause resets it", () => {
    const SEED = 0x4b22;
    let state = SEED;
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
    for (let index = 0; index < 400; index += 1) {
      const history = Array.from({ length: Math.floor(random() * 8) }, () =>
        random() < 0.5 ? artifact("TEST_REPORT", report(random() < 0.2 ? [] : [[["UNIT", "INTEGRATION"][Math.floor(random() * 2)] as string, 1]])) : e2e(["aaaa", "bbbb"][Math.floor(random() * 2)] as string),
      );
      const progress = repairProgress(history);
      const context = `seed=${SEED} case=${index}`;
      expect(progress.consecutiveSameCause, context).toBeLessThanOrEqual(progress.failures);
      expect(progress.stagnating, context).toBe(progress.consecutiveSameCause >= STAGNATION_THRESHOLD);
      const fresh = repairProgress([...history, e2e(`new-${index}`)]);
      expect(fresh.consecutiveSameCause, context).toBe(1);
      expect(fresh.stagnating, context).toBe(false);
    }
  });
});
