import { NotFound, PolicyViolation } from './errors.js';
import type { StateStore } from './ports.js';
import type { Resource } from '../../schemas/src/index.js';

/**
 * The single, shared invariant behind "execution must go only into a repository registered for
 * this project": the resource must exist, belong to the given project, and be an ACTIVE
 * GITHUB_REPOSITORY resource. Every entry point that resolves a caller-supplied resourceId into a
 * GitHub repository (remote execution, PR open/merge, repository read) should route through this
 * instead of re-deriving the same checks inline -- a duplicated inline copy is exactly what let a
 * project keep executing against a stale, superseded repository: one call site (the GitHub Actions
 * execution runner) never checked project ownership at all. Callers layer their own additional
 * requirements (environment, specific permissions) on top of the returned resource.
 */
export async function requireProjectGithubRepository(
  store: StateStore,
  projectId: string,
  resourceId: string,
): Promise<Resource> {
  const resource = await store.getResource(resourceId);
  if (!resource || resource.projectId !== projectId)
    throw new NotFound('Resource not found', { projectId, resourceId });
  if (resource.type !== 'GITHUB_REPOSITORY' || resource.provider !== 'github')
    throw new PolicyViolation('A registered GitHub repository resource is required', {
      resourceId,
    });
  if (resource.status !== 'ACTIVE')
    throw new PolicyViolation('Resource is disabled', { resourceId });
  return resource;
}
