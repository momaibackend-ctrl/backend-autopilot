import type { CommandRunner } from '../../../execution-engine/src/command-runner.js';
import { ExecutionFailed } from '../../../core/src/errors.js';

export interface GitSnapshot {baseCommit:string;branch:string;clean:boolean;}
export class LocalGitAdapter {
  constructor(private commands:CommandRunner){}
  private async git(cwd:string,taskId:string,args:string[],write=false){const r=await this.commands.run({command:'git',args,cwd,taskId,allowed:write?['READ','BUILD']:['READ']});if(r.record.exitCode!==0)throw new ExecutionFailed('Git command failed',{args,stderr:r.stderr});return r;}
  async ensureClean(cwd:string,taskId:string){const r=await this.git(cwd,taskId,['status','--porcelain']);if(r.stdout.trim())throw new ExecutionFailed('Target repository must have a clean working tree',{status:r.stdout});}
  async snapshot(cwd:string,taskId:string):Promise<GitSnapshot>{await this.ensureClean(cwd,taskId);const sha=(await this.git(cwd,taskId,['rev-parse','HEAD'])).stdout.trim();const branch=(await this.git(cwd,taskId,['branch','--show-current'])).stdout.trim();if(!['main','master'].includes(branch)&&!branch.startsWith('autopilot/'))throw new ExecutionFailed('Unrecognized base branch');return {baseCommit:sha,branch,clean:true};}
  async branch(cwd:string,taskId:string,name:string){if(['main','master'].includes(name))throw new ExecutionFailed('Direct main/master execution is forbidden');await this.git(cwd,taskId,['checkout','-b',name],true);}
  async diff(cwd:string,taskId:string,baseCommit?:string){return (await this.git(cwd,taskId,['diff',...(baseCommit?[baseCommit]:[]),'--'])).stdout;}
  async stage(cwd:string,taskId:string){await this.git(cwd,taskId,['add','.'],true);}
  async commit(cwd:string,taskId:string,message:string){await this.git(cwd,taskId,['add','.'],true);await this.git(cwd,taskId,['commit','-m',message],true);return (await this.git(cwd,taskId,['rev-parse','HEAD'])).stdout.trim();}
  async currentBranch(cwd:string,taskId:string){return (await this.git(cwd,taskId,['branch','--show-current'])).stdout.trim();}
}
