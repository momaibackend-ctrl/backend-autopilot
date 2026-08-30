import type {
  Blocker,
  Project,
  RepositoryExportPlan,
  RepositoryExportVerification,
  RepositoryRef,
  Resource,
  SecretConfigHandover,
  SecretHandoverEntry,
} from '../../schemas/src/index.js';
import type { RepositoryDescription } from './ports.js';

/** Git content that legitimately travels with the history, listed so an operator can see it. */
export const transferableConfiguration=[
  '.github/workflows/** (workflow DEFINITIONS only; their secret VALUES do not travel)',
  'Dockerfile / docker-compose.yml',
  'build configuration (Gradle, package manifests, lockfiles)',
  'scripts/**',
  'docs/**',
  'API contracts and schema definitions',
  'database migrations',
  '.env.example',
];

export interface ExportFacts {
  project:Project;
  source:Resource;
  target:Resource;
  sourceDescription?:RepositoryDescription;
  targetDescription?:RepositoryDescription;
  sourceHeadSha?:string;
  branches:RepositoryRef[];
  tags:RepositoryRef[];
  targetHeadSha?:string;
  providerError?:string;
  /** Registered secret reference NAMES across the project's resources. Never any value. */
  secretHandover:SecretConfigHandover;
  now:string;
}

export function buildRepositoryExportPlan(facts:ExportFacts):RepositoryExportPlan{
  const blockers:Blocker[]=[];const warnings:string[]=[];
  const {project,source,target}=facts;

  if(project.environment==='PRODUCTION'||source.environment==='PRODUCTION'||target.environment==='PRODUCTION')
    blockers.push({code:'PRODUCTION_MUTATION_NOT_SUPPORTED',reason:'Production project or resource mutation is not supported',remediation:'Export between non-production registered repositories only.'});
  if(source.resourceId===target.resourceId)
    blockers.push({code:'EXPORT_TARGET_IS_SOURCE',reason:'Source and target are the same registered resource',remediation:'Register the destination repository and name it as the export target.'});
  for(const [role,resource,required] of [['source',source,['READ']],['target',target,['WRITE','ADMIN']]] as const){
    if(resource.status!=='ACTIVE')
      blockers.push({code:`${role.toUpperCase()}_RESOURCE_INACTIVE`,reason:`The ${role} resource status is ${resource.status}`,remediation:`Re-enable the registered ${role} repository resource.`});
    if(resource.type!=='GITHUB_REPOSITORY'||resource.provider!=='github')
      blockers.push({code:`${role.toUpperCase()}_RESOURCE_TYPE_INVALID`,reason:`The ${role} resource is ${resource.provider}/${resource.type}`,remediation:`Name a registered GITHUB_REPOSITORY resource as the ${role}.`});
    const missing=required.filter(permission=>!resource.permissions.includes(permission));
    if(missing.length)
      blockers.push({code:`${role.toUpperCase()}_PERMISSIONS_INSUFFICIENT`,reason:`The ${role} resource is missing ${missing.join(', ')}`,remediation:`Grant ${missing.join(', ')} on the registered ${role} resource.`});
  }
  if(!facts.sourceDescription)
    blockers.push({code:'SOURCE_UNREACHABLE',reason:facts.providerError??'The source repository could not be read',remediation:'Restore provider access to the source repository and re-run the plan.'});
  if(!facts.targetDescription)
    blockers.push({code:'TARGET_UNREACHABLE',reason:facts.providerError??'The target repository could not be read',remediation:'Create and register the target repository, then re-run the plan.'});
  if(!facts.sourceHeadSha)
    blockers.push({code:'SOURCE_SHA_MISSING',reason:'The source default-branch head could not be resolved',remediation:'Confirm the source default branch exists and has commits.'});
  if(facts.sourceDescription?.isEmpty)
    blockers.push({code:'SOURCE_EMPTY',reason:'The source repository has no commits to transfer',remediation:'There is nothing to export from an empty repository.'});

  const targetIsEmpty=facts.targetDescription?.isEmpty??true;
  if(!targetIsEmpty){
    // A non-empty target is the one case where "transfer the history" and "do not rewrite history"
    // can genuinely conflict, and the safe answer is to refuse rather than to pick for the operator.
    blockers.push({code:'EXPORT_TARGET_CONFLICT',reason:`The target repository already contains commits (head ${facts.targetHeadSha ?? 'unknown'})`,remediation:'Export into an empty repository. Overwriting an existing history would require a force push, which this platform does not perform.'});
  }
  if(facts.targetDescription?.protectedBranches.length)
    warnings.push(`The target has protected branches (${facts.targetDescription.protectedBranches.join(', ')}), which can reject a mirror push.`);
  if(!facts.branches.length)
    warnings.push('No branches were enumerated on the source; the transfer would have nothing to verify against.');

  const requiredRefs=[
    ...facts.branches.map(value=>`refs/heads/${value.name}`),
    ...facts.tags.map(value=>`refs/tags/${value.name}`),
  ];

  return {
    projectId:project.id,
    generatedAt:facts.now,
    sourceResourceId:source.resourceId,
    sourceRepository:source.externalReference,
    ...(facts.sourceDescription?.defaultBranch?{sourceDefaultBranch:facts.sourceDescription.defaultBranch}:{}),
    ...(facts.sourceHeadSha?{sourceHeadSha:facts.sourceHeadSha}:{}),
    targetResourceId:target.resourceId,
    targetRepository:target.externalReference,
    ...(facts.targetDescription?.defaultBranch?{targetDefaultBranch:facts.targetDescription.defaultBranch}:{}),
    ...(facts.targetHeadSha?{targetHeadSha:facts.targetHeadSha}:{}),
    targetIsEmpty,
    branches:facts.branches,
    tags:facts.tags,
    requiredRefs,
    transferMechanism:'GIT_MIRROR_PUSH',
    requiredPermissions:{source:['READ'],target:['WRITE','ADMIN']},
    protectedBranches:facts.targetDescription?.protectedBranches??[],
    transferableConfiguration,
    nonTransferableConfiguration:[
      {item:'GitHub Actions secret values',classification:'ACTIONS_SECRET',status:'REQUIRES_OPERATOR_SETUP',detail:'Workflow files travel with Git; the secret values they read do not and are never copied.'},
      {item:'Branch protection rules',classification:'BRANCH_PROTECTION',status:'REQUIRES_OPERATOR_SETUP',detail:'Protection is repository configuration held by the host, not a Git ref.'},
      {item:'Workload identity federation / IAM bindings',classification:'IAM',status:'REQUIRES_OPERATOR_SETUP',detail:'Identity trust is granted per repository by the cloud provider and must be re-granted.'},
      {item:'Cloud provider accounts and projects',classification:'CLOUD_ACCOUNT',status:'REQUIRES_OPERATOR_SETUP',detail:'Accounts are not repository state and are outside the transfer boundary.'},
      {item:'Database credentials and connection strings',classification:'DATABASE_CREDENTIAL',status:'REQUIRES_OPERATOR_SETUP',detail:'Credential values are never read into the control plane for the purpose of copying them.'},
      {item:'Hosted environment configuration',classification:'HOSTED_ENVIRONMENT',status:'REQUIRES_OPERATOR_SETUP',detail:'Deployment targets are provisioned per environment and re-pointed by an operator.'},
    ],
    secretHandover:facts.secretHandover,
    verificationProcedure:[
      'Read the source and target repository identities back from the provider.',
      'Compare the source default-branch head against the target default-branch head.',
      'Confirm every required branch ref exists in the target at the same commit.',
      'Confirm every required tag exists in the target at the same commit.',
      'Confirm the source head commit is present and reachable in the target (history equivalence).',
      'Confirm no secret value artifact was produced by the transfer.',
      'Record REPOSITORY_EXPORT_VERIFICATION; anything unproven is BLOCKED, never partial success.',
    ],
    warnings,
    blockers,
    result:blockers.length?'BLOCKED':'READY_TO_EXPORT',
  };
}

