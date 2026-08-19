import { CredentialMissing } from './errors.js';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SecretProvider {get(reference:string,projectId:string):Promise<string>;}
export interface MutableSecretProvider extends SecretProvider {set(reference:string,value:string,projectId:string):Promise<void>;revoke(reference:string,projectId:string):Promise<void>;}
export class EnvironmentSecretProvider implements SecretProvider {
  async get(reference:string,_projectId:string){const value=process.env[reference];if(!value)throw new CredentialMissing(`Secret reference ${reference} is not configured`);return value;}
}

export class DotEnvSecretProvider implements MutableSecretProvider {
  constructor(private path=join(process.cwd(),'.env')){}
  async get(reference:string,_projectId:string){validateReference(reference);const runtime=process.env[reference];if(runtime)return runtime;const values=await this.read();const value=values.get(reference);if(!value)throw new CredentialMissing(`Secret reference ${reference} is not configured`);return value;}
  async set(reference:string,value:string,_projectId:string){validateReference(reference);if(!value)throw new CredentialMissing('Refusing to store an empty secret');const values=await this.read();values.set(reference,value);await this.write(values);process.env[reference]=value;}
  async revoke(reference:string,_projectId:string){validateReference(reference);const values=await this.read();values.delete(reference);await this.write(values);delete process.env[reference];}
  private async read(){const values=new Map<string,string>();try{for(const line of (await readFile(this.path,'utf8')).split(/\r?\n/)){const match=/^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);if(match?.[1]!==undefined&&match[2]!==undefined)values.set(match[1],decode(match[2]));}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}return values;}
  private async write(values:Map<string,string>){const temp=`${this.path}.${crypto.randomUUID()}.tmp`;const body=[...values.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>`${key}=${JSON.stringify(value)}`).join('\n')+'\n';await writeFile(temp,body,{encoding:'utf8',mode:0o600});await rename(temp,this.path);try{await chmod(this.path,0o600);}catch{/* Windows permissions are inherited; the file remains gitignored. */}}
}
function validateReference(reference:string){if(!/^[A-Z][A-Z0-9_]{2,127}$/.test(reference))throw new CredentialMissing('Invalid secret reference name');}
function decode(value:string){try{return JSON.parse(value) as string;}catch{return value;}}
