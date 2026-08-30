import { ArtifactStore } from '../../artifact-store/src/index.js';
import { AuditLog } from '../../audit/src/index.js';
import { Conflict, InvalidState, NotFound, PolicyViolation, UnsupportedOperation } from '../../core/src/errors.js';
import type { Clock, IdGenerator, StateStore } from '../../core/src/ports.js';
import { systemClock, uuidGenerator } from '../../core/src/ports.js';
import { requireProjectGithubRepository } from '../../core/src/repository-guard.js';
import {
  canonicalRepositoryPlanInputSchema,
  repositoryRenameInputSchema,
  repositoryRenamePlanInputSchema,
  canonicalRepositoryPromoteInputSchema,
  canonicalRepositoryRollbackInputSchema,
  repositoryExportInputSchema,
  repositoryExportPlanInputSchema,
  type Artifact,
  type CanonicalDevelopmentRepository,
  type CanonicalRepositoryPlan,
  type DeveloperHandoverReport,
  type Project,
  type RepositoryExportPlan,
  type RepositoryExportVerification,
  type RepositoryRenamePlan,
  type Resource,
} from '../../schemas/src/index.js';
import {
  buildRepositoryExportPlan,
  buildSecretConfigHandover,
  verifyRepositoryExport,
} from './export.js';
import { buildDeveloperHandoverReport, requiredHandoverDocuments } from './handover.js';
import { assertRenamePreservedIdentity, buildRepositoryRenamePlan, RenameIdentityMismatch } from './rename.js';
import type { GitRepositoryProvider, RepositoryDescription, RepositoryExportDispatcher } from './ports.js';
import {
  assertPromotionPlanIsCurrent,
  buildCanonicalRepositoryPlan,
  StalePromotionPlan,
  type PromotionFacts,
} from './promotion.js';

export interface CanonicalRepositoryDependencies {
  store:StateStore;
  clock?:Clock;
  ids?:IdGenerator;
  artifacts?:ArtifactStore;
  /** Absent in runtimes with no Git host credential; every provider-dependent call then blocks. */
  repositories?:GitRepositoryProvider;
  exportDispatcher?:RepositoryExportDispatcher;
  exportWorkflow?:string;
}

/**
 * The single implementation of canonical-repository and repository-export semantics. MCP tools,
 * the Control API and the documented manual operator path all call these methods; none of them
 * re-derives a rule, so there is no surface on which the gates can disagree.
 *
 * Idempotency, replay protection and the mcp.<tool> audit event are supplied by the caller's
 * mutation wrapper (SuperadminService.mutate), which is why nothing here writes an admin
 * operation record of its own.
 */
export class CanonicalRepositoryService {
  private readonly clock:Clock;
  private readonly ids:IdGenerator;
  private readonly artifacts:ArtifactStore;
  private readonly audit:AuditLog;
  constructor(private readonly deps:CanonicalRepositoryDependencies){
    this.clock=deps.clock??systemClock;
    this.ids=deps.ids??uuidGenerator;
    this.artifacts=deps.artifacts??new ArtifactStore(deps.store,this.ids,this.clock);
    this.audit=new AuditLog(deps.store,this.ids,this.clock);
  }

  // ---------------------------------------------------------------- read model

  async get(projectId:string){
    const project=await this.requireProject(projectId);
    const history=await this.deps.store.listCanonicalRepositories(project.id);
    const active=history.find(value=>value.status==='ACTIVE');
    return {
      projectId:project.id,
      ...(active?{active}:{}),
      /** Present for every project, including those that never promoted anything. */
      hasCanonicalRepository:Boolean(active),
      history,
      generatedAt:this.clock.now(),
    };
  }

  /** Read-only. Performs no writes, dispatches nothing, and never mutates canonical state. */
  async plan(input:unknown):Promise<CanonicalRepositoryPlan>{
    const data=canonicalRepositoryPlanInputSchema.parse(input);
    return this.buildPlan(data.projectId,data.resourceId);
  }

  // ---------------------------------------------------------------- promotion

