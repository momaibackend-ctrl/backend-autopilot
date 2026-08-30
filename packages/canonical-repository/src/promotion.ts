import type {
  Blocker,
  CanonicalDevelopmentRepository,
  CanonicalRepositoryPlan,
  Project,
  Resource,
} from '../../schemas/src/index.js';
import type { RepositoryDescription } from './ports.js';

/**
 * Everything a promotion decision depends on, already read. Keeping the decision a pure function
 * of these facts is what makes dry-run and the mutation's re-check provably the same rule: the
 * mutation calls this again with freshly read facts rather than re-implementing the checks.
 */
export interface PromotionFacts {
  project:Project;
  /** The candidate. Cross-project ownership is enforced before this point, by lookup failure. */
  resource:Resource;
  /** Absent when the repository could not be read at all; `providerError` then says why. */
  description?:RepositoryDescription;
  providerError?:string;
  headSha?:string;
  headReachable?:boolean;
  currentCanonical?:CanonicalDevelopmentRepository;
  /** Bindings still sitting in CANDIDATE for this project, which is an unfinished promotion. */
  conflictingCandidates:CanonicalDevelopmentRepository[];
  /** An export that was dispatched and never verified; canonical state must not move under it. */
  unfinishedExport?:{targetRepository:string;operationId:string;dispatchedAt:string};
  verification:CanonicalRepositoryPlan['verificationState'];
  now:string;
}

/** Permissions the control plane must already hold to keep developing in a canonical target. */
export const canonicalRequiredPermissions=['READ','WRITE'] as const;

