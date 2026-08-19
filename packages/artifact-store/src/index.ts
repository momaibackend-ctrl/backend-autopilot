import { createHash } from 'node:crypto';
import type { Clock, IdGenerator, StateStore } from '../../core/src/ports.js';
import { NotFound, PolicyViolation } from '../../core/src/errors.js';
import type { Artifact, ArtifactKind } from '../../schemas/src/index.js';
import { PlatformVersions } from '../../schemas/src/index.js';
import { redact } from '../../audit/src/index.js';

export class ArtifactStore {
  constructor(private store:StateStore,private ids:IdGenerator,private clock:Clock){}
  async write(projectId:string,kind:ArtifactKind,content:unknown,taskId?:string,runId?:string):Promise<Artifact>{
    const safe=redact(content);const artifact:Artifact={id:this.ids.next(),projectId,...(taskId?{taskId}:{}),...(runId?{runId}:{}),kind,schemaVersion:PlatformVersions.artifact,content:safe,contentHash:createHash('sha256').update(JSON.stringify(safe)).digest('hex'),createdAt:this.clock.now()};return this.store.saveArtifact(artifact);
  }
  async read(projectId:string,id:string){const artifact=await this.store.getArtifact(projectId,id);if(!artifact)throw new NotFound('Artifact not found');if(artifact.projectId!==projectId)throw new PolicyViolation('Cross-project artifact access denied');return artifact;}
  list(projectId:string,taskId?:string){return this.store.listArtifacts(projectId,taskId);}
}
