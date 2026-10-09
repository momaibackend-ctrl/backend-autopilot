import { describe, expect, it } from "vitest";
import { compareExecutions, differingPaths, normalizeBody, stepsFromReports, type ComparableStep } from "../../packages/ephemeral-environment/src/parity.js";

function step(overrides: Partial<ComparableStep> & { index: number }): ComparableStep {
  return { scenario: "Notes", step: `step ${overrides.index}`, method: "GET", path: "/notes/1", status: "PASSED", httpStatus: 200, contentType: "application/json", body: { title: "a" }, bodyTruncated: false, ...overrides };
}

describe("parity normalization", () => {
  it("replaces run-specific values by their type and keeps business data and formats", () => {
    expect(
      normalizeBody({
        id: 42,
        userId: "u-9",
        uuid: "0b6f1c2e-8b1a-4c4e-9a7e-1c2d3e4f5a6b",
        token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl",
        createdAt: "2026-10-09T10:00:00Z",
        sentOn: "2026-10-09T10:00:00.123Z",
        birthDate: "1990-04-01",
        title: "kept",
        nested: [{ id: 1, amount: 10 }],
      }),
    ).toEqual({
      birthDate: "1990-04-01",
      createdAt: "<datetime:dddd-dd-ddTdd:dd:ddZ>",
      id: "<number>",
      nested: [{ amount: 10, id: "<number>" }],
      sentOn: "<datetime:dddd-dd-ddTdd:dd:dd.dddZ>",
      title: "kept",
      token: "<token>",
      userId: "<string>",
      uuid: "<string>",
    });
  });

  it("names the first differing paths", () => {
    expect(differingPaths({ a: { b: 1, c: [1, 2] } }, { a: { b: 2, c: [1] }, d: true })).toEqual([
      { path: "$.a.b", reference: 1, subject: 2 },
      { path: "$.a.c.length", reference: 2, subject: 1 },
      { path: "$.d", reference: "<absent>", subject: "<boolean>" },
    ]);
  });
});

describe("parity comparison", () => {
  it("matches identical runs whose generated values differ", () => {
    const reference = [step({ index: 0, body: { id: 1, title: "a", createdAt: "2026-01-01T00:00:00Z" } })];
    const subject = [step({ index: 0, body: { id: 77, title: "a", createdAt: "2026-10-09T12:34:56Z" } })];
    expect(compareExecutions(reference, subject)).toMatchObject({ verdict: "MATCH", comparedSteps: 1, matchedSteps: 1, differenceCount: 0 });
  });

  it("reports status, outcome, content type, body and timestamp-format differences", () => {
    const reference = [
      step({ index: 0, httpStatus: 404, status: "PASSED" }),
      step({ index: 1, contentType: "application/json" }),
      step({ index: 2, body: { title: "a", sentAt: "2026-01-01T00:00:00Z", tags: ["x"] } }),
    ];
    const subject = [
      step({ index: 0, httpStatus: 400, status: "FAILED" }),
      step({ index: 1, contentType: "text/plain" }),
      step({ index: 2, body: { title: "a", sentAt: "2026-01-01T00:00:00.000Z", tags: [] } }),
    ];
    const report = compareExecutions(reference, subject);
    expect(report.verdict).toBe("MISMATCH");
    expect(report.differences.map((value) => [value.kind, value.path ?? ""])).toEqual([
      ["OUTCOME", ""],
      ["STATUS", ""],
      ["CONTENT_TYPE", ""],
      ["BODY", "$.sentAt"],
      ["BODY", "$.tags.length"],
    ]);
    expect(report.matchedSteps).toBe(0);
  });

  it("reports steps only one side has and bodies that cannot be compared", () => {
    const report = compareExecutions([step({ index: 0 }), step({ index: 1, bodyTruncated: true })], [step({ index: 1 }), step({ index: 2 })]);
    expect(report.differences.map((value) => value.kind)).toEqual(["MISSING_IN_SUBJECT", "UNCOMPARED", "MISSING_IN_REFERENCE"]);
    expect(report.uncomparedSteps).toBe(1);
    expect(report.verdict).toBe("MISMATCH");
  });

  it("reads steps from the scenario reports an environment run collects", () => {
    const steps = stepsFromReports([
      {
        scenarioName: "Notes",
        steps: [
          { index: 0, name: "Read", method: "GET", path: "/notes/1", status: "PASSED", httpStatus: 200, response: { headers: { "content-type": "application/json; charset=utf-8" }, body: { id: 1 }, truncated: false } },
          { index: 1, name: "Big", method: "GET", path: "/notes", status: "PASSED", httpStatus: 200, response: { headers: {}, body: { truncated: true, bytes: 99999, preview: "[" }, truncated: false } },
          { index: 2, name: "Skipped", method: "GET", path: "/x", status: "SKIPPED" },
        ],
      },
      "not a report",
    ]);
    expect(steps.map((value) => [value.step, value.contentType, value.bodyTruncated])).toEqual([
      ["Read", "application/json", false],
      ["Big", undefined, true],
      ["Skipped", undefined, false],
    ]);
  });
});

describe("generative invariants", () => {
  const SEED = 0x9a21;
  let state = SEED;
  const random = () => {
    state = (state * 1103515245 + 12345) >>> 0;
    return state / 4294967296;
  };
  const pick = <T,>(values: T[]) => values[Math.floor(random() * values.length)] as T;
  const value = (depth: number): unknown => {
    const kind = Math.floor(random() * (depth > 2 ? 5 : 7));
    if (kind === 0) return Math.floor(random() * 1000);
    if (kind === 1) return pick(["a", "b", "2026-01-01T00:00:00Z", "0b6f1c2e-8b1a-4c4e-9a7e-1c2d3e4f5a6b", "1990-04-01"]);
    if (kind === 2) return random() < 0.5;
    if (kind === 3) return null;
    if (kind === 4) return pick(["<string>", "x.y"]);
    if (kind === 5) return Array.from({ length: Math.floor(random() * 3) }, () => value(depth + 1));
    return Object.fromEntries(Array.from({ length: Math.floor(random() * 4) }, () => [pick(["id", "title", "createdAt", "userId", "amount", "items"]), value(depth + 1)]));
  };
  const steps = () =>
    Array.from({ length: 1 + Math.floor(random() * 5) }, (_, index) =>
      step({ index, scenario: pick(["A", "B"]), httpStatus: pick([200, 201, 404]), body: value(0), bodyTruncated: random() < 0.1 }),
    );

  it("a run compared with itself matches unless a body was truncated", () => {
    for (let index = 0; index < 400; index += 1) {
      const run = steps();
      const report = compareExecutions(run, structuredClone(run));
      const context = `seed=${SEED} case=${index}`;
      const truncated = new Set(run.filter((value) => value.bodyTruncated).map((value) => `${value.scenario}#${value.index}`));
      expect(report.differences.every((value) => value.kind === "UNCOMPARED"), context).toBe(true);
      expect(report.verdict === "MATCH", context).toBe(truncated.size === 0 && new Set(run.map((value) => `${value.scenario}#${value.index}`)).size === run.length);
    }
  });

  it("normalization is idempotent and the difference count is symmetric", () => {
    for (let index = 0; index < 400; index += 1) {
      const body = value(0);
      const context = `seed=${SEED} case=${index}`;
      expect(normalizeBody(normalizeBody(body)), context).toEqual(normalizeBody(body));
      const left = steps();
      const right = steps();
      expect(compareExecutions(left, right).differenceCount, context).toBe(compareExecutions(right, left).differenceCount);
    }
  });
});
