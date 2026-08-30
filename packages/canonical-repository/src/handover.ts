import { detectHardcodedSecret } from '../../secret-scanner/src/index.js';
import type { Blocker, DeveloperHandoverReport, HandoverCheck } from '../../schemas/src/index.js';

/**
 * The handover package a canonical development repository must carry so a backend developer with
 * no MCP client and no Superadmin token can pick the project up. Paths, not prose: this gate
 * judges presence and objective content only.
 */
export const requiredHandoverDocuments=[
  'README.md',
  '.env.example',
  'docs/handover/README.md',
  'docs/handover/architecture.md',
  'docs/handover/local-development.md',
  'docs/handover/infrastructure.md',
  'docs/handover/database.md',
  'docs/handover/contracts.md',
  'docs/handover/testing.md',
  'docs/handover/deployment.md',
  'docs/handover/troubleshooting.md',
  'docs/handover/change-guide.md',
] as const;

/** A document below this is a placeholder, not documentation. Deliberately a low, objective bar. */
const substantialDocumentBytes=200;
/** A machine-specific path in shared documentation is a path nobody else can follow. */
const absoluteDeveloperPath=/(?:[A-Za-z]:\\Users\\[^\s"'`]+|\/home\/[a-z][a-z0-9_-]*\/[^\s"'`]+|\/Users\/[A-Za-z][A-Za-z0-9_-]*\/[^\s"'`]+)/;
/**
 * Things whose presence in the LOCAL DEVELOPMENT instructions would mean a human cannot build the
 * project without the platform that wrote it. Matched only against local-development.md and the
 * root README quick start, so mentioning Autopilot elsewhere in the docs stays fine.
 */
const autopilotRuntimeRequirement=/(AUTOPILOT_SUPERADMIN_MCP_TOKEN|superadmin_[a-z_]+|\bMCP (?:server|client|token)\b)/i;

export interface HandoverFacts {
  projectId:string;
  repository?:string;
  defaultBranch?:string;
  headSha?:string;
  canonicalActive:boolean;
  /** Path -> content, or undefined for a path that does not exist at headSha. */
  documents:Record<string,string|undefined>;
  now:string;
}

export function buildDeveloperHandoverReport(facts:HandoverFacts):DeveloperHandoverReport{
  const checks:HandoverCheck[]=[];const blockers:Blocker[]=[];
  const pass=(check:string,detail:string)=>checks.push({check,requirement:'REQUIRED',status:'PASS',detail});
  const fail=(check:string,detail:string,remediation:string,code:string)=>{
    checks.push({check,requirement:'REQUIRED',status:'BLOCKED',detail,remediation});
    blockers.push({code,reason:detail,remediation});
  };
  const unverified=(check:string,detail:string,remediation:string)=>checks.push({check,requirement:'REQUIRED',status:'UNVERIFIED',detail,remediation});

  if(facts.canonicalActive)pass('CANONICAL_REPOSITORY_ACTIVE',`The project has an ACTIVE canonical development repository (${facts.repository ?? 'unknown'}).`);
  else fail('CANONICAL_REPOSITORY_ACTIVE','The project has no ACTIVE canonical development repository, so there is no single repository to hand over.','Promote a registered repository as the canonical development repository first.','CANONICAL_REPOSITORY_ABSENT');

  if(facts.headSha)pass('DOCUMENTATION_READ_AT_EXACT_COMMIT',`Documentation was read at ${facts.defaultBranch ?? 'the default branch'} head ${facts.headSha}, so this report is reproducible.`);
  else unverified('DOCUMENTATION_READ_AT_EXACT_COMMIT','The default-branch head commit could not be resolved, so this report is not pinned to a commit.','Restore provider access and re-run the report.');

  const present=(path:string)=>facts.documents[path];
  const missing=requiredHandoverDocuments.filter(path=>present(path)===undefined);
  if(missing.length)
    fail('HANDOVER_DOCUMENTS_PRESENT',`Missing required handover documents: ${missing.join(', ')}.`,'Add the missing files through an ordinary task and pull request; the handover package is repository content like any other.','HANDOVER_DOCUMENTS_MISSING');
  else pass('HANDOVER_DOCUMENTS_PRESENT',`All ${requiredHandoverDocuments.length} required handover documents exist at the verified commit.`);

  // The substance floor is about prose documents. `.env.example` is a variable list judged by its
  // own rules below, and a correct one is routinely a few short lines.
  const thin=requiredHandoverDocuments.filter(path=>{const value=present(path);return path!=='.env.example'&&value!==undefined&&value.trim().length<substantialDocumentBytes;});
  if(thin.length)
    fail('HANDOVER_DOCUMENTS_SUBSTANTIAL',`These documents exist but are shorter than ${substantialDocumentBytes} characters, which is a placeholder rather than documentation: ${thin.join(', ')}.`,'Fill in the placeholder documents with the project facts they promise.','HANDOVER_DOCUMENTS_PLACEHOLDER');
  else if(!missing.length)pass('HANDOVER_DOCUMENTS_SUBSTANTIAL','Every required document carries real content.');

  const envExample=present('.env.example');
  if(envExample===undefined)fail('ENV_EXAMPLE_PRESENT','.env.example is missing, so a new developer cannot see which configuration the project needs.','Add a .env.example listing every required variable name with placeholder values.','ENV_EXAMPLE_MISSING');
  else if(detectHardcodedSecret('.env.example',envExample))fail('ENV_EXAMPLE_HAS_NO_SECRETS','.env.example contains material the secret scanner classifies as a real credential.','Replace the value with a placeholder; .env.example documents names, never values.','ENV_EXAMPLE_CONTAINS_SECRET');
  else pass('ENV_EXAMPLE_HAS_NO_SECRETS','.env.example exists and carries no secret material.');

  const leaking=Object.entries(facts.documents).filter(([path,content])=>content!==undefined&&path!=='.env.example'&&detectHardcodedSecret(path,content)).map(([path])=>path);
  if(leaking.length)fail('NO_RAW_SECRETS_IN_DOCUMENTATION',`Secret material was detected in: ${leaking.join(', ')}.`,'Remove the credential from the documentation and rotate it; documentation names secrets, it does not carry them.','DOCUMENTATION_CONTAINS_SECRET');
  else pass('NO_RAW_SECRETS_IN_DOCUMENTATION','No secret material was detected in the handover documentation.');

  const machineSpecific=Object.entries(facts.documents).filter(([,content])=>content!==undefined&&absoluteDeveloperPath.test(content)).map(([path])=>path);
  if(machineSpecific.length)fail('NO_MACHINE_SPECIFIC_PATHS',`Absolute developer-machine paths appear in: ${machineSpecific.join(', ')}.`,'Replace absolute paths with repository-relative ones; a path from one laptop is not an instruction anyone else can follow.','DOCUMENTATION_CONTAINS_ABSOLUTE_PATH');
  else pass('NO_MACHINE_SPECIFIC_PATHS','No machine-specific absolute paths appear in the handover documentation.');

  const localDevelopment=present('docs/handover/local-development.md');
  const readme=present('README.md');
  const localDependsOnAutopilot=[localDevelopment,readme].filter((value):value is string=>value!==undefined).filter(value=>autopilotRuntimeRequirement.test(value));
  if(localDependsOnAutopilot.length)
    fail('LOCAL_DEVELOPMENT_NEEDS_NO_AUTOPILOT','The local development instructions reference Backend Autopilot MCP tooling or a Superadmin token as part of the ordinary developer flow.','Describe the standard clone/build/test/PR flow only. Autopilot is one contributor to this repository, never a prerequisite for building it.','LOCAL_DEVELOPMENT_REQUIRES_AUTOPILOT');
  else if(localDevelopment!==undefined)pass('LOCAL_DEVELOPMENT_NEEDS_NO_AUTOPILOT','Local development is documented as a standard Git/build/test flow with no MCP or Superadmin token requirement.');

  for(const [check,path,needle,detail] of [
    ['MIGRATION_INSTRUCTIONS','docs/handover/database.md',/migrat/i,'how to apply database migrations'],
    ['TEST_COMMANDS','docs/handover/testing.md',/```/,'runnable test commands in a fenced code block'],
    ['BUILD_AND_RUN_COMMANDS','docs/handover/local-development.md',/```/,'runnable build/run commands in a fenced code block'],
    ['CONTRACTS_DOCUMENTED','docs/handover/contracts.md',/contract/i,'the project API/data contracts'],
    ['OWNERSHIP_MAP','docs/handover/architecture.md',/owner|ownership/i,'module ownership and data ownership'],
    ['INFRASTRUCTURE_INVENTORY','docs/handover/infrastructure.md',/(REQUIRES_OPERATOR_SETUP|UNVERIFIED|VERIFIED|NOT_APPLICABLE)/,'an access/infrastructure inventory with explicit per-item status'],
    ['TROUBLESHOOTING','docs/handover/troubleshooting.md',/```|##/,'concrete troubleshooting entries'],
    ['CHANGE_GUIDE','docs/handover/change-guide.md',/\b1\./,'a numbered procedure for making a change'],
  ] as const){
    const content=present(path);
    if(content===undefined)continue; // already reported by HANDOVER_DOCUMENTS_PRESENT
    if(needle.test(content))pass(check,`${path} documents ${detail}.`);
    else fail(check,`${path} does not document ${detail}.`,`Document ${detail} in ${path}.`,`${check}_MISSING`);
  }

  return {
    projectId:facts.projectId,
    generatedAt:facts.now,
    ...(facts.repository?{repository:facts.repository}:{}),
    ...(facts.defaultBranch?{defaultBranch:facts.defaultBranch}:{}),
    ...(facts.headSha?{headSha:facts.headSha}:{}),
    canonicalRepositoryStatus:facts.canonicalActive?'ACTIVE':'ABSENT',
    checks,
    blockers,
    result:blockers.length?'BLOCKED':'PASS',
  };
}
