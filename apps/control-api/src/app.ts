import Fastify from "fastify";
import {
  DomainError,
  type AutopilotService,
} from "../../../packages/core/src/index.js";
import type { OperatorConsoleService } from "../../../packages/operator-console/src/index.js";
import { logger } from "../../../packages/observability/src/index.js";
import { redact } from "../../../packages/audit/src/index.js";
import { ZodError } from "zod";

export function buildControlApi(
  service: AutopilotService,
  operator?: OperatorConsoleService,
) {
  const app = Fastify({ loggerInstance: logger });
  const consoleService = () => {
    if (!operator) throw new Error("Operator Console service is unavailable");
    return operator;
  };
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
    if (error instanceof DomainError)
      return reply
        .code(
          error.code === "NOT_FOUND"
            ? 404
            : error.code === "POLICY_VIOLATION" ||
                error.code === "NOT_SUPPORTED"
              ? 403
              : 409,
        )
        .send({
          error: {
            code: error.code,
            message: error.message,
            details: redact(error.details),
          },
        });
    request.log.error(
      {
        failure: redact({
          name: error instanceof Error ? error.name : "UnknownError",
          message: error instanceof Error ? error.message : "Unknown error",
        }),
      },
      "Control API request failed",
    );
    return reply.code(500).send({
      error: {
        code: "INTERNAL",
        message: "The request could not be completed",
      },
    });
  });
  app.get("/health", () => service.systemHealth());
  app.get("/v1/projects", () => service.projectList());
  app.post("/v1/projects", (request) => service.projectCreate(request.body));
  app.get<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/snapshot",
    (request) => service.projectSnapshot(request.params.projectId),
  );
  app.get<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/tasks",
    (request) => service.taskList(request.params.projectId),
  );
  app.get("/v1/console/overview", () => consoleService().overview());
  app.get("/v1/console/screens",()=>consoleService().screenList());
  app.get<{Params:{screenId:string}}>("/v1/console/screens/:screenId",request=>consoleService().screenGet(request.params.screenId));
  app.get("/v1/console/settings",()=>consoleService().settings());
  app.get<{ Params: { projectId: string } }>(
    "/v1/console/projects/:projectId",
    (request) => consoleService().project(request.params.projectId),
  );
  app.get<{ Params: { projectId: string; taskId: string } }>(
    "/v1/console/projects/:projectId/tasks/:taskId",
    (request) =>
      consoleService().task(request.params.projectId, request.params.taskId),
  );
  app.get<{ Params: { projectId: string }; Querystring: { taskId?: string } }>(
    "/v1/console/projects/:projectId/validation",
    (request) =>
      consoleService().validationHistory(
        request.params.projectId,
        request.query.taskId,
      ),
  );
  app.post<{ Params: { projectId: string } }>(
    "/v1/console/projects/:projectId/validation",
    (request) =>
      consoleService().runValidation(request.params.projectId, request.body),
  );
  app.post<{ Params: { projectId: string } }>(
    "/v1/console/projects/:projectId/api-request",
    (request) =>
      consoleService().runApiRequest(request.params.projectId, request.body),
  );
  app.post<{ Params: { projectId: string } }>(
    "/v1/console/projects/:projectId/scenarios",
    (request) =>
      consoleService().saveScenario(request.params.projectId, request.body),
  );
  app.post<{ Params: { projectId: string } }>(
    "/v1/console/projects/:projectId/scenarios/run",
    (request) =>
      consoleService().runScenario(request.params.projectId, request.body),
  );
  return app;
}
