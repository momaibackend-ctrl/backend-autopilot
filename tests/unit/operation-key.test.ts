import { describe, expect, it } from "vitest";
import { computeApiCoverage, inventoryFromContractArtifact, operationKey } from "../../packages/http-runner/src/collection.js";

const contract = (actionParameter: string) => ({
  openapi: "3.1.0",
  paths: {
    [`/api/v1/flow-instances/{instanceId}/actions/{${actionParameter}}`]: { post: { responses: { "200": { description: "ok" }, "401": { description: "no" } } } },
    "/api/v1/flow-instances/{instanceId}": { get: { responses: { "200": { description: "ok" } } } },
  },
});

describe("operation identity", () => {
  it("ignores path parameter names but not methods, literals or segment counts", () => {
    expect(operationKey("post", "/flows/{id}/actions/{action}")).toBe(operationKey("POST", "/flows/{instanceId}/actions/{actionCode}"));
    expect(operationKey("GET", "/flows/{id}")).not.toBe(operationKey("POST", "/flows/{id}"));
    expect(operationKey("GET", "/flows/{id}/result")).not.toBe(operationKey("GET", "/flows/{id}/{part}"));
    expect(operationKey("GET", "/flows/{id}")).not.toBe(operationKey("GET", "/flows/{id}/{part}"));
  });

  it("two contracts naming the same route's parameter differently document one operation, and one request covers it", () => {
    const inventory = inventoryFromContractArtifact({ contracts: [{ path: "openapi.json", document: contract("actionCode") }, { path: "openapi-onboarding.json", document: contract("action") }] })!;
    expect(inventory.operations.map((operation) => `${operation.method} ${operation.path}`)).toEqual(["POST /api/v1/flow-instances/{instanceId}/actions/{actionCode}", "GET /api/v1/flow-instances/{instanceId}"]);
    const coverage = computeApiCoverage(inventory, [{ scenario: "s", step: "action", method: "POST", path: "/api/v1/flow-instances/i-1/actions/BACK", status: "PASSED", httpStatus: 401 }, { scenario: "s", step: "read", method: "GET", path: "/api/v1/flow-instances/i-1", status: "PASSED", httpStatus: 200 }], "EXECUTED");
    expect(coverage).toMatchObject({ status: "COMPLETE", totalOperations: 2, coveredOperations: 2 });
  });
});
