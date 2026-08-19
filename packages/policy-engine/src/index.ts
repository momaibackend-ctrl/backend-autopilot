import { PolicyViolation, UnknownResource, UnsupportedOperation } from '../../core/src/errors.js';
import type { StateStore } from '../../core/src/ports.js';
import type { Project, ResourcePermission } from '../../schemas/src/index.js';

export type PolicyAction='PROJECT_WRITE'|'RESOURCE_READ'|'RESOURCE_WRITE'|'EXECUTE'|'MIGRATE'|'NETWORK'|'PROVISION'|'DESTRUCTIVE'|'ARTIFACT_READ';
export interface AuthorizationRequest {project:Project;action:PolicyAction;resourceId?:string;requiredPermission?:ResourcePermission;actor:string;}

export class PolicyEngine {
  constructor(private readonly store:StateStore){}
  async authorize(request:AuthorizationRequest):Promise<void>{
    if(request.project.autonomyMode==='AUTONOMOUS_PRODUCTION') throw new UnsupportedOperation('AUTONOMOUS_PRODUCTION is technically disabled in v0.2');
    if(request.action==='EXECUTE'&&request.project.autonomyMode==='OBSERVE') throw new PolicyViolation('OBSERVE mode forbids execution');
    if(['MIGRATE','NETWORK','PROVISION','DESTRUCTIVE'].includes(request.action)&&request.project.autonomyMode!=='AUTONOMOUS_STAGING') throw new PolicyViolation(`${request.project.autonomyMode} mode forbids ${request.action}; AUTONOMOUS_STAGING is required`);
    if(request.project.environment==='PRODUCTION'&&request.action!=='RESOURCE_READ'&&request.action!=='ARTIFACT_READ') throw new UnsupportedOperation('Production mutation is not supported in v0.2');
    if(request.resourceId){
      const resource=await this.store.getResource(request.resourceId);
      if(!resource) throw new UnknownResource('Resource is not registered in the explicit allowlist',{resourceId:request.resourceId});
      if(resource.projectId!==request.project.id) throw new PolicyViolation('Cross-project resource access denied',{resourceProjectId:resource.projectId,requestedProjectId:request.project.id});
      if(resource.status!=='ACTIVE') throw new PolicyViolation('Resource is disabled');
      if(request.requiredPermission&&!resource.permissions.includes(request.requiredPermission)) throw new PolicyViolation('Resource permission denied',{required:request.requiredPermission});
      if(resource.environment==='PRODUCTION'&&request.action!=='RESOURCE_READ') throw new UnsupportedOperation('Production resource mutation is not supported');
    } else if(['RESOURCE_READ','RESOURCE_WRITE','MIGRATE','NETWORK','PROVISION','DESTRUCTIVE'].includes(request.action)) {
      throw new UnknownResource('External operations require an explicitly registered resource');
    }
  }
}
