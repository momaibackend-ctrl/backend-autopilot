import type {
  Blocker,
  CanonicalDevelopmentRepository,
  Project,
  RepositoryRenamePlan,
  Resource,
} from '../../schemas/src/index.js';
import type { RepositoryDescription } from './ports.js';

export interface RenameFacts {
  project:Project;
  resource:Resource;
  newName:string;
  description?:RepositoryDescription;
  providerError?:string;
  headSha?:string;
  /** True when something already occupies the target name. */
  targetNameTaken:boolean;
  /** An ACTIVE canonical binding pointing at this resource, if there is one. */
  activeCanonical?:CanonicalDevelopmentRepository;
  now:string;
}

export function buildRepositoryRenamePlan(facts:RenameFacts):RepositoryRenamePlan{
  const blockers:Blocker[]=[];const warnings:string[]=[];const changes:string[]=[];
  const {project,resource,description}=facts;
  const owner=resource.externalReference.split('/')[0]??'';
  const targetRepository=`${owner}/${facts.newName}`;

  if(project.status!=='ACTIVE')
    blockers.push({code:'PROJECT_NOT_ACTIVE',reason:`Project status is ${project.status}`,remediation:'Reactivate the project before renaming its registered repository.'});
  if(project.environment==='PRODUCTION'||resource.environment==='PRODUCTION')
    blockers.push({code:'PRODUCTION_MUTATION_NOT_SUPPORTED',reason:'Production project or resource mutation is not supported',remediation:'Production writes remain NOT_SUPPORTED.'});
  if(resource.type!=='GITHUB_REPOSITORY'||resource.provider!=='github')
    blockers.push({code:'RESOURCE_TYPE_INVALID',reason:`Resource is ${resource.provider}/${resource.type}, not a registered GitHub repository`,remediation:'Name a registered GITHUB_REPOSITORY resource.'});
  if(resource.status!=='ACTIVE')
    blockers.push({code:'RESOURCE_INACTIVE',reason:`Resource status is ${resource.status}`,remediation:'Re-enable the registered resource before renaming the repository it points at.'});
  if(!resource.permissions.includes('ADMIN'))
    blockers.push({code:'PERMISSIONS_INSUFFICIENT',reason:'Renaming a repository requires ADMIN on the registered resource',remediation:'Grant ADMIN on the registered resource, or rename the repository through the provider by hand and then re-register it.'});
  if(resource.externalReference===targetRepository)
    blockers.push({code:'RENAME_IS_A_NO_OP',reason:`The repository is already named ${targetRepository}`,remediation:'No rename is needed.'});

  if(!description)
    blockers.push({code:'REPOSITORY_UNREACHABLE',reason:facts.providerError??'The repository could not be read through the configured provider',remediation:'Restore provider connectivity or credentials, then re-run the plan.'});
  else {
    if(description.externalReference.toLowerCase()!==resource.externalReference.toLowerCase())
      blockers.push({code:'REPOSITORY_IDENTITY_MISMATCH',reason:`Provider reports ${description.externalReference} where the resource is registered as ${resource.externalReference}`,remediation:'Reconcile the registration with the repository it actually points at before renaming it.'});
    if(!description.permissions.admin)
      blockers.push({code:'PROVIDER_PERMISSIONS_INSUFFICIENT',reason:'The configured credential cannot administer this repository, so it cannot rename it',remediation:'Grant the control-plane credential admin access to the repository.'});
  }
  if(!facts.headSha)
    blockers.push({code:'HEAD_SHA_UNRESOLVED',reason:'The current default-branch head commit could not be resolved',remediation:'Confirm the default branch exists and has commits, then re-run the plan.'});
  if(facts.targetNameTaken)
    blockers.push({code:'TARGET_NAME_TAKEN',reason:`${targetRepository} already exists`,remediation:'Choose a name nothing else occupies. A rename never overwrites another repository.'});

  // A canonical binding records the identity it was made under. Renaming underneath it would make
  // an immutable, append-only record describe a repository that no longer answers to that name --
  // so the supported order is rename first, promote second.
  if(facts.activeCanonical?.resourceId===resource.resourceId)
    blockers.push({
      code:'CANONICAL_BINDING_WOULD_GO_STALE',
      reason:`This repository is the ACTIVE canonical development repository (binding ${facts.activeCanonical.id}, recorded as ${facts.activeCanonical.repositoryIdentity.externalReference})`,
      remediation:'Rename before promoting, or roll the canonical binding back first and promote again afterwards. A canonical binding is append-only evidence and must not be edited underneath.',
    });

  if(description?.protectedBranches.length)
    warnings.push(`Protected branches (${description.protectedBranches.join(', ')}) are configuration on the repository object and survive the rename unchanged.`);
  warnings.push('Evidence already recorded under the old name keeps naming it, because evidence is immutable. Re-run verification against the new identity rather than reinterpreting old records.');
  warnings.push('The provider redirects the old name, but Autopilot does not rely on that: the registration is re-pointed so resources, evidence and new tasks all resolve one name.');

  changes.push(`The repository would be renamed ${resource.externalReference} -> ${targetRepository}, keeping its id, full Git history, branches, tags, pull requests and issues.`);
  changes.push(`The registered resource ${resource.resourceId} would have its externalReference updated to ${targetRepository}. No second resource is created.`);
  if(project.repository?.resourceId===resource.resourceId)
    changes.push(`The project's repository identity would be updated from ${project.repository.owner}/${project.repository.name} to ${targetRepository}.`);
  changes.push(`The default branch would remain ${description?.defaultBranch ?? 'UNKNOWN'} at exactly ${facts.headSha ?? 'UNKNOWN'} -- a rename never moves a commit.`);
  changes.push('A REPOSITORY_RENAME_REPORT artifact and one audit event would be written. No Git history is rewritten and no secret is moved.');

  return {
    projectId:project.id,
    generatedAt:facts.now,
    resourceId:resource.resourceId,
    currentRepository:resource.externalReference,
    targetRepository,
    ...(description?.repositoryId?{repositoryId:description.repositoryId}:{}),
    ...(description?.defaultBranch?{defaultBranch:description.defaultBranch}:{}),
    ...(facts.headSha?{headSha:facts.headSha}:{}),
    targetNameTaken:facts.targetNameTaken,
    changesThatWouldOccur:changes,
    warnings,
    blockers,
    ...(facts.headSha?{expectedHeadSha:facts.headSha}:{}),
    result:blockers.length?'BLOCKED':'READY_TO_RENAME',
  };
}