  async promote(input:unknown,actor:string){
    const data=canonicalRepositoryPromoteInputSchema.parse(input);
    const project=await this.requireProject(data.projectId);
    // Re-derived from freshly read state, not trusted from the caller's earlier dry run.
    const plan=await this.buildPlan(project.id,data.resourceId);
    // Blockers are reported before staleness on purpose. A plan blocked because the head could not
    // be resolved has no candidateHeadSha at all, and comparing that against the pinned value would
    // report STALE_PROMOTION_PLAN for a repository that is simply unreachable -- refusing for the
    // wrong stated reason. Both orderings fail closed; only this one names the real problem.
    if(plan.result==='BLOCKED')
      throw new PolicyViolation('Canonical repository promotion is blocked',{blockers:plan.blockers,plan});
    try{
      assertPromotionPlanIsCurrent({plan,expectedHeadSha:data.expectedHeadSha,expectedCurrentCanonicalVersion:data.expectedCurrentCanonicalVersion});
    }catch(error){
      if(error instanceof StalePromotionPlan)
        throw new Conflict(error.message,{...error.details,blockingReport:{code:'STALE_PROMOTION_PLAN',reason:error.message,remediation:'Run the canonical repository plan again and promote with the values it returns. A moved head is never adopted silently.'}});
      throw error;
    }

    const resource=await this.requireProjectRepository(project.id,data.resourceId);
    const now=this.clock.now();
    const previous=plan.currentCanonical;
    const record:CanonicalDevelopmentRepository={
      id:this.ids.next(),
      projectId:project.id,
      resourceId:resource.resourceId,
      repositoryIdentity:identityOf(resource),
      defaultBranch:plan.candidateDefaultBranch!,
      canonicalSinceSha:plan.candidateHeadSha!,
      canonicalSinceAt:now,
      status:'ACTIVE',
      version:(previous?.version??0)+1,
      createdBy:actor,
      operationId:data.operationId,
      reason:data.reason,
      ...(previous?{supersedes:previous.id}:{}),
      createdAt:now,
      updatedAt:now,
    };
    const written=await this.deps.store.promoteCanonicalRepository({
      projectId:project.id,
      record,
      ...(previous?{expectedCurrent:{id:previous.id,version:previous.version}}:{}),
      displacedStatus:'SUPERSEDED',
      displacedAt:now,
    });
    // "Promotion succeeded" only ever means "durable state was written AND read back".
    const confirmed=await this.deps.store.getActiveCanonicalRepository(project.id);
    if(confirmed?.id!==written.active.id)
      throw new InvalidState('The canonical binding was not durably readable after promotion',{expected:written.active.id,actual:confirmed?.id});

    const report=await this.writeCanonicalReport(project.id,'PROMOTE',{
      operationId:data.operationId,
      actor,
      reason:data.reason,
      plan,
      previousCanonical:previous??null,
      newCanonical:confirmed,
    });
    await this.recordAudit(project.id,'canonical_repository.promote',actor,data.operationId,{
      sourceResourceId:previous?.resourceId??null,
      targetResourceId:resource.resourceId,
      sourceRepository:previous?.repositoryIdentity.externalReference??null,
      targetRepository:resource.externalReference,
      sourceSha:previous?.canonicalSinceSha??null,
      targetSha:confirmed.canonicalSinceSha,
      defaultBranch:confirmed.defaultBranch,
      previousCanonical:previous?.id??null,
      newCanonical:confirmed.id,
      result:'PROMOTED',
    },'Canonical development repository promoted for this project');
    return {canonical:confirmed,...(written.displaced?{superseded:written.displaced}:{}),plan,reportArtifactId:report.id};
  }

