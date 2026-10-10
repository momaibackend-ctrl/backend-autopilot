// What a remote agent can do with each registered repository of a project, and what is missing
// for everything it cannot (ADR 024).
//
// Remote development kept failing one refusal at a time: a repository registered READ could not
// receive a change set, a task still INGESTED could not be executed, a project whose canonical
// repository is another one could not develop here at all -- and each refusal surfaced only after
// the agent had prepared the work, often with no remediation. This answers the whole question up
// front, from the same conditions the real tools enforce, so the agent sees every gap and the exact
// call that closes it before it starts.
//
// Pure: the service gathers the facts (records, live GitHub view, runtime wiring); this decides.
import type { Project, Resource } from "../../schemas/src/index.js";

export type Capability = "READ_AND_PLAN" | "HTTP_E2E" | "EXECUTE_CHANGES" | "OPEN_PULL_REQUEST" | "MERGE_PULL_REQUEST" | "RENAME";
export interface Requirement {
  requirement: string;
  remediation: string;
}
export interface CapabilityVerdict {
  allowed: boolean;
  missing: Requirement[];
}
export interface RepositoryCapabilities {
  resourceId: string;
  repository: string;
  permissions: Resource["permissions"];
  role: "CANONICAL" | "REGISTERED";
  github: GitHubView;
  capabilities: Record<Capability, CapabilityVerdict>;
}
/** The control-plane identity's live view of the repository; `reachable: false` when unknown. */
export interface GitHubView {
  reachable: boolean;
  reportedName?: string;
  visibility?: string;
  push?: boolean;
  admin?: boolean;
}
export interface RuntimeWiring {
  repositoryReads: boolean;
  execution: boolean;
  httpE2e: boolean;
}

export function repositoryCapabilities(input: {
  project: Pick<Project, "id" | "environment" | "autonomyMode">;
  runtime: RuntimeWiring;
  canonical?: { resourceId: string; repository: string };
  resource: Resource;
  github: GitHubView;
}): RepositoryCapabilities {
  const { project, runtime, canonical, resource, github } = input;
  const name = resource.externalReference;
  const register = (access: "READ" | "FULL") => `superadmin_repository_register({operationId:"<new>", projectId:"${project.id}", repository:"${name}", access:"${access}"})`;
  const has = (permission: Resource["permissions"][number]) => resource.permissions.includes(permission);

  const base: Requirement[] = [];
  if (project.environment === "PRODUCTION") base.push({ requirement: "a non-production project", remediation: "Production projects are NOT_SUPPORTED for autonomous work." });
  if (resource.status !== "ACTIVE") base.push({ requirement: "an ACTIVE registration", remediation: `Re-activate it: ${register("READ")}.` });
  if (resource.environment === "PRODUCTION") base.push({ requirement: "a non-production repository resource", remediation: "Production repositories are NOT_SUPPORTED." });
  if (!github.reachable)
    base.push({ requirement: "the repository reachable by the control-plane identity", remediation: "Check that the repository exists and that the control-plane GitHub identity can see it." });
  else if (github.reportedName && github.reportedName.toLowerCase() !== name.toLowerCase())
    base.push({ requirement: "the registered name to be the repository's current name", remediation: `GitHub now calls it ${github.reportedName}; register that name: superadmin_repository_register({operationId:"<new>", projectId:"${project.id}", repository:"${github.reportedName}", access:"READ"}).` });

  const read: Requirement[] = [...base];
  if (!has("READ")) read.push({ requirement: "READ on the registration", remediation: `${register("READ")}.` });
  if (!runtime.repositoryReads) read.push({ requirement: "repository reads in this deployment", remediation: "The control plane has no GitHub read credential configured; this is a deployment issue, not something the agent can fix." });

  const e2e: Requirement[] = [...read];
  if (project.autonomyMode !== "AUTONOMOUS_STAGING")
    e2e.push({ requirement: "autonomy AUTONOMOUS_STAGING (throwaway environments are PROVISION)", remediation: `superadmin_project_update({operationId:"<new>", projectId:"${project.id}", autonomyMode:"AUTONOMOUS_STAGING"}).` });
  if (!runtime.httpE2e) e2e.push({ requirement: "the HTTP E2E dispatcher in this deployment", remediation: "Deploy the control plane with the HTTP E2E workflow configured." });

  const write = (permissions: Resource["permissions"]): Requirement[] => {
    const missing = permissions.filter((permission) => !has(permission));
    return missing.length ? [{ requirement: `${missing.join(" and ")} on the registration (it has ${resource.permissions.join(", ") || "none"})`, remediation: `${register("FULL")} -- re-verified against GitHub, nothing is granted without it.` }] : [];
  };
  const githubPush: Requirement[] = github.reachable && github.push === false ? [{ requirement: "push access for the control-plane identity on GitHub", remediation: "Grant the control-plane GitHub identity write (or Admin) access to the repository." }] : [];
  const githubAdmin: Requirement[] = github.reachable && github.admin === false ? [{ requirement: "ADMIN for the control-plane identity on GitHub", remediation: "Grant the control-plane GitHub identity the Admin role on the repository." }] : [];

  const execute: Requirement[] = [...base, ...write(["READ", "WRITE"]), ...githubPush];
  if (project.autonomyMode === "OBSERVE") execute.push({ requirement: "an autonomy mode that allows execution", remediation: `superadmin_project_update({operationId:"<new>", projectId:"${project.id}", autonomyMode:"AUTONOMOUS_STAGING"}).` });
  if (resource.environment !== "SANDBOX") execute.push({ requirement: "a SANDBOX repository resource", remediation: "Only SANDBOX repositories receive autonomous change sets." });
  if (!runtime.execution) execute.push({ requirement: "the execution dispatcher in this deployment", remediation: "Deploy the control plane with the execution workflow configured." });
  if (canonical && canonical.resourceId !== resource.resourceId)
    execute.push({
      requirement: `this repository to be the project's development target (new work in this project executes against its canonical repository ${canonical.repository})`,
      remediation: `Either make ${name} the canonical development repository (superadmin_canonical_repository_plan, then superadmin_canonical_repository_promote) -- all new work in this project then goes there -- or keep developing in ${canonical.repository}. Verification (HTTP E2E, parity) of ${name} works either way.`,
    });

  const verdict = (missing: Requirement[]): CapabilityVerdict => ({ allowed: missing.length === 0, missing });
  return {
    resourceId: resource.resourceId,
    repository: name,
    permissions: resource.permissions,
    role: canonical?.resourceId === resource.resourceId ? "CANONICAL" : "REGISTERED",
    github,
    capabilities: {
      READ_AND_PLAN: verdict(read),
      HTTP_E2E: verdict(e2e),
      EXECUTE_CHANGES: verdict(execute),
      OPEN_PULL_REQUEST: verdict([...base, ...write(["WRITE"]), ...githubPush]),
      MERGE_PULL_REQUEST: verdict([...base, ...write(["WRITE", "ADMIN"]), ...githubAdmin]),
      RENAME: verdict([...base, ...write(["ADMIN"]), ...githubAdmin]),
    },
  };
}
