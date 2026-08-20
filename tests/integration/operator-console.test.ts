import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildControlApi } from "../../apps/control-api/src/app.js";
import { createRuntime } from "../../packages/core/src/runtime.js";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";

const workspace = await mkdtemp(join(tmpdir(), "autopilot-console-"));
await mkdir(join(workspace, "tests"));
await writeFile(
  join(workspace, "tests", "unit.test.js"),
  "import test from 'node:test';test('console validation fixture',()=>{});",
  "utf8",
);
const runtime = createRuntime({ store: new MemoryStateStore() });
const app = buildControlApi(runtime.service, runtime.operator);
afterAll(async () => {
  await app.close();
  await rm(workspace, { recursive: true, force: true });
});
describe("Operator Console API", () => {
  it("builds read models, persists validation history, and hides secret references", async () => {
    const project = await runtime.service.projectCreate({
      name: "Console Test",
      slug: "console-test",
      sourceType: "LOCAL",
      environment: "SANDBOX",
      autonomyMode: "GUARDED",
      workspacePath: workspace,
    });
    await runtime.service.resourceRegister({
      projectId: project.id,
      type: "HTTP_API",
      provider: "http",
      externalReference: "http://127.0.0.1:49999",
      environment: "SANDBOX",
      permissions: ["READ"],
      secretRefs: ["PRIVATE_API_TOKEN"],
    });
    const task = await runtime.service.taskCreate({
      projectId: project.id,
      externalKey: "UI-1",
      title: "Safe console task",
      description: "<script>globalThis.compromised=true</script>",
      requirements: ["show task safely"],
      relationships: [],
    });
    await runtime.service.taskAnalyze(project.id, task.id);
    await runtime.service.taskPlan(project.id, task.id);
    const overview = await app.inject({
      method: "GET",
      url: "/v1/console/overview",
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      summary: { projects: 1, activeTasks: 1 },
    });
    const detail = await app.inject({
      method: "GET",
      url: `/v1/console/projects/${project.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain("PRIVATE_API_TOKEN");
    expect(detail.body).toContain("[SERVER_SIDE_SECRET]");
    const validation = await app.inject({
      method: "POST",
      url: `/v1/console/projects/${project.id}/validation`,
      payload: {
        taskId: task.id,
        suite: "SMOKE",
        operationId: "console-validation-1",
      },
    });
    expect(validation.statusCode).toBe(200);
    expect(validation.json().report).toMatchObject({
      kind: "VALIDATION_REPORT",
      content: { result: "PASS", counts: { passed: 1, failed: 0, skipped: 0 } },
    });
    const history = await app.inject({
      method: "GET",
      url: `/v1/console/projects/${project.id}/validation?taskId=${task.id}`,
    });
    expect(history.json()).toHaveLength(1);
  });
  it("denies API requests to resources outside the explicit project allowlist", async () => {
    const project = (await runtime.service.projectList())[0]!;
    const response = await app.inject({
      method: "POST",
      url: `/v1/console/projects/${project.id}/api-request`,
      payload: {
        resourceId: crypto.randomUUID(),
        method: "GET",
        path: "/health",
        headers: {},
        query: {},
        operationId: "unknown-target-1",
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "POLICY_VIOLATION" },
    });
  });
  it("executes allowlisted sandbox requests and persisted multi-step scenarios", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.setHeader("set-cookie", "session=must-not-reach-browser");
      if (request.method === "POST" && request.url === "/echo") {
        response.statusCode = 201;
        response.end(
          JSON.stringify({
            note_id: "note-1",
            access_token: "sensitive-value",
          }),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/login") {
        response.end(
          JSON.stringify({
            user_id: "user-1",
            access_token: "sensitive-value",
          }),
        );
        return;
      }
      if (
        request.method === "GET" &&
        request.url === "/users/user-1" &&
        request.headers.authorization === "Bearer sensitive-value"
      ) {
        response.end(JSON.stringify({ id: "user-1" }));
        return;
      }
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "unauthorized" }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No test port");
      const project = await runtime.service.projectCreate({
        name: "API Runner",
        slug: "api-runner",
        sourceType: "LOCAL",
        environment: "STAGING",
        autonomyMode: "AUTONOMOUS_STAGING",
        workspacePath: workspace,
      });
      const resource = await runtime.service.resourceRegister({
        projectId: project.id,
        type: "HTTP_API",
        provider: "http",
        externalReference: `http://127.0.0.1:${address.port}`,
        environment: "SANDBOX",
        permissions: ["READ"],
        secretRefs: [],
      });
      const single = await app.inject({
        method: "POST",
        url: `/v1/console/projects/${project.id}/api-request`,
        payload: {
          resourceId: resource.resourceId,
          method: "POST",
          path: "/echo",
          headers: {},
          query: {},
          body: { title: "safe note" },
          expectedStatus: 201,
          operationId: "api-request-live-1",
        },
      });
      expect(single.statusCode).toBe(200);
      expect(single.json().result).toMatchObject({
        kind: "API_REQUEST_RESULT",
        content: {
          response: {
            status: 201,
            body: { note_id: "note-1", access_token: "[REDACTED]" },
          },
          validation: { passed: true },
        },
      });
      expect(single.body).not.toContain("sensitive-value");
      expect(single.body).not.toContain("set-cookie");

      const saved = await app.inject({
        method: "POST",
        url: `/v1/console/projects/${project.id}/scenarios`,
        payload: {
          resourceId: resource.resourceId,
          name: "Login and read own user",
          description: "Server-side auth handoff",
          operationId: "scenario-save-1",
          steps: [
            {
              name: "Login",
              method: "POST",
              path: "/login",
              expectedStatus: 200,
              extract: {
                user_id: { path: "response.body.user_id", sensitive: false },
                access_token: {
                  path: "response.body.access_token",
                  sensitive: true,
                },
              },
            },
            {
              name: "Read own user",
              method: "GET",
              path: "/users/{{user_id}}",
              expectedStatus: 200,
              bearerFrom: "access_token",
            },
          ],
        },
      });
      expect(saved.statusCode).toBe(200);
      const scenarioId = saved.json().scenario.id as string;
      const executed = await app.inject({
        method: "POST",
        url: `/v1/console/projects/${project.id}/scenarios/run`,
        payload: {
          scenarioArtifactId: scenarioId,
          operationId: "scenario-run-1",
        },
      });
      expect(executed.statusCode, executed.body).toBe(200);
      expect(executed.json().report).toMatchObject({
        kind: "VALIDATION_REPORT",
        content: {
          result: "PASS",
          suite: "SCENARIO",
          counts: { passed: 2, failed: 0, skipped: 0 },
        },
      });
      expect(executed.body).not.toContain("sensitive-value");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it("blocks protocol-relative paths and browser-supplied credentials", async () => {
    const project = (await runtime.service.projectList()).find(
      (value) => value.slug === "api-runner",
    );
    expect(project).toBeDefined();
    const resource = (await runtime.service.resourceList(project!.id)).find(
      (value) => value.type === "HTTP_API",
    );
    const basePayload = {
      resourceId: resource!.resourceId,
      method: "POST",
      headers: {},
      query: {},
      operationId: "security-request-1",
    };
    const originEscape = await app.inject({
      method: "POST",
      url: `/v1/console/projects/${project!.id}/api-request`,
      payload: { ...basePayload, method: "GET", path: "//example.com/steal" },
    });
    expect(originEscape.statusCode).toBe(403);
    const secretBody = await app.inject({
      method: "POST",
      url: `/v1/console/projects/${project!.id}/api-request`,
      payload: { ...basePayload, path: "/login", body: { password: "leak" } },
    });
    expect(secretBody.statusCode).toBe(403);
    expect(secretBody.body).not.toContain("leak");
  });
});