  /**
   * Restores the previous canonical BINDING. It is metadata-only by construction: there is no code
   * path here that can touch a repository, a branch, a tag or a secret.
   */
  async rollback(input:unknown,actor:string){
    const data=canonicalRepositoryRollbackInputSchema.parse(input);
    const project=await this.requireProject(data.projectId);
    const history=await this.deps.store.listCanonicalRepositories(project.id);
    const current=history.find(value=>value.status==='ACTIVE');
    if(!current)throw new NotFound('This project has no ACTIVE canonical development repository to roll back',{projectId:project.id});
    if(current.version!==data.expectedCurrentCanonicalVersion)
      throw new Conflict('The canonical binding changed since it was read',{expected:data.expectedCurrentCanonicalVersion,actual:current.version,blockingReport:{code:'STALE_ROLLBACK_TARGET',reason:'The ACTIVE binding is no longer the one this rollback names.',remediation:'Read the canonical repository state again and repeat the rollback with the current version.'}});
    const previous=current.supersedes?history.find(value=>value.id===current.supersedes):undefined;
    if(!previous)throw new InvalidState('The current canonical binding is the first one, so there is nothing to restore',{blockingReport:{code:'NO_PREVIOUS_CANONICAL_BINDING',reason:'A rollback restores an earlier binding from history; this project has none.',remediation:'Promote the intended repository explicitly instead of rolling back.'}});

    // The binding being restored must still be a usable target -- an audit trail is not a licence
    // to point the project at a resource that was since disabled or deleted.
    const resource=await this.deps.store.getResource(previous.resourceId);
    if(!resource||resource.projectId!==project.id)
      throw new NotFound('The previous canonical resource no longer exists for this project',{resourceId:previous.resourceId});
    if(resource.status!=='ACTIVE')
      throw new PolicyViolation('The previous canonical resource is no longer ACTIVE',{resourceId:resource.resourceId,status:resource.status,blockingReport:{code:'ROLLBACK_TARGET_INACTIVE',reason:'The repository this rollback would restore is disabled.',remediation:'Re-enable the registered resource, or promote a different repository explicitly.'}});
    if(this.deps.repositories){
      const description=await this.describe(resource.externalReference);
      if(!description)
        throw new PolicyViolation('The previous canonical repository is not reachable',{repository:resource.externalReference,blockingReport:{code:'ROLLBACK_TARGET_UNREACHABLE',reason:'The repository the rollback would restore could not be read through the provider.',remediation:'Restore access to the repository before restoring it as the canonical development target.'}});
    }

    const now=this.clock.now();
    const record:CanonicalDevelopmentRepository={
      ...previous,
      id:this.ids.next(),
      status:'ACTIVE',
      version:current.version+1,
      createdBy:actor,
      operationId:data.operationId,
      reason:data.reason,
      supersedes:current.id,
      canonicalSinceAt:now,
      createdAt:now,
      updatedAt:now,
    };
    delete record.supersededBy;delete record.supersededAt;
    const written=await this.deps.store.promoteCanonicalRepository({
      projectId:project.id,
      record,
      expectedCurrent:{id:current.id,version:current.version},
      displacedStatus:'ROLLED_BACK',
      displacedAt:now,
    });
    const confirmed=await this.deps.store.getActiveCanonicalRepository(project.id);
    if(confirmed?.id!==written.active.id)
      throw new InvalidState('The restored canonical binding was not durably readable',{expected:written.active.id,actual:confirmed?.id});
    const report=await this.writeCanonicalReport(project.id,'ROLLBACK',{
      operationId:data.operationId,
      actor,
      reason:data.reason,
      rolledBack:current,
      restoredFrom:previous.id,
      newCanonical:confirmed,
      gitHistoryTouched:false,
    });
    await this.recordAudit(project.id,'canonical_repository.rollback',actor,data.operationId,{
      sourceResourceId:current.resourceId,
      targetResourceId:confirmed.resourceId,
      sourceRepository:current.repositoryIdentity.externalReference,
      targetRepository:confirmed.repositoryIdentity.externalReference,
      sourceSha:current.canonicalSinceSha,
      targetSha:confirmed.canonicalSinceSha,
      defaultBranch:confirmed.defaultBranch,
      previousCanonical:current.id,
      newCanonical:confirmed.id,
      result:'ROLLED_BACK',
    },'Canonical development repository binding rolled back; no Git history was changed');
    return {canonical:confirmed,rolledBack:written.displaced,reportArtifactId:report.id};
  }

  // -------------------------------------------------------------------- rename

  /** Read-only. Reports what a rename would do and everything that would stop it. */
  async renamePlan(input:unknown):Promise<RepositoryRenamePlan>{
    const data=repositoryRenamePlanInputSchema.parse(input);
    return this.buildRenamePlan(data.projectId,data.resourceId,data.newName);
  }