export interface ExportVerificationFacts {
  projectId:string;
  sourceRepository:string;
  targetRepository:string;
  sourceDescription?:RepositoryDescription;
  targetDescription?:RepositoryDescription;
  sourceHeadSha?:string;
  targetHeadSha?:string;
  expectedBranches:RepositoryRef[];
  expectedTags:RepositoryRef[];
  targetBranches:RepositoryRef[];
  targetTags:RepositoryRef[];
  /** Whether the source head commit is actually present in the target. */
  sourceHeadPresentInTarget?:boolean;
  now:string;
}

export function verifyRepositoryExport(facts:ExportVerificationFacts):RepositoryExportVerification{
  const checks:RepositoryExportVerification['checks']=[];const blockers:Blocker[]=[];
  const add=(check:RepositoryExportVerification['checks'][number]['check'],status:'PASS'|'BLOCKED'|'NOT_APPLICABLE',detail:string)=>{checks.push({check,status,detail});};
  const block=(code:string,reason:string,remediation:string)=>{blockers.push({code,reason,remediation});};

  if(facts.sourceDescription?.externalReference.toLowerCase()===facts.sourceRepository.toLowerCase())
    add('SOURCE_IDENTITY','PASS',`Source resolves to ${facts.sourceRepository}`);
  else{add('SOURCE_IDENTITY','BLOCKED',`Source identity is ${facts.sourceDescription?.externalReference ?? 'unreadable'}, expected ${facts.sourceRepository}`);block('SOURCE_IDENTITY_MISMATCH','The source repository identity does not match the registered resource','Re-register the source resource against the repository it actually points at.');}

  if(facts.targetDescription?.externalReference.toLowerCase()===facts.targetRepository.toLowerCase())
    add('TARGET_IDENTITY','PASS',`Target resolves to ${facts.targetRepository}`);
  else{add('TARGET_IDENTITY','BLOCKED',`Target identity is ${facts.targetDescription?.externalReference ?? 'unreadable'}, expected ${facts.targetRepository}`);block('TARGET_IDENTITY_MISMATCH','The target repository identity does not match the registered resource','Re-register the target resource against the repository it actually points at.');}

  if(facts.sourceHeadSha)add('SOURCE_HEAD','PASS',`Source head is ${facts.sourceHeadSha}`);
  else{add('SOURCE_HEAD','BLOCKED','The source head commit could not be read');block('SOURCE_SHA_MISSING','The source head commit is unreadable, so nothing can be compared against it','Restore access to the source repository and re-run verification.');}

  if(!facts.targetHeadSha){add('TARGET_HEAD','BLOCKED','The target head commit could not be read');block('TARGET_SHA_MISSING','The target head commit is unreadable','Confirm the transfer ran and the target default branch exists.');}
  else if(facts.sourceHeadSha&&facts.targetHeadSha!==facts.sourceHeadSha){add('TARGET_HEAD','BLOCKED',`Target head is ${facts.targetHeadSha}, source head is ${facts.sourceHeadSha}`);block('TARGET_SHA_MISMATCH','The target default branch does not point at the exact source head commit','Re-run the transfer; a target that diverged cannot be reported as an equivalent copy.');}
  else add('TARGET_HEAD','PASS',`Target head equals the source head (${facts.targetHeadSha})`);

  const sourceDefault=facts.sourceDescription?.defaultBranch,targetDefault=facts.targetDescription?.defaultBranch;
  if(sourceDefault&&targetDefault&&sourceDefault===targetDefault)add('DEFAULT_BRANCH','PASS',`Both repositories default to ${sourceDefault}`);
  else{add('DEFAULT_BRANCH','BLOCKED',`Source default branch is ${sourceDefault ?? 'unknown'}, target default branch is ${targetDefault ?? 'unknown'}`);block('DEFAULT_BRANCH_MISMATCH','The target default branch differs from the source','Set the target default branch to match the source before accepting the transfer.');}

  const targetBranchByName=new Map(facts.targetBranches.map(value=>[value.name,value.sha]));
  const missingRefs=facts.expectedBranches.filter(value=>targetBranchByName.get(value.name)!==value.sha).map(value=>`refs/heads/${value.name}`);
  if(!facts.expectedBranches.length)add('REQUIRED_REFS','BLOCKED','No source branches were enumerated, so ref completeness cannot be established');
  else if(missingRefs.length){add('REQUIRED_REFS','BLOCKED',`Missing or divergent: ${missingRefs.join(', ')}`);block('REQUIRED_REFS_MISSING',`${missingRefs.length} required branch ref(s) are absent from or divergent in the target`,'Re-run the mirror transfer; an incomplete ref set is a failed export, not a partial success.');}
  else add('REQUIRED_REFS','PASS',`All ${facts.expectedBranches.length} source branch ref(s) are present at the same commits`);
  if(!facts.expectedBranches.length)block('REQUIRED_REFS_UNVERIFIABLE','The source branch set is unknown, so the transfer cannot be verified','Restore access to the source repository and re-run verification.');

  const targetTagByName=new Map(facts.targetTags.map(value=>[value.name,value.sha]));
  const missingTags=facts.expectedTags.filter(value=>targetTagByName.get(value.name)!==value.sha).map(value=>value.name);
  if(!facts.expectedTags.length)add('REQUIRED_TAGS','NOT_APPLICABLE','The source repository has no tags');
  else if(missingTags.length){add('REQUIRED_TAGS','BLOCKED',`Missing or divergent tags: ${missingTags.join(', ')}`);block('REQUIRED_TAGS_MISSING',`${missingTags.length} source tag(s) are absent from or divergent in the target`,'Re-run the transfer with --mirror so tags travel with the history.');}
  else add('REQUIRED_TAGS','PASS',`All ${facts.expectedTags.length} source tag(s) are present at the same commits`);

  if(facts.sourceHeadPresentInTarget===true)add('HISTORY_EQUIVALENCE','PASS','The source head commit exists and is reachable in the target');
  else if(facts.sourceHeadPresentInTarget===false){add('HISTORY_EQUIVALENCE','BLOCKED','The source head commit is not present in the target');block('HISTORY_MISMATCH','The claimed history is not present in the target repository','Re-run the transfer; a target missing the source history is a failed export.');}
  else{add('HISTORY_EQUIVALENCE','BLOCKED','History equivalence could not be checked');block('HISTORY_UNVERIFIABLE','History equivalence could not be established','Restore provider access so the target commit graph can be read. An unverifiable transfer is BLOCKED, never accepted.');}

  // Structural, not a scan result: the transfer moves Git refs only, and the handover artifact is
  // built from reference names. There is no code path in which a value could travel.
  add('NO_SECRET_TRANSFER','PASS','The transfer moves Git refs only; secret and configuration values are handed over by name through SECRET_CONFIG_HANDOVER');

  return {
    projectId:facts.projectId,
    generatedAt:facts.now,
    sourceRepository:facts.sourceRepository,
    targetRepository:facts.targetRepository,
    ...(facts.sourceHeadSha?{sourceHeadSha:facts.sourceHeadSha}:{}),
    ...(facts.targetHeadSha?{targetHeadSha:facts.targetHeadSha}:{}),
    ...(sourceDefault?{defaultBranch:sourceDefault}:{}),
    checks,
    missingRefs,
    missingTags,
    blockers,
    result:blockers.length?'BLOCKED':'PASS',
  };
}

