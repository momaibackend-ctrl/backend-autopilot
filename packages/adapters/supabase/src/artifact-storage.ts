import { ExecutionFailed, PolicyViolation } from '../../../core/src/errors.js';
import type { ArtifactBlobStore } from '../../../core/src/ports.js';

export class SupabaseStorageArtifactBlobStore implements ArtifactBlobStore {
  constructor(private readonly url:string,private readonly serviceRoleKey:string,private readonly bucket='autopilot-artifacts'){
    if(!/^https:\/\/[a-z]{20}\.supabase\.co$/.test(url))throw new PolicyViolation('Invalid Supabase control-plane URL');
    if(!serviceRoleKey)throw new PolicyViolation('Supabase service role credential is required');
  }
  async put(input:{projectId:string;artifactId:string;body:string;contentType:string}){
    const path=`${input.projectId}/${input.artifactId}.json`;
    const response=await fetch(`${this.url}/storage/v1/object/${this.bucket}/${path}`,{method:'POST',headers:this.headers(input.contentType),body:input.body});
    if(!response.ok)throw new ExecutionFailed('Supabase artifact upload failed',{status:response.status,body:(await response.text()).slice(0,300)});
    return {provider:'supabase',bucket:this.bucket,path,contentType:input.contentType,size:new TextEncoder().encode(input.body).byteLength};
  }
  async get(reference:{provider:string;bucket:string;path:string;contentType:string;size:number}){
    if(reference.provider!=='supabase'||reference.bucket!==this.bucket||reference.path.includes('..'))throw new PolicyViolation('Artifact storage reference is not authorized');
    const response=await fetch(`${this.url}/storage/v1/object/${reference.bucket}/${reference.path}`,{headers:this.headers(reference.contentType)});
    if(!response.ok)throw new ExecutionFailed('Supabase artifact download failed',{status:response.status});
    return response.text();
  }
  private headers(contentType:string){return {authorization:`Bearer ${this.serviceRoleKey}`,apikey:this.serviceRoleKey,'content-type':contentType,'x-upsert':'false'};}
}
