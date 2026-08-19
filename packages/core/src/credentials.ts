import type { StateStore } from './ports.js';
import type { SecretProvider } from './secrets.js';
import { NotFound, PolicyViolation } from './errors.js';
import { PolicyEngine } from '../../policy-engine/src/index.js';

export class AuthorizedSecretResolver {
  private policy:PolicyEngine;
  constructor(private store:StateStore,private secrets:SecretProvider){this.policy=new PolicyEngine(store);}
  async get(projectId:string,resourceId:string,reference:string,actor='adapter'){
    const project=await this.store.getProject(projectId);if(!project)throw new NotFound('Project not found');await this.policy.authorize({project,action:'RESOURCE_READ',resourceId,requiredPermission:'READ',actor});const resource=await this.store.getResource(resourceId);if(!resource?.secretRefs.includes(reference))throw new PolicyViolation('Secret reference is not assigned to this resource');return this.secrets.get(reference,projectId);
  }
}
