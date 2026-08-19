import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import type { Clock } from '../../core/src/ports.js';
import { ExecutionFailed } from '../../core/src/errors.js';
import type { FileChange, Task } from '../../schemas/src/index.js';
import type { LocalGitAdapter } from '../../adapters/git/src/index.js';

export class ExecutionEngine {
  constructor(private git:LocalGitAdapter,private clock:Clock){}
  async execute(input:{workspace:string;task:Task;changes:FileChange[]}){
    const root=resolve(input.workspace);const snapshot=await this.git.snapshot(root,input.task.id);const slug=input.task.title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)||'task';const branch=`autopilot/${input.task.externalKey}-${slug}`;
    if(snapshot.branch!==branch)await this.git.branch(root,input.task.id,branch);
    for(const change of input.changes){const target=resolve(root,change.path);const rel=relative(root,target);if(rel.startsWith(`..${sep}`)||rel==='..'||rel.startsWith(sep))throw new ExecutionFailed('File change escapes project workspace',{path:change.path});if(change.path.includes('.env')||change.path.toLowerCase().includes('secret')||/(?:gh[pousr]_|sbp_)[A-Za-z0-9_-]+/.test(change.content)||/(password|token|secret|api[_-]?key)\s*[:=]\s*[^\s'"$<{]+/i.test(change.content))throw new ExecutionFailed('Potential secret material in file change is forbidden',{path:change.path});await mkdir(dirname(target),{recursive:true});await writeFile(target,change.content,'utf8');}
    await this.git.stage(root,input.task.id);const diff=await this.git.diff(root,input.task.id,snapshot.baseCommit);if(!diff.trim())throw new ExecutionFailed('Implementation produced no diff');const commitSha=await this.git.commit(root,input.task.id,`autopilot: ${input.task.externalKey} ${input.task.title}`);
    return {baseCommit:snapshot.baseCommit,branch,commitSha,diff,changedFiles:input.changes.map(c=>c.path),completedAt:this.clock.now()};
  }
}
export * from './command-policy.js';
export * from './command-runner.js';
export * from './test-engine.js';
export * from './reviewer.js';