  /**
   * Renames the repository a project is registered against, and re-points the registration to
   * follow it.
   *
   * Changing a GITHUB_REPOSITORY binding is otherwise refused outright, because re-pointing a
   * registration is how a project silently starts executing against a repository nobody chose.
   * This is the one provably-safe case, and it earns the exception by checking it: the provider's
   * stable repository id, the default branch and the exact head commit must be identical before
   * and after. If they are not, the registration is left alone and the mismatch is reported.
   */
  async renameRepository(input:unknown,actor:string){
    const data=repositoryRenameInputSchema.parse(input);
    const project=await this.requireProject(data.projectId);
    const resource=await this.requireProjectResource(project.id,data.resourceId);
    if(resource.externalReference!==data.expectedCurrentReference)
      throw new PolicyViolation('Current repository reference confirmation mismatch',{expected:data.expectedCurrentReference,actual:resource.externalReference});

    const plan=await this.buildRenamePlan(project.id,data.resourceId,data.newName);
    if(plan.result==='BLOCKED')
      throw new PolicyViolation('Repository rename is blocked',{blockers:plan.blockers,plan});
    if(plan.headSha!==data.expectedHeadSha)
      throw new Conflict('The repository head moved after the rename plan was generated',{expected:data.expectedHeadSha,actual:plan.headSha,blockingReport:{code:'STALE_RENAME_PLAN',reason:'The default branch advanced between planning and rename.',remediation:'Re-run the rename plan and rename with the head it reports.'}});
    if(!this.deps.repositories)
      throw new UnsupportedOperation('No Git repository provider is configured in this runtime');

    const before={repositoryId:plan.repositoryId!,defaultBranch:plan.defaultBranch!,headSha:plan.headSha!};
    const renamed=await this.deps.repositories.rename(resource.externalReference,data.newName);
    const headAfter=await this.deps.repositories.resolveRef(renamed.externalReference,renamed.defaultBranch);
    try{
      assertRenamePreservedIdentity({
        before,
        after:{repositoryId:renamed.repositoryId,defaultBranch:renamed.defaultBranch,headSha:headAfter??'',externalReference:renamed.externalReference},
        expectedReference:plan.targetRepository,
      });
    }catch(error){
      if(error instanceof RenameIdentityMismatch)
        // Deliberately does NOT update the registration. The provider and the control plane now
        // disagree, and a human has to see that rather than have it quietly reconciled.
        throw new InvalidState('The repository was renamed but is not provably the same repository, so the registration was left unchanged',{
          failures:error.failures,
          previousRepository:resource.externalReference,
          observedRepository:renamed.externalReference,
          blockingReport:{code:'RENAME_IDENTITY_MISMATCH',reason:error.message,remediation:'Inspect the repository at the provider. Do not update the registration until the identity, default branch and head commit are confirmed by hand.'},
        });
      throw error;
    }

    const updatedResource=await this.deps.store.updateResource({...resource,externalReference:renamed.externalReference});
    // The project's own repository identity is the other place the old name lives. Left behind, it
    // is exactly the stale binding this platform has been bitten by before.
    let projectRepositoryUpdated=false;
    if(project.repository?.resourceId===resource.resourceId){
      const [owner='',name='']=renamed.externalReference.split('/');
      await this.deps.store.updateProject({...project,repository:{...project.repository,owner,name,defaultBranch:renamed.defaultBranch},updatedAt:this.clock.now()});
      projectRepositoryUpdated=true;
    }

    const report=await this.artifacts.write(project.id,'REPOSITORY_RENAME_REPORT',{
      projectId:project.id,
      generatedAt:this.clock.now(),
      operationId:data.operationId,
      actor,
      reason:data.reason,
      resourceId:resource.resourceId,
      previousRepository:resource.externalReference,
      newRepository:renamed.externalReference,
      repositoryId:renamed.repositoryId,
      defaultBranch:renamed.defaultBranch,
      headSha:headAfter!,
      gitHistoryTouched:false,
      registrationUpdated:true,
      projectRepositoryUpdated,
    });
    await this.recordAudit(project.id,'repository.rename',actor,data.operationId,{
      sourceResourceId:resource.resourceId,
      targetResourceId:resource.resourceId,
      sourceRepository:resource.externalReference,
      targetRepository:renamed.externalReference,
      repositoryId:renamed.repositoryId,
      sourceSha:before.headSha,
      targetSha:headAfter??null,
      defaultBranch:renamed.defaultBranch,
      result:'RENAMED',
    },'Registered repository renamed in place; identity, history and head commit verified unchanged');
    return {status:'RENAMED',resource:updatedResource,previousRepository:resource.externalReference,newRepository:renamed.externalReference,repositoryId:renamed.repositoryId,headSha:headAfter,defaultBranch:renamed.defaultBranch,projectRepositoryUpdated,reportArtifactId:report.id,plan};
  }

