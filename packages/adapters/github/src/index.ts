import { UnsupportedOperation } from '../../../core/src/errors.js';

export interface GitHubAdapter {createRepository(name:string):Promise<never>;createBranch(resourceId:string,branch:string):Promise<never>;push(resourceId:string,branch:string):Promise<never>;openPullRequest(resourceId:string,branch:string,title:string):Promise<never>;ciStatus(resourceId:string,ref:string):Promise<never>;diff(resourceId:string,base:string,head:string):Promise<never>;}
export class DisabledGitHubAdapter implements GitHubAdapter {
  async createRepository(_name:string):Promise<never>{throw new UnsupportedOperation('GitHub mutations require an explicit registered target and are not enabled by default');}
  async createBranch(_resourceId:string,_branch:string):Promise<never>{throw new UnsupportedOperation('GitHub branches are not enabled in local v0.1');}
  async push(_resourceId:string,_branch:string):Promise<never>{throw new UnsupportedOperation('GitHub push is not enabled in local v0.1');}
  async openPullRequest(_resourceId:string,_branch:string,_title:string):Promise<never>{throw new UnsupportedOperation('GitHub pull requests are not enabled in local v0.1');}
  async ciStatus(_resourceId:string,_ref:string):Promise<never>{throw new UnsupportedOperation('GitHub CI status is not enabled in local v0.1');}
  async diff(_resourceId:string,_base:string,_head:string):Promise<never>{throw new UnsupportedOperation('GitHub remote diff is not enabled in local v0.1');}
}
