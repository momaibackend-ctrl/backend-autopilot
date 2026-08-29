import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { testService } from "../helpers/service.js";
import { CommandPolicy, CommandRunner, IndependentReviewer, TestEngine } from "../../packages/execution-engine/src/index.js";
import { systemClock } from "../../packages/core/src/ports.js";
import type { Artifact, ImplementationPlan, TestReport } from "../../packages/schemas/src/index.js";

// The composition this proves is the one that failed in the field: CORE-BE-01..21 merged with every
// suite green and no generative layer anywhere, because a green suite was the only thing anyone
// checked. Here the plan demands the layer, the runner reports honestly that nothing was generated,
// and review refuses -- each step by the real component, not a stub.

let cleanup: string | undefined;
afterAll(async () => {
  if (cleanup) await rm(cleanup, { recursive: true, force: true });
});

async function planFor(requirements: string[], title = "Rollout assignment", description = "Deterministic bucketing of users into a percentage rollout.") {
  const { service } = testService();
  const project = await service.projectCreate({ name: "Gate", slug: `gate-${crypto.randomUUID()}`, sourceType: "LOCAL", environment: "SANDBOX", autonomyMode: "GUARDED" });
  const task = await service.taskCreate({ projectId: project.id, externalKey: "CORE-QA-02", title, description, requirements, relationships: [] });
  await service.taskAnalyze(project.id, task.id);
  return (await service.taskPlan(project.id, task.id)).plan;
}

const artifact = (kind: Artifact["kind"]): Artifact =>
  ({ id: `${kind}-1`, projectId: "p", taskId: "t", kind, schemaVersion: "5", content: {}, contentHash: "h", status: "AVAILABLE", createdAt: systemClock.now() }) as unknown as Artifact;

describe("generative verification gate", () => {
  it("refuses to pass a required generative layer that a green suite never generated anything for", async () => {
    const plan = await planFor([
      "A user assigned at threshold X must remain assigned when the rollout percentage increases.",
    ]);
    expect(plan.testsRequired).toContain("PROPERTY");

    // A workspace whose property suite passes while generating nothing -- exactly what an
    // example-based test placed in the property file looks like from the outside.
    const workspace = await mkdtemp(join(tmpdir(), "backend-autopilot-property-"));
    cleanup = workspace;
    await mkdir(join(workspace, "tests"), { recursive: true });
    const trivial = "import test from 'node:test';import assert from 'node:assert/strict';test('ok',()=>assert.equal(1,1));";
    for (const suite of ["unit", "integration", "property", "contract", "migration", "security", "regression"]) {
      await writeFile(join(workspace, "tests", `${suite}.test.js`), trivial, "utf8");
    }

    const report = await new TestEngine(new CommandRunner(new CommandPolicy(), systemClock), systemClock).run(workspace, plan.taskId, plan);

    const property = report.suites.find((suite) => suite.type === "PROPERTY")!;
    expect(property.passed).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.propertyBased?.status).toBe("UNVERIFIED");
    expect(report.propertyBased?.evidence).toBe("NONE");
    // Every other suite really did pass; only the layer that proved nothing is held against it.
    expect(report.suites.filter((suite) => suite.type !== "PROPERTY").every((suite) => suite.passed)).toBe(true);
  }, 60_000);

  it("fails independent review when a plan requiring the layer arrives with no generative evidence", async () => {
    const plan = await planFor([
      "A user assigned at threshold X must remain assigned when the rollout percentage increases.",
    ]);
    // A test report claiming every required suite green -- including PROPERTY -- but carrying no
    // parsed counts. Before this gate existed, this passed review and reached READY.
    const report: TestReport = {
      passed: true,
      suites: plan.testsRequired.map((type) => ({ type, command: ["pnpm", "test"], passed: true, exitCode: 0 })),
      finishedAt: systemClock.now(),
    };
    const review = new IndependentReviewer(systemClock).review(plan, report, [artifact("ARCHITECTURE_REVIEW")]);
    expect(review.result).toBe("FAIL");
    expect(review.failures).toContain("propertyBasedAdequacy");
  });

  it("passes review once real generated-case evidence is present", async () => {
    const plan = await planFor([
      "A user assigned at threshold X must remain assigned when the rollout percentage increases.",
    ]);
    const report: TestReport = {
      passed: true,
      suites: plan.testsRequired.map((type) => ({ type, command: ["gradlew", "test"], passed: true, exitCode: 0 })),
      propertyBased: {
        required: true,
        framework: "jqwik",
        status: "PASS",
        evidence: "PARSED_RUNNER_OUTPUT",
        properties: 9,
        generatedCases: 3840,
        shrinking: "ENABLED",
        replaySeeds: ["8749914803276270960"],
        counterexamples: 0,
        reasons: ["9 propert(y|ies) generated 3840 case(s) with no counterexample"],
      },
      finishedAt: systemClock.now(),
    };
    const review = new IndependentReviewer(systemClock).review(plan, report, [artifact("ARCHITECTURE_REVIEW"), artifact("PROPERTY_BASED_REPORT")]);
    expect(review.failures).not.toContain("propertyBasedAdequacy");
  });

  it("leaves a task with no algorithmic invariant untouched by the new layer", async () => {
    const plan: ImplementationPlan = await planFor(
      ["Keep the persisted envelope shape unchanged."],
      "Rename audit field",
      "Rename the internal logger field on the audit record.",
    );
    expect(plan.testsRequired).not.toContain("PROPERTY");
    const report: TestReport = {
      passed: true,
      suites: plan.testsRequired.map((type) => ({ type, command: ["pnpm", "test"], passed: true, exitCode: 0 })),
      finishedAt: systemClock.now(),
    };
    const review = new IndependentReviewer(systemClock).review(plan, report, [artifact("ARCHITECTURE_REVIEW")]);
    expect(review.checks["propertyBasedAdequacy"]).toBe(true);
  });
});