  private async buildRenamePlan(projectId:string,resourceId:string,newName:string):Promise<RepositoryRenamePlan>{
    const project=await this.requireProject(projectId);
    const resource=await this.requireProjectResource(project.id,resourceId);
    const owner=resource.externalReference.split('/')[0]??'';
    const [description,activeCanonical]=await Promise.all([
      this.describe(resource.externalReference),
      this.deps.store.getActiveCanonicalRepository(project.id),
    ]);
    const headSha=description?.defaultBranch?await this.deps.repositories?.resolveRef(resource.externalReference,description.defaultBranch):undefined;
    const targetNameTaken=`${owner}/${newName}`===resource.externalReference
      ? false
      : (await this.deps.repositories?.exists(`${owner}/${newName}`))??false;
    return buildRepositoryRenamePlan({
      project,
      resource,
      newName,
      ...(description?{description}:{}),
      ...(this.deps.repositories?{}:{providerError:'No Git repository provider is configured in this runtime'}),
      ...(headSha?{headSha}:{}),
      targetNameTaken,
      ...(activeCanonical?{activeCanonical}:{}),
      now:this.clock.now(),
    });
  }

  // ------------------------------------------------------------------- export

  async exportPlan(input:unknown):Promise<RepositoryExportPlan>{
    const data=repositoryExportPlanInputSchema.parse(input);
    const project=await this.requireProject(data.projectId);
    const [source,target,resources]=await Promise.all([
      this.requireProjectResource(project.id,data.sourceResourceId),
      this.requireProjectResource(project.id,data.targetResourceId),
      this.deps.store.listResources(project.id),
    ]);
    const sourceDescription=await this.describe(source.externalReference);
    const targetDescription=await this.describe(target.externalReference);
    const sourceHeadSha=sourceDescription?await this.deps.repositories?.resolveRef(source.externalReference,sourceDescription.defaultBranch):undefined;
    const targetHeadSha=targetDescription&&!targetDescription.isEmpty?await this.deps.repositories?.resolveRef(target.externalReference,targetDescription.defaultBranch):undefined;
    const refs=sourceDescription?await this.deps.repositories?.listRefs(source.externalReference):undefined;
    return buildRepositoryExportPlan({
      project,
      source,
      target,
      ...(sourceDescription?{sourceDescription}:{}),
      ...(targetDescription?{targetDescription}:{}),
      ...(sourceHeadSha?{sourceHeadSha}:{}),
      ...(targetHeadSha?{targetHeadSha}:{}),
      branches:refs?.branches??[],
      tags:refs?.tags??[],
      ...(this.deps.repositories?{}:{providerError:'No Git repository provider is configured in this runtime'}),
      secretHandover:buildSecretConfigHandover({projectId:project.id,sourceRepository:source.externalReference,targetRepository:target.externalReference,resources,now:this.clock.now()}),
      now:this.clock.now(),
    });
  }