export function buildCanonicalRepositoryPlan(facts:PromotionFacts):CanonicalRepositoryPlan{
  const blockers:Blocker[]=[];const warnings:string[]=[];const changes:string[]=[];
  const {project,resource,description,currentCanonical}=facts;

  if(project.status!=='ACTIVE')
    blockers.push({code:'PROJECT_NOT_ACTIVE',reason:`Project status is ${project.status}`,remediation:'Reactivate the project before binding a canonical development repository.'});
  if(project.environment==='PRODUCTION'||resource.environment==='PRODUCTION')
    blockers.push({code:'PRODUCTION_MUTATION_NOT_SUPPORTED',reason:'Production project or resource mutation is not supported by the platform safety policy',remediation:'Promote a non-production target; production writes remain NOT_SUPPORTED.'});
  if(resource.status!=='ACTIVE')
    blockers.push({code:'RESOURCE_INACTIVE',reason:`Candidate resource status is ${resource.status}`,remediation:'Re-enable the registered resource, or register the intended repository, before promoting it.'});
  if(resource.type!=='GITHUB_REPOSITORY'||resource.provider!=='github')
    blockers.push({code:'RESOURCE_TYPE_INVALID',reason:`Candidate resource is ${resource.provider}/${resource.type}, not a registered GitHub repository`,remediation:'Promote a registered GITHUB_REPOSITORY resource.'});
  const missingPermissions=canonicalRequiredPermissions.filter(permission=>!resource.permissions.includes(permission));
  if(missingPermissions.length)
    blockers.push({code:'PERMISSIONS_INSUFFICIENT',reason:`Registered resource is missing ${missingPermissions.join(', ')}`,remediation:`Grant ${missingPermissions.join(', ')} on the registered resource; a canonical development target must be both readable and writable.`});

  if(!description)
    blockers.push({code:'REPOSITORY_UNREACHABLE',reason:facts.providerError??'The repository could not be read through the configured provider',remediation:'Restore provider connectivity or credentials, then re-run the plan.'});
  else {
    if(description.externalReference.toLowerCase()!==resource.externalReference.toLowerCase())
      blockers.push({code:'REPOSITORY_IDENTITY_MISMATCH',reason:`Provider reports ${description.externalReference} where the resource is registered as ${resource.externalReference}`,remediation:'Re-register the resource against the repository it actually points at; a renamed or transferred repository must never be promoted through a stale registration.'});
    if(!description.defaultBranch)
      blockers.push({code:'DEFAULT_BRANCH_MISSING',reason:'The repository reports no default branch',remediation:'Create and publish a default branch before promoting the repository.'});
    if(!description.permissions.pull||!description.permissions.push)
      blockers.push({code:'PROVIDER_PERMISSIONS_INSUFFICIENT',reason:'The configured credential cannot both read and write this repository',remediation:'Grant the control-plane credential read and write access to the repository.'});
    if(description.isEmpty)
      blockers.push({code:'REPOSITORY_EMPTY',reason:'The repository has no commits, so there is no base to develop from',remediation:'Push an initial commit before promoting the repository.'});
    if(description.protectedBranches.length)
      warnings.push(`Protected branches present: ${description.protectedBranches.join(', ')}. Autopilot merges through pull requests, so protection rules must permit the control-plane credential to merge.`);
    if(description.visibility==='public')
      warnings.push('The candidate repository is public. Everything Autopilot commits to it is public as well.');
  }

  if(!facts.headSha)
    blockers.push({code:'HEAD_SHA_UNRESOLVED',reason:'The current default-branch head commit could not be resolved',remediation:'Confirm the default branch exists and has at least one commit, then re-run the plan.'});
  else if(facts.headReachable===false)
    blockers.push({code:'HEAD_SHA_UNREACHABLE',reason:`Commit ${facts.headSha} is not reachable in ${resource.externalReference}`,remediation:'Re-run the plan; the branch moved or the commit was rewritten while it was being read.'});

  if(facts.conflictingCandidates.length)
    blockers.push({code:'CONFLICTING_ACTIVE_PROMOTION',reason:`An unfinished candidate binding already exists (${facts.conflictingCandidates.map(value=>value.id).join(', ')})`,remediation:'Resolve or roll back the in-flight candidate binding before starting another promotion.'});
  if(facts.unfinishedExport)
    blockers.push({code:'REPOSITORY_TRANSFER_IN_PROGRESS',reason:`An export to ${facts.unfinishedExport.targetRepository} (operation ${facts.unfinishedExport.operationId}) has not been verified`,remediation:'Verify or abandon the in-flight repository export before changing which repository is canonical.'});
  if(currentCanonical?.resourceId===resource.resourceId)
    blockers.push({code:'ALREADY_CANONICAL',reason:`${resource.externalReference} is already the ACTIVE canonical development repository for this project`,remediation:'No promotion is needed. To re-point the project elsewhere, promote a different registered resource; to undo the current binding, use the canonical repository rollback.'});

  // Verification state is reported, never fabricated, and never used as a blocker on its own: an
  // unverified head is a fact an operator must weigh, not something this can decide for them.
  if(facts.verification.status==='UNKNOWN')
    warnings.push('No epic verification or CI evidence was found for the candidate head commit. The promotion records what is true, and does not assert the head is verified.');
  else if(!facts.verification.atCandidateHead)
    warnings.push(`Verification evidence exists but was produced at ${facts.verification.headSha ?? 'another commit'}, not at the candidate head. It is reported as stale, not as a pass.`);
  else if(facts.verification.status==='BLOCKED')
    warnings.push('The most recent verification evidence at the candidate head is BLOCKED.');

  if(currentCanonical){
    changes.push(`Binding ${currentCanonical.id} (${currentCanonical.repositoryIdentity.externalReference}, version ${currentCanonical.version}) would become SUPERSEDED and remain readable as history.`);
    changes.push(`The project's default development target would move from ${currentCanonical.repositoryIdentity.externalReference} to ${resource.externalReference}.`);
  }else{
    changes.push(`The project would gain its first ACTIVE canonical development repository: ${resource.externalReference}.`);
    changes.push('New tasks with no explicitly pinned repository would resolve this repository instead of requiring a caller-supplied resourceId.');
  }
  changes.push(`A new ACTIVE binding at version ${(currentCanonical?.version??0)+1} would record defaultBranch=${facts.description?.defaultBranch ?? 'UNKNOWN'} and canonicalSinceSha=${facts.headSha ?? 'UNKNOWN'}.`);
  changes.push('A CANONICAL_REPOSITORY_REPORT artifact and one mcp.canonical_repository_promote audit event would be written.');
  changes.push('No Git history, branch, tag, repository name, organization or secret would be changed by the promotion itself.');
  changes.push('Tasks that already pinned a repository through prior execution would keep executing against that pinned repository.');

  return {
    projectId:project.id,
    generatedAt:facts.now,
    ...(currentCanonical?{currentCanonical}:{}),
    candidateResourceId:resource.resourceId,
    candidateRepository:resource.externalReference,
    ...(description?.defaultBranch?{candidateDefaultBranch:description.defaultBranch}:{}),
    ...(facts.headSha?{candidateHeadSha:facts.headSha}:{}),
    permissions:resource.permissions,
    verificationState:facts.verification,
    changesThatWouldOccur:changes,
    warnings,
    blockers,
    ...(facts.headSha?{expectedHeadSha:facts.headSha}:{}),
    expectedCurrentCanonicalVersion:currentCanonical?.version??0,
    result:blockers.length?'BLOCKED':'READY_TO_PROMOTE',
  };
}

/**
 * The optimistic lock, applied to freshly read state at mutation time. A plan is a photograph;
 * between taking it and acting on it the branch can move or another promotion can land, and
 * silently adopting the new head would promote something nobody looked at.
 */
export function assertPromotionPlanIsCurrent(input:{
  plan:CanonicalRepositoryPlan;
  expectedHeadSha:string;
  expectedCurrentCanonicalVersion:number;
}):void{
  const actualVersion=input.plan.currentCanonical?.version??0;
  if(input.plan.candidateHeadSha!==input.expectedHeadSha||actualVersion!==input.expectedCurrentCanonicalVersion)
    throw new StalePromotionPlan({
      expectedHeadSha:input.expectedHeadSha,
      actualHeadSha:input.plan.candidateHeadSha,
      expectedCurrentCanonicalVersion:input.expectedCurrentCanonicalVersion,
      actualCurrentCanonicalVersion:actualVersion,
    });
}

export class StalePromotionPlan extends Error {
  readonly code='STALE_PROMOTION_PLAN';
  constructor(readonly details:Record<string,unknown>){
    super('The repository or the canonical binding changed after the plan was generated');
  }
}
