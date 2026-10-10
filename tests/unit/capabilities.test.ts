import { describe, expect, it } from "vitest";
import { repositoryCapabilities, type GitHubView, type RuntimeWiring } from "../../packages/superadmin/src/capabilities.js";
import type { Project, Resource } from "../../packages/schemas/src/index.js";

const project = (autonomyMode: Project["autonomyMode"] = "AUTONOMOUS_STAGING"): Pick<Project, "id" | "environment" | "autonomyMode"> => ({ id: "p1", environment: "STAGING", autonomyMode });
const runtime: RuntimeWiring = { repositoryReads: true, execution: true, httpE2e: true };
const github: GitHubView = { reachable: true, reportedName: "acme/java", visibility: "public", push: true, admin: true };
function repo(permissions: Resource["permissions"], overrides: Partial<Resource> = {}): Resource {
  return { resourceId: "java", type: "GITHUB_REPOSITORY", provider: "github", externalReference: "acme/java", projectId: "p1", environment: "SANDBOX", permissions, status: "ACTIVE", secretRefs: [], createdAt: "2026-10-10T00:00:00.000Z", ...overrides };
}
const allowed = (value: ReturnType<typeof repositoryCapabilities>) => Object.entries(value.capabilities).filter(([, verdict]) => verdict.allowed).map(([name]) => name);

describe("repository capabilities", () => {
  it("a READ registration reads, plans and verifies, but cannot change code -- and says how to get FULL", () => {
    const value = repositoryCapabilities({ project: project(), runtime, resource: repo(["READ"]), github });
    expect(allowed(value)).toEqual(["READ_AND_PLAN", "HTTP_E2E"]);
    expect(value.capabilities.EXECUTE_CHANGES.missing[0]?.remediation).toContain('access:"FULL"');
    expect(value.capabilities.MERGE_PULL_REQUEST.missing[0]?.requirement).toBe("WRITE and ADMIN on the registration (it has READ)");
  });

  it("FULL on the canonical repository allows everything", () => {
    const value = repositoryCapabilities({ project: project(), runtime, resource: repo(["READ", "WRITE", "ADMIN"]), github, canonical: { resourceId: "java", repository: "acme/java" } });
    expect(value.role).toBe("CANONICAL");
    expect(allowed(value)).toEqual(["READ_AND_PLAN", "HTTP_E2E", "EXECUTE_CHANGES", "OPEN_PULL_REQUEST", "MERGE_PULL_REQUEST", "RENAME"]);
  });

  it("names the canonical repository when another one is the development target", () => {
    const value = repositoryCapabilities({ project: project(), runtime, resource: repo(["READ", "WRITE", "ADMIN"]), github, canonical: { resourceId: "kotlin", repository: "acme/kotlin" } });
    expect(value.capabilities.EXECUTE_CHANGES.allowed).toBe(false);
    expect(value.capabilities.EXECUTE_CHANGES.missing.map((value) => value.remediation).join(" ")).toMatch(/superadmin_canonical_repository_promote/);
    expect(value.capabilities.HTTP_E2E.allowed).toBe(true);
  });

  it("names the autonomy mode for environments and execution", () => {
    const guarded = repositoryCapabilities({ project: project("GUARDED"), runtime, resource: repo(["READ", "WRITE"]), github });
    expect(guarded.capabilities.HTTP_E2E.missing[0]?.remediation).toContain('autonomyMode:"AUTONOMOUS_STAGING"');
    expect(guarded.capabilities.EXECUTE_CHANGES.allowed).toBe(true);
    const observe = repositoryCapabilities({ project: project("OBSERVE"), runtime, resource: repo(["READ", "WRITE"]), github });
    expect(observe.capabilities.EXECUTE_CHANGES.allowed).toBe(false);
  });

  it("reports GitHub-side gaps: unreachable, renamed, no push, no admin", () => {
    expect(repositoryCapabilities({ project: project(), runtime, resource: repo(["READ"]), github: { reachable: false } }).capabilities.READ_AND_PLAN.allowed).toBe(false);
    const renamed = repositoryCapabilities({ project: project(), runtime, resource: repo(["READ"]), github: { ...github, reportedName: "acme/java-v2" } });
    expect(renamed.capabilities.READ_AND_PLAN.missing[0]?.remediation).toContain('repository:"acme/java-v2"');
    const noAdmin = repositoryCapabilities({ project: project(), runtime, resource: repo(["READ", "WRITE", "ADMIN"]), github: { ...github, admin: false } });
    expect(noAdmin.capabilities.MERGE_PULL_REQUEST.allowed).toBe(false);
    expect(noAdmin.capabilities.OPEN_PULL_REQUEST.allowed).toBe(true);
    const noPush = repositoryCapabilities({ project: project(), runtime, resource: repo(["READ", "WRITE"]), github: { ...github, push: false } });
    expect(noPush.capabilities.EXECUTE_CHANGES.allowed).toBe(false);
  });

  it("reports deployment wiring separately from what the agent can fix", () => {
    const value = repositoryCapabilities({ project: project(), runtime: { repositoryReads: true, execution: false, httpE2e: false }, resource: repo(["READ", "WRITE"]), github });
    expect(value.capabilities.HTTP_E2E.missing.map((value) => value.requirement)).toEqual(["the HTTP E2E dispatcher in this deployment"]);
    expect(value.capabilities.EXECUTE_CHANGES.missing.map((value) => value.requirement)).toEqual(["the execution dispatcher in this deployment"]);
  });
});