  /**
   * Starts the bounded Git-level transfer. The actual mirror runs in the fixed control-repository
   * workflow -- the control plane has no subprocess and must not have one -- and the workflow
   * receives only registered repository identities and the exact expected source head.
   */
  async exportRepository(input:unknown,actor:string){
    const data=repositoryExportInputSchema.parse(input);
    const plan=await this.exportPlan({projectId:data.projectId,sourceResourceId:data.sourceResourceId,targetResourceId:data.targetResourceId});
    if(plan.result==='BLOCKED')throw new PolicyViolation('Repository export is blocked',{blockers:plan.blockers,plan});
    if(plan.sourceHeadSha!==data.expectedSourceHeadSha)
      throw new Conflict('The source head moved after the export plan was generated',{expected:data.expectedSourceHeadSha,actual:plan.sourceHeadSha,blockingReport:{code:'STALE_EXPORT_PLAN',reason:'The source repository advanced between planning and export.',remediation:'Re-run the export plan and export with the head it reports.'}});
    if(!this.deps.exportDispatcher)
      throw new UnsupportedOperation('No repository export dispatcher is configured in this runtime',{blockingReport:{code:'EXPORT_DISPATCHER_UNAVAILABLE',reason:'A Git-level transfer runs only in the fixed control-repository workflow, which this runtime cannot start.',remediation:'Configure the GitHub Actions dispatcher, or perform the transfer through the documented manual operator path.'}});

    const handover=await this.artifacts.write(data.projectId,'SECRET_CONFIG_HANDOVER',plan.secretHandover);
    const dispatched=await this.deps.exportDispatcher.dispatchWorkflow(this.deps.exportWorkflow??'autopilot-repository-export.yml',{
      operation_id:data.operationId,
      export_input:JSON.stringify({
        projectId:data.projectId,
        operationId:data.operationId,
        sourceRepository:plan.sourceRepository,
        targetRepository:plan.targetRepository,
        sourceResourceId:plan.sourceResourceId,
        targetResourceId:plan.targetResourceId,
        expectedSourceHeadSha:data.expectedSourceHeadSha,
        defaultBranch:plan.sourceDefaultBranch,
        requiredRefs:plan.requiredRefs,
      }),
    });
    const report=await this.artifacts.write(data.projectId,'REPOSITORY_EXPORT_REPORT',{
      operationId:data.operationId,
      actor,
      reason:data.reason,
      status:'DISPATCHED',
      transferMechanism:plan.transferMechanism,
      sourceRepository:plan.sourceRepository,
      targetRepository:plan.targetRepository,
      sourceResourceId:plan.sourceResourceId,
      targetResourceId:plan.targetResourceId,
      expectedSourceHeadSha:data.expectedSourceHeadSha,
      requiredRefs:plan.requiredRefs,
      secretHandoverArtifactId:handover.id,
      secretsTransferred:false,
      dispatchedAt:this.clock.now(),
      dispatch:dispatched,
      note:'Export does not change which repository is canonical. Promoting the target is a separate, explicit decision.',
    });
    await this.recordAudit(data.projectId,'repository_export.dispatch',actor,data.operationId,{
      sourceResourceId:plan.sourceResourceId,
      targetResourceId:plan.targetResourceId,
      sourceRepository:plan.sourceRepository,
      targetRepository:plan.targetRepository,
      sourceSha:data.expectedSourceHeadSha,
      targetSha:null,
      defaultBranch:plan.sourceDefaultBranch??null,
      result:'DISPATCHED',
    },'Authorized Git-level repository export dispatched; secret values are never transferred');
    return {status:'EXPORT_DISPATCHED',operationId:data.operationId,reportArtifactId:report.id,secretHandoverArtifactId:handover.id,plan};
  }

  /** Reads the target back and judges completeness. Unverifiable is BLOCKED, never partial. */
  async exportVerify(input:{projectId:string;sourceResourceId:string;targetResourceId:string;persist?:boolean;operationId?:string},actor:string):Promise<RepositoryExportVerification>{
    const project=await this.requireProject(input.projectId);
    const [source,target]=await Promise.all([
      this.requireProjectResource(project.id,input.sourceResourceId),
      this.requireProjectResource(project.id,input.targetResourceId),
    ]);
    const sourceDescription=await this.describe(source.externalReference);
    const targetDescription=await this.describe(target.externalReference);
    const sourceRefs=sourceDescription?await this.deps.repositories?.listRefs(source.externalReference):undefined;
    const targetRefs=targetDescription?await this.deps.repositories?.listRefs(target.externalReference):undefined;
    const sourceHeadSha=sourceDescription?await this.deps.repositories?.resolveRef(source.externalReference,sourceDescription.defaultBranch):undefined;
    const targetHeadSha=targetDescription?await this.deps.repositories?.resolveRef(target.externalReference,targetDescription.defaultBranch):undefined;
    const sourceHeadPresentInTarget=sourceHeadSha&&targetDescription?await this.deps.repositories?.commitExists(target.externalReference,sourceHeadSha):undefined;
    const verification=verifyRepositoryExport({
      projectId:project.id,
      sourceRepository:source.externalReference,
      targetRepository:target.externalReference,
      ...(sourceDescription?{sourceDescription}:{}),
      ...(targetDescription?{targetDescription}:{}),
      ...(sourceHeadSha?{sourceHeadSha}:{}),
      ...(targetHeadSha?{targetHeadSha}:{}),
      expectedBranches:sourceRefs?.branches??[],
      expectedTags:sourceRefs?.tags??[],
      targetBranches:targetRefs?.branches??[],
      targetTags:targetRefs?.tags??[],
      ...(sourceHeadPresentInTarget===undefined?{}:{sourceHeadPresentInTarget}),
      now:this.clock.now(),
    });
    if(input.persist){
      const artifact=await this.artifacts.write(project.id,'REPOSITORY_EXPORT_VERIFICATION',verification);
      await this.recordAudit(project.id,'repository_export.verify',actor,input.operationId??artifact.id,{
        sourceResourceId:source.resourceId,
        targetResourceId:target.resourceId,
        sourceRepository:source.externalReference,
        targetRepository:target.externalReference,
        sourceSha:verification.sourceHeadSha??null,
        targetSha:verification.targetHeadSha??null,
        defaultBranch:verification.defaultBranch??null,
        result:verification.result,
      },'Repository export verification recorded');
    }
    return verification;
  }

