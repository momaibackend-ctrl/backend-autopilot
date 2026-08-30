import { ExecutionFailed, PolicyViolation } from '../../../core/src/errors.js';
import type { GitRepositoryProvider, RepositoryDescription } from '../../../canonical-repository/src/ports.js';
import type { RepositoryRef } from '../../../schemas/src/index.js';

/**
 * GitRepositoryProvider over the GitHub REST API. Uses `fetch` only -- no `gh`/`git` subprocess --
 * because the control plane that asks these questions runs on Supabase Edge, which cannot spawn
 * one.
 *
 * Every method takes `owner/name` and validates its shape before it reaches a URL, so a tampered
 * or caller-influenced value cannot turn a repository read into a request to somewhere else.
 */
export class GitHubRestRepositoryProvider implements GitRepositoryProvider {
  constructor(private readonly token:string,private readonly fetchImpl:typeof fetch=fetch){
    if(!token)throw new PolicyViolation('A GitHub credential is required to read repository state');
  }

  async describe(repository:string):Promise<RepositoryDescription>{
    const value=await this.json<{full_name:string;default_branch:string;size:number;private:boolean;visibility?:string;permissions?:{pull?:boolean;push?:boolean;admin?:boolean}}>(`/repos/${this.path(repository)}`);
    const branches=await this.json<Array<{name:string;protected?:boolean}>>(`/repos/${this.path(repository)}/branches?per_page=100`).catch(()=>[]);
    // `size` is 0 for a repository with no commits; confirming against the default branch avoids
    // treating a tiny repository as empty.
    const head=await this.resolveRef(repository,value.default_branch);
    return {
      externalReference:value.full_name,
      defaultBranch:value.default_branch,
      isEmpty:!head,
      visibility:value.visibility??(value.private?'private':'public'),
      permissions:{pull:value.permissions?.pull??false,push:value.permissions?.push??false,admin:value.permissions?.admin??false},
      protectedBranches:branches.filter(branch=>branch.protected).map(branch=>branch.name),
    };
  }

  async resolveRef(repository:string,ref:string):Promise<string|undefined>{
    const value=await this.json<{sha:string}>(`/repos/${this.path(repository)}/commits/${encodeURIComponent(ref)}`,{allowMissing:true});
    return value?.sha;
  }

  async commitExists(repository:string,sha:string):Promise<boolean>{
    if(!/^[0-9a-f]{40}$/.test(sha))throw new PolicyViolation('An exact 40-character commit SHA is required');
    return Boolean(await this.json<{sha:string}>(`/repos/${this.path(repository)}/commits/${sha}`,{allowMissing:true}));
  }

  async listRefs(repository:string):Promise<{branches:RepositoryRef[];tags:RepositoryRef[]}>{
    const [branches,tags]=await Promise.all([
      this.paged<{name:string;commit:{sha:string}}>(`/repos/${this.path(repository)}/branches`),
      this.paged<{name:string;commit:{sha:string}}>(`/repos/${this.path(repository)}/tags`),
    ]);
    const ref=(value:{name:string;commit:{sha:string}}):RepositoryRef=>({name:value.name,sha:value.commit.sha});
    return {branches:branches.map(ref),tags:tags.map(ref)};
  }

  async readFile(repository:string,path:string,ref?:string):Promise<string|undefined>{
    const value=await this.json<{type:string;content?:string;encoding?:string;download_url?:string}>(`/repos/${this.path(repository)}/contents/${this.contentPath(path)}${ref?`?ref=${encodeURIComponent(ref)}`:''}`,{allowMissing:true});
    if(!value||value.type!=='file')return undefined;
    if(value.content&&value.encoding==='base64')
      return new TextDecoder().decode(Uint8Array.from(atob(value.content.replace(/\n/g,'')),character=>character.charCodeAt(0)));
    if(!value.download_url)return undefined;
    const raw=await this.fetchImpl(value.download_url,{headers:{authorization:`Bearer ${this.token}`,'user-agent':'backend-autopilot'}});
    return raw.ok?raw.text():undefined;
  }

  async listDirectory(repository:string,path:string,ref?:string):Promise<string[]|undefined>{
    const value=await this.json<Array<{path:string}>|{type:string}>(`/repos/${this.path(repository)}/contents/${this.contentPath(path)}${ref?`?ref=${encodeURIComponent(ref)}`:''}`,{allowMissing:true});
    return Array.isArray(value)?value.map(entry=>entry.path):undefined;
  }

  private path(repository:string){
    if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))throw new PolicyViolation('Invalid repository identity',{repository});
    return repository;
  }
  private contentPath(path:string){
    const clean=path.replace(/^\/+|\/+$/g,'');
    if(clean.split('/').includes('..'))throw new PolicyViolation('Invalid repository path',{path});
    return clean.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  }
  private async paged<T>(path:string):Promise<T[]>{
    const values:T[]=[];
    for(let page=1;page<=10;page++){
      const batch=await this.json<T[]>(`${path}?per_page=100&page=${page}`);
      values.push(...batch);
      if(batch.length<100)break;
    }
    return values;
  }
  private async json<T>(path:string,options:{allowMissing?:boolean}={}):Promise<T>{
    const response=await this.fetchImpl(`https://api.github.com${path}`,{headers:{accept:'application/vnd.github+json',authorization:`Bearer ${this.token}`,'user-agent':'backend-autopilot','x-github-api-version':'2022-11-28'}});
    if(response.status===404||response.status===409){
      // 409 is what GitHub answers for "repository is empty", which is a fact, not a failure.
      if(options.allowMissing)return undefined as T;
      throw new ExecutionFailed('GitHub repository read failed',{path,status:response.status});
    }
    if(!response.ok)throw new ExecutionFailed('GitHub repository read failed',{path,status:response.status,body:(await response.text()).slice(0,300)});
    return await response.json() as T;
  }
}
