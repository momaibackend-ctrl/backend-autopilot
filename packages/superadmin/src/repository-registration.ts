// Verified registration of an existing GitHub repository, callable from the remote MCP (ADR 023).
//
// Every HTTP verification, contract discovery and environment plan needs a registered
// GITHUB_REPOSITORY resource, and `superadmin_resource_create` rightly refuses Git bindings: an
// unverified binding would let a caller point the autopilot at any repository. The verified flow
// existed only as local scripts on top of `gh`, which the Edge MCP cannot spawn -- so a remote agent
// could build nothing it was allowed to verify. This is the same verification over the GitHub REST
// API, with no check relaxed:
//
//   * the request names exactly one repository as owner/name;
//   * GitHub's own answer for that name must BE that name -- a renamed repository answers with its
//     new identity through a redirect, and the old name is refused with the current one named,
//     because the autopilot must know the real name and never lean on the redirect;
//   * public and private repositories are both accepted while the autopilot works in sandbox
//     environments only (operator decision, ADR 023 amendment); the visibility is returned and
//     audited, so a public registration is never silent;
//   * the credential the control plane actually holds must have ADMIN on it -- the same proof the
//     local flow accepts for an organization repository, and the gate every later write needs;
//   * a repository registered to another project is a conflict, never silently re-pointed.
//
// Pure apart from the provider port, so it is exercised without a network.
import { Conflict, NotFound, PolicyViolation } from "../../core/src/errors.js";
import type { GitRepositoryProvider } from "../../canonical-repository/src/ports.js";

export const repositoryIdentity = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export interface VerifiedRepository {
  /** owner/name exactly as GitHub reports it. */
  nameWithOwner: string;
  owner: string;
  repositoryId: string;
  defaultBranch: string;
  visibility: string;
}

export async function verifyRepositoryForRegistration(provider: GitRepositoryProvider, requested: string): Promise<VerifiedRepository> {
  if (!repositoryIdentity.test(requested)) throw new PolicyViolation("A repository must be named exactly as owner/name", { repository: requested });
  if (!(await provider.exists(requested))) throw new NotFound("The repository does not exist or the control-plane identity cannot see it", { repository: requested });
  const description = await provider.describe(requested);
  const reported = description.externalReference;
  // Same repository, different casing, is the same name; anything else means GitHub redirected.
  if (reported.toLowerCase() !== requested.toLowerCase())
    throw new PolicyViolation(`The repository is now named ${reported}; register it under its current name`, { requested, current: reported });
  if (!description.permissions.admin)
    throw new PolicyViolation("The control-plane identity must have ADMIN on the repository before it can be registered", {
      repository: reported,
      permissions: description.permissions,
      remediation: "Invite the control-plane GitHub identity to the repository with the Admin role, then register again.",
    });
  const [owner = ""] = reported.split("/");
  return { nameWithOwner: reported, owner, repositoryId: description.repositoryId, defaultBranch: description.defaultBranch, visibility: description.visibility };
}

export function conflictForForeignProject(repository: string, projectId: string) {
  return new Conflict("The repository is already registered to another project; one repository belongs to one project", { repository, projectId });
}