  // ----------------------------------------------------------------- handover

  async handoverReport(input:{projectId:string;persist?:boolean;operationId?:string},actor:string):Promise<DeveloperHandoverReport>{
    const project=await this.requireProject(input.projectId);
    const active=await this.deps.store.getActiveCanonicalRepository(project.id);
    const documents:Record<string,string|undefined>={};
    let headSha:string|undefined;let defaultBranch:string|undefined;
    if(active&&this.deps.repositories){
      const description=await this.describe(active.repositoryIdentity.externalReference);
      defaultBranch=description?.defaultBranch??active.defaultBranch;
      headSha=defaultBranch?await this.deps.repositories.resolveRef(active.repositoryIdentity.externalReference,defaultBranch):undefined;
      for(const path of requiredHandoverDocuments)
        documents[path]=await this.deps.repositories.readFile(active.repositoryIdentity.externalReference,path,headSha);
    }
    const report=buildDeveloperHandoverReport({
      projectId:project.id,
      ...(active?{repository:active.repositoryIdentity.externalReference}:{}),
      ...(defaultBranch?{defaultBranch}:{}),
      ...(headSha?{headSha}:{}),
      canonicalActive:Boolean(active),
      documents,
      now:this.clock.now(),
    });
    if(input.persist){
      const artifact=await this.artifacts.write(project.id,'DEVELOPER_HANDOVER_REPORT',report);
      await this.recordAudit(project.id,'developer_handover.report',actor,input.operationId??artifact.id,{
        targetRepository:report.repository??null,
        targetSha:report.headSha??null,
        defaultBranch:report.defaultBranch??null,
        result:report.result,
      },'Developer handover readiness recorded');
    }
    return report;
  }

  // ------------------------------------------------------------------ helpers

  private async buildPlan(projectId:string,resourceId:string):Promise<CanonicalRepositoryPlan>{
    const project=await this.requireProject(projectId);
    // Cross-project and non-GitHub candidates fail here, before any plan exists to read.
    const resource=await this.requireProjectResource(project.id,resourceId);
    const [history,artifacts]=await Promise.all([
      this.deps.store.listCanonicalRepositories(project.id),
      this.deps.store.listArtifacts(project.id),
    ]);
    const description=await this.describe(resource.externalReference);
    const headSha=description?.defaultBranch?await this.deps.repositories?.resolveRef(resource.externalReference,description.defaultBranch):undefined;
    const headReachable=headSha?await this.deps.repositories?.commitExists(resource.externalReference,headSha):undefined;
    const currentCanonical=history.find(value=>value.status==='ACTIVE');
    const facts:PromotionFacts={
      project,
      resource,
      ...(description?{description}:{}),
      ...(this.deps.repositories?{}:{providerError:'No Git repository provider is configured in this runtime'}),
      ...(headSha?{headSha}:{}),
      ...(headReachable===undefined?{}:{headReachable}),
      ...(currentCanonical?{currentCanonical}:{}),
      conflictingCandidates:history.filter(value=>value.status==='CANDIDATE'),
      ...(unfinishedExport(artifacts)??{}),
      verification:resolveVerificationState(artifacts,resource.externalReference,headSha),
      now:this.clock.now(),
    };
    return buildCanonicalRepositoryPlan(facts);
  }

