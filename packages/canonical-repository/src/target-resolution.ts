import { PolicyViolation } from '../../core/src/errors.js';

export interface DevelopmentTargetResolution {
  resourceId:string;
  source:'PINNED_TASK_RESOURCE'|'ACTIVE_CANONICAL'|'EXPLICIT_RESOURCE';
  canonicalBindingId?:string;
}

/**
 * Which repository a piece of work executes against, resolved server-side.
 *
 * The rule is deliberately backward-compatible in both directions:
 *
 *   - A task that has already executed keeps its pinned repository forever. Moving a half-finished
 *     task onto a different repository mid-flight would strand its branch and its verified commit,
 *     so a pin always wins -- a promotion never retargets work that is already under way.
 *   - A project with no ACTIVE canonical binding behaves exactly as it did before canonical
 *     bindings existed: the caller names a registered resource and that is what is used. This is
 *     what keeps every historical project and workflow working after the migration.
 *   - Once a project HAS an ACTIVE canonical binding, that binding is the default target for new
 *     work, and a caller-supplied resourceId may only ever confirm it. Allowing an override here
 *     would make "the project's one source of further development" advisory, which is the whole
 *     property this exists to establish.
 */
export function resolveDevelopmentTarget(input:{
  requestedResourceId?:string;
  /** The repository this task has already executed against, from durable job/run evidence. */
  pinnedResourceId?:string;
  activeCanonical?:{id:string;resourceId:string;repository:string};
}):DevelopmentTargetResolution{
  if(input.pinnedResourceId){
    if(input.requestedResourceId&&input.requestedResourceId!==input.pinnedResourceId)
      throw new PolicyViolation('This task already executed against a different registered repository',{
        pinnedResourceId:input.pinnedResourceId,
        requestedResourceId:input.requestedResourceId,
        blockingReport:{
          code:'TASK_REPOSITORY_ALREADY_PINNED',
          reason:'A task keeps the repository it first executed against, so its branch and verified commit stay meaningful.',
          remediation:'Continue this task on its pinned repository, or create a new task for the other repository.',
        },
      });
    return {resourceId:input.pinnedResourceId,source:'PINNED_TASK_RESOURCE'};
  }
  if(!input.activeCanonical){
    if(!input.requestedResourceId)
      throw new PolicyViolation('No repository was named and this project has no canonical development repository',{
        blockingReport:{
          code:'NO_DEVELOPMENT_TARGET',
          reason:'Without an ACTIVE canonical binding a caller must name the registered repository to execute against.',
          remediation:'Name a registered GITHUB_REPOSITORY resourceId, or promote one as the canonical development repository.',
        },
      });
    return {resourceId:input.requestedResourceId,source:'EXPLICIT_RESOURCE'};
  }
  if(input.requestedResourceId&&input.requestedResourceId!==input.activeCanonical.resourceId)
    throw new PolicyViolation('This project develops only in its canonical development repository',{
      canonicalResourceId:input.activeCanonical.resourceId,
      canonicalRepository:input.activeCanonical.repository,
      requestedResourceId:input.requestedResourceId,
      blockingReport:{
        code:'CANONICAL_TARGET_REQUIRED',
        reason:`New work in this project executes against ${input.activeCanonical.repository}, the ACTIVE canonical development repository.`,
        remediation:'Omit resourceId to use the canonical target, or promote the intended repository as canonical first. A caller cannot redirect work past the canonical binding.',
      },
    });
  return {resourceId:input.activeCanonical.resourceId,source:'ACTIVE_CANONICAL',canonicalBindingId:input.activeCanonical.id};
}
