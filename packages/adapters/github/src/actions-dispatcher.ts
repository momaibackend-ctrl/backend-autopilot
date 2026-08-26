import { ExecutionFailed, PolicyViolation } from '../../../core/src/errors.js';
import type { ExecutionJobDispatcher } from '../../../core/src/async-execution.js';
import type { ExecutionJob } from '../../../schemas/src/index.js';

export class GitHubActionsDispatcher implements ExecutionJobDispatcher {
  constructor(private readonly token:string,private readonly controlRepository:string,private readonly workflow='autopilot-execution.yml',private readonly ref='main'){
    if(!token)throw new PolicyViolation('GitHub Actions dispatch credential is required');
    if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(controlRepository))throw new PolicyViolation('Invalid control repository identity');
  }
  async dispatch(job:ExecutionJob){
    const response=await fetch(`https://api.github.com/repos/${this.controlRepository}/actions/workflows/${encodeURIComponent(this.workflow)}/dispatches`,{method:'POST',headers:{accept:'application/vnd.github+json',authorization:`Bearer ${this.token}`,'content-type':'application/json','user-agent':'backend-autopilot/0.5','x-github-api-version':'2022-11-28'},body:JSON.stringify({ref:this.ref,inputs:{job_id:job.id}})});
    if(!response.ok)throw new ExecutionFailed('GitHub Actions workflow dispatch failed',{status:response.status,body:(await response.text()).slice(0,300)});
    const body=await response.text();if(!body)return {};
    const value=JSON.parse(body) as {workflow_run_id?:number;id?:number;html_url?:string;workflow_run_url?:string};const id=value.workflow_run_id??value.id;
    return {...(id?{workflowRunId:String(id)}:{}),...(value.html_url||value.workflow_run_url?{workflowRunUrl:value.html_url??value.workflow_run_url}: {})};
  }
}