  private async describe(repository:string):Promise<RepositoryDescription|undefined>{
    if(!this.deps.repositories)return undefined;
    try{return await this.deps.repositories.describe(repository);}catch{return undefined;}
  }
  private async requireProject(id:string):Promise<Project>{
    const value=await this.deps.store.getProject(id);
    if(!value)throw new NotFound('Project not found',{projectId:id});
    return value;
  }
  private async requireProjectResource(projectId:string,resourceId:string):Promise<Resource>{
    const value=await this.deps.store.getResource(resourceId);
    if(!value||value.projectId!==projectId)throw new NotFound('Project resource not found',{projectId,resourceId});
    return value;
  }
  private requireProjectRepository(projectId:string,resourceId:string){
    return requireProjectGithubRepository(this.deps.store,projectId,resourceId);
  }
  private writeCanonicalReport(projectId:string,operation:'PROMOTE'|'ROLLBACK',content:Record<string,unknown>):Promise<Artifact>{
    return this.artifacts.write(projectId,'CANONICAL_REPOSITORY_REPORT',{operation,generatedAt:this.clock.now(),...content});
  }
  private recordAudit(projectId:string,action:string,actor:string,correlationId:string,result:Record<string,unknown>,reason:string){
    return this.audit.record({actor,action,projectId,input:{operation:action,correlationId},result:{...result,timestamp:this.clock.now()},reason,correlationId});
  }
}

function identityOf(resource:Resource){
  const [owner='',name='']=resource.externalReference.split('/');
  return {provider:resource.provider,owner,name,externalReference:resource.externalReference};
}

/** An export that was dispatched and never verified. Canonical state must not move underneath it. */
function unfinishedExport(artifacts:Artifact[]):{unfinishedExport:{targetRepository:string;operationId:string;dispatchedAt:string}}|undefined{
  const verifiedTargets=new Set(
    artifacts
      .filter(value=>value.kind==='REPOSITORY_EXPORT_VERIFICATION'&&value.status==='AVAILABLE')
      .map(value=>(value.content as {targetRepository?:string}|undefined)?.targetRepository)
      .filter((value):value is string=>Boolean(value)),
  );
  const pending=[...artifacts]
    .reverse()
    .map(value=>({value,content:value.content as {status?:string;targetRepository?:string;operationId?:string;dispatchedAt?:string}|undefined}))
    .find(({value,content})=>value.kind==='REPOSITORY_EXPORT_REPORT'&&value.status==='AVAILABLE'&&content?.status==='DISPATCHED'&&content.targetRepository&&!verifiedTargets.has(content.targetRepository));
  if(!pending?.content?.targetRepository)return undefined;
  return {unfinishedExport:{targetRepository:pending.content.targetRepository,operationId:pending.content.operationId??'unknown',dispatchedAt:pending.content.dispatchedAt??'unknown'}};
}

/**
 * Reports whatever verification evidence actually exists for the candidate head, and reports
 * nothing when none does. Evidence at a different commit is surfaced as stale rather than
 * counted -- the same rule the epic gate applies, for the same reason.
 */
function resolveVerificationState(artifacts:Artifact[],repository:string,headSha:string|undefined):CanonicalRepositoryPlan['verificationState']{
  // An epic report that names a different repository is not evidence about this candidate, and a
  // report that names none cannot be attributed to one at all.
  const epic=[...artifacts].reverse().find(value=>value.kind==='EPIC_VERIFICATION_REPORT'&&value.status==='AVAILABLE'&&(value.content as {repository?:string}|undefined)?.repository===repository);
  const epicContent=epic?.content as {headSha?:string;result?:string;repository?:string;epicKey?:string}|undefined;
  if(epicContent?.headSha)
    return {
      source:'EPIC_VERIFICATION_REPORT',
      status:epicContent.result==='PASS'?'PASS':'BLOCKED',
      headSha:epicContent.headSha,
      atCandidateHead:Boolean(headSha)&&epicContent.headSha===headSha,
      detail:`Epic ${epicContent.epicKey ?? 'verification'} reported ${epicContent.result ?? 'an unknown result'} at ${epicContent.headSha}${epicContent.repository?` on ${epicContent.repository}`:''}.`,
    };
  const ci=[...artifacts].reverse().find(value=>value.kind==='CI_REPORT'&&value.status==='AVAILABLE'&&(value.content as {repository?:string}|undefined)?.repository===repository);
  const ciContent=ci?.content as {expectedSha?:string;ci?:{success?:boolean}}|undefined;
  if(ciContent?.expectedSha)
    return {
      source:'CI_REPORT',
      status:ciContent.ci?.success?'PASS':'BLOCKED',
      headSha:ciContent.expectedSha,
      atCandidateHead:Boolean(headSha)&&ciContent.expectedSha===headSha,
      detail:`The most recent CI report for ${repository} covers ${ciContent.expectedSha}.`,
    };
  return {source:'NONE',status:'UNKNOWN',atCandidateHead:false,detail:'No epic verification or CI evidence was found for this repository in this project.'};
}