/**
 * Builds the handover checklist from registered secret REFERENCE NAMES. There is no parameter
 * through which a value could enter, which is what makes "secrets are not exported" a property of
 * the type rather than a promise in a comment.
 */
export function buildSecretConfigHandover(input:{
  projectId:string;
  sourceRepository:string;
  targetRepository?:string;
  resources:Resource[];
  now:string;
}):SecretConfigHandover{
  const entries:SecretHandoverEntry[]=[];
  for(const resource of input.resources)
    for(const name of resource.secretRefs)
      entries.push({
        name,
        purpose:`Credential referenced by the registered ${resource.type} resource ${resource.externalReference}`,
        consumer:`${resource.provider}/${resource.type}`,
        environment:resource.environment,
        requirement:'REQUIRED',
        destinationSystem:input.targetRepository?`Secret store of ${input.targetRepository}`:'Destination secret store',
        owner:'operator',
        setupStatus:'REQUIRES_OPERATOR_SETUP',
      });
  return {
    projectId:input.projectId,
    generatedAt:input.now,
    sourceRepository:input.sourceRepository,
    ...(input.targetRepository?{targetRepository:input.targetRepository}:{}),
    entries:entries.sort((a,b)=>a.name.localeCompare(b.name)),
    valuesTransferred:false,
    notes:[
      'This checklist carries reference names only. No secret value is read, stored or transferred by any part of the export path.',
      'A value that cannot be moved safely is a normal handover outcome: the operator re-creates it in the destination system.',
      'Setup status stays REQUIRES_OPERATOR_SETUP until an operator confirms the destination holds a working value; it is never marked VERIFIED on the strength of the export alone.',
    ],
  };
}