/**
 * The proof that a rename was a rename.
 *
 * The GitHub rebinding guard exists because re-pointing a registration is how a project silently
 * starts executing against a repository nobody chose. This is what distinguishes the safe case:
 * the provider's stable object id, the default branch and the head commit must all be unchanged,
 * and the new full name must be exactly the one that was planned. If any of that fails the
 * registration is NOT updated -- the caller is told the provider was renamed while the control
 * plane was not, which is a state a human must look at rather than one to paper over.
 */
export function assertRenamePreservedIdentity(input:{
  before:{repositoryId:string;defaultBranch:string;headSha:string};
  after:{repositoryId:string;defaultBranch:string;headSha:string;externalReference:string};
  expectedReference:string;
}):void{
  const failures:string[]=[];
  if(input.after.repositoryId!==input.before.repositoryId)
    failures.push(`repository id changed (${input.before.repositoryId} -> ${input.after.repositoryId})`);
  if(input.after.headSha!==input.before.headSha)
    failures.push(`head commit changed (${input.before.headSha} -> ${input.after.headSha})`);
  if(input.after.defaultBranch!==input.before.defaultBranch)
    failures.push(`default branch changed (${input.before.defaultBranch} -> ${input.after.defaultBranch})`);
  if(input.after.externalReference.toLowerCase()!==input.expectedReference.toLowerCase())
    failures.push(`repository is named ${input.after.externalReference}, expected ${input.expectedReference}`);
  if(failures.length)throw new RenameIdentityMismatch(failures);
}

export class RenameIdentityMismatch extends Error {
  readonly code='RENAME_IDENTITY_MISMATCH';
  constructor(readonly failures:string[]){
    super(`The repository after the rename is not provably the same repository: ${failures.join('; ')}`);
  }
}
