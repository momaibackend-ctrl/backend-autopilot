import { describe, expect, it } from "vitest";
import { buildControlApi } from "../../apps/control-api/src/app.js";
import { createRuntime } from "../../packages/core/src/runtime.js";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";

describe("Operator Console security", () => {
  it("technically denies every production validation and request action", async () => {
    const store = new MemoryStateStore();
    const now = new Date().toISOString();
    const projectId = crypto.randomUUID();
    await store.createProject({
      id: projectId,
      name: "Injected production fixture",
      slug: "injected-production-fixture",
      sourceType: "LOCAL",
      environment: "PRODUCTION",
      autonomyMode: "GUARDED",
      status: "ACTIVE",
      workspacePath: "tests/.tmp/never-executed",
      createdAt: now,
      updatedAt: now,
    });
    const runtime = createRuntime({ store });
    const app = buildControlApi(runtime.service, runtime.operator);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/console/projects/${projectId}/api-request`,
        payload: {
          resourceId: crypto.randomUUID(),
          method: "GET",
          path: "/health",
          headers: {},
          query: {},
          operationId: "production-deny-1",
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: { code: "NOT_SUPPORTED" },
      });
    } finally {
      await app.close();
    }
  });

  it("cannot run a scenario artifact under another project", async () => {
    const store = new MemoryStateStore();
    const runtime = createRuntime({ store });
    const a = await runtime.service.projectCreate({
      name: "Scenario A",
      slug: "scenario-a",
      sourceType: "LOCAL",
      environment: "STAGING",
      autonomyMode: "AUTONOMOUS_STAGING",
      workspacePath: "tests/.tmp/scenario-a",
    });
    const b = await runtime.service.projectCreate({
      name: "Scenario B",
      slug: "scenario-b",
      sourceType: "LOCAL",
      environment: "STAGING",
      autonomyMode: "AUTONOMOUS_STAGING",
      workspacePath: "tests/.tmp/scenario-b",
    });
    const resource = await runtime.service.resourceRegister({
      projectId: a.id,
      type: "HTTP_API",
      provider: "http",
      externalReference: "http://127.0.0.1:49998",
      environment: "SANDBOX",
      permissions: ["READ"],
      secretRefs: [],
    });
    const saved = await runtime.operator.saveScenario(a.id, {
      resourceId: resource.resourceId,
      name: "A private scenario",
      description: "belongs to A",
      operationId: "cross-project-save-1",
      steps: [{ name: "Health", method: "GET", path: "/health" }],
    });
    await expect(
      runtime.operator.runScenario(b.id, {
        scenarioArtifactId: saved.scenario.id,
        operationId: "cross-project-run-1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
