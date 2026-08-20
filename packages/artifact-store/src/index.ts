import { createHash } from 'node:crypto';
import type { ArtifactBlobStore, Clock, IdGenerator, StateStore } from '../../core/src/ports.js';
import { NotFound, PolicyViolation } from '../../core/src/errors.js';
import type { Artifact, ArtifactKind } from '../../schemas/src/index.js';
import { PlatformVersions } from '../../schemas/src/index.js';
import { redact } from '../../audit/src/index.js';

export class ArtifactStore {
  constructor(private store:StateStore,private ids:IdGenerator,private clock:Clock,private blobs?:ArtifactBlobStore,private externalizeAtBytes=64*1024){}
  async write(projectId:string,kind:ArtifactKind,content:unknown,taskId?:string,runId?:string):Promise<Artifact>{
    const safe=redact(content);const serialized=JSON.stringify(safe);const id=this.ids.next();const contentHash=createHash('sha256').update(serialized).digest('hex');
    const storage=this.blobs&&new TextEncoder().encode(serialized).byteLength>=this.externalizeAtBytes?await this.blobs.put({projectId,artifactId:id,body:serialized,contentType:'application/json'}):undefined;
    const artifact:Artifact={id,projectId,...(taskId?{taskId}:{}),...(runId?{runId}:{}),kind,schemaVersion:PlatformVersions.artifact,content:storage?{externalized:true}:safe,contentHash,status:'AVAILABLE',...(storage?{storage}:{}),createdAt:this.clock.now()};return this.store.saveArtifact(artifact);
  }
  async read(projectId:string,id:string){const artifact=await this.store.getArtifact(projectId,id);if(!artifact)throw new NotFound('Artifact not found');if(artifact.projectId!==projectId)throw new PolicyViolation('Cross-project artifact access denied');if(!artifact.storage)return artifact;if(!this.blobs)throw new NotFound('Artifact blob provider is unavailable');const body=await this.blobs.get(artifact.storage);return {...artifact,content:JSON.parse(body) as unknown};}
  list(projectId:string,taskId?:string){return this.store.listArtifacts(projectId,taskId);}
}
