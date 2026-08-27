import { describe, expect, it } from "vitest";
import { testService } from "../helpers/service.js";

// CORE-BE-07, CORE-BE-09 and CORE-BE-10 each stalled on independent review with the same single
// failure -- apiCompatibility -- because buildPlan's naive /api|rest|endpoint|openapi/i scan
// couldn't tell "add a REST endpoint" from "do not add one". All three real requirement texts
// explicitly say INTERNAL_ONLY; that phrase is the fix's actual signal, so the regression fixtures
// below are excerpts of what really shipped in those tasks, not synthetic strings invented to make
// the test pass.
async function plannedTask(input: { title: string; description: string; requirements: string[] }) {
  const { service } = testService();
  const project = await service.projectCreate({
    name: "Plan",
    slug: `plan-${crypto.randomUUID()}`,
    sourceType: "LOCAL",
    environment: "SANDBOX",
    autonomyMode: "GUARDED",
  });
  const task = await service.taskCreate({
    projectId: project.id,
    externalKey: "TASK-1",
    ...input,
    relationships: [],
  });
  await service.taskAnalyze(project.id, task.id);
  const { plan } = await service.taskPlan(project.id, task.id);
  return plan;
}

describe("buildPlan API-change detection", () => {
  it("does not require API_CONTRACT evidence for an INTERNAL_ONLY contract that merely mentions REST/API in a negative sense", async () => {
    // Excerpted from CORE-BE-10's actual requirements.
    const plan = await plannedTask({
      title: "Momna CORE-BE-10 — Context Platform: purpose-based context collection and snapshots",
      description:
        "Implement the canonical Context Platform on the current merged main. Preserve CORE-BE-01..09 behavior.",
      requirements: [
        "Expose a typed INTERNAL_ONLY Context Platform contract for at least buildContext/createSnapshot, getSnapshot, resolveCurrentContext and validatePurpose/access. Do not invent public product HTTP APIs solely for this task.",
        "If an attempt leaves a dirty or inconsistent workspace, preserve diagnostics and restart from a clean checkout/checkpoint rather than layering repairs.",
      ],
    });
    expect(plan.apiChanges).toEqual([]);
    // The false positive this fix removes is specifically the review-gate expectation; asking for
    // more test coverage than strictly needed is harmless, so CONTRACT-suite coverage still runs.
    expect(plan.testsRequired).toContain("CONTRACT");
  });

  it("does not require API_CONTRACT evidence for the CORE-BE-07 and CORE-BE-09 phrasing either", async () => {
    const be07 = await plannedTask({
      title: "Momna CORE-BE-07 — Canonical Field Registry",
      description: "Implement the canonical Field Registry.",
      requirements: [
        "Mark the contract INTERNAL_ONLY unless an existing repository/API convention proves external HTTP exposure is required.",
      ],
    });
    expect(be07.apiChanges).toEqual([]);

    const be09 = await plannedTask({
      title: "Momna CORE-BE-09 — Universal Flow Engine",
      description: "Implement the Universal Flow Engine.",
      requirements: [
        "Keep the contract INTERNAL_ONLY unless current repository conventions require HTTP exposure. Preserve existing REST paths, status codes and product behavior.",
      ],
    });
    expect(be09.apiChanges).toEqual([]);
  });

  it("still requires API_CONTRACT evidence for a task that genuinely adds a public endpoint", async () => {
    const plan = await plannedTask({
      title: "Add a public webhook receiver endpoint",
      description: "Expose a new REST endpoint so external billing providers can post webhook events.",
      requirements: ["Document the new endpoint in openapi.json with request/response schemas."],
    });
    expect(plan.apiChanges.length).toBeGreaterThan(0);
    expect(plan.testsRequired).toContain("CONTRACT");
  });

  it("no longer treats 'restart' as a REST mention", async () => {
    // Every task carries this exact clause (it is in the standard requirements template), so an
    // unbounded /rest/i match against "restart" alone would make api=true -- and therefore
    // CONTRACT-suite coverage required -- on every single task regardless of content.
    const plan = await plannedTask({
      title: "Cleanup task",
      description: "Tidy up temporary files left behind by old runs.",
      requirements: [
        "If an attempt leaves a dirty or inconsistent workspace, restart from a clean checkout.",
      ],
    });
    expect(plan.apiChanges).toEqual([]);
    expect(plan.testsRequired).not.toContain("CONTRACT");
  });
});
