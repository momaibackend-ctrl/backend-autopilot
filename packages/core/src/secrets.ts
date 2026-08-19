import { CredentialMissing } from './errors.js';

export interface SecretProvider {get(reference:string,projectId:string):Promise<string>;}
export class EnvironmentSecretProvider implements SecretProvider {
  async get(reference:string,_projectId:string){const value=process.env[reference];if(!value)throw new CredentialMissing(`Secret reference ${reference} is not configured`);return value;}
}
