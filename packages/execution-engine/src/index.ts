import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import type { Clock, GitWorkspaceAdapter } from '../../core/src/ports.js';
import { ExecutionFailed } from '../../core/src/errors.js';
import type { FileChange, Task } from '../../schemas/src/index.js';
import { deterministicTaskBranch } from '../../core/src/branch.js';
import { detectHardcodedSecret } from '../../secret-scanner/src/index.js';

export class ExecutionEngine {
  constructor(private git:GitWorkspaceAdapter,private clock:Clock){}
  async execute(input:{workspace:string;task:Task;changes:FileChange[]}){
    const root=resolve(input.workspace);const snapshot=await this.git.snapshot(root,input.task.id);const branch=deterministicTaskBranch(input.task);
    if(snapshot.branch!==branch)await this.git.branch(root,input.task.id,branch);
    for(const change of input.changes){const target=resolve(root,change.path);const rel=relative(root,target);if(rel.startsWith(`..${sep}`)||rel==='..'||rel.startsWith(sep))throw new ExecutionFailed('File change escapes project workspace',{path:change.path});if(detectHardcodedSecret(change.path,change.content))throw new ExecutionFailed('Potential secret material in file change is forbidden',{path:change.path});await mkdir(dirname(target),{recursive:true});await writeFile(target,change.content,'utf8');}
    await this.git.stage(root,input.task.id);const diff=await this.git.diff(root,input.task.id,snapshot.baseCommit);if(!diff.trim())throw new ExecutionFailed('Implementation produced no diff');const commitSha=await this.git.commit(root,input.task.id,`autopilot: ${input.task.externalKey} ${input.task.title}`);
    return {baseCommit:snapshot.baseCommit,branch,commitSha,diff,changedFiles:input.changes.map(c=>c.path),completedAt:this.clock.now()};
  }
}
export * from './command-policy.js';
export * from './command-runner.js';
export * from './test-engine.js';
export * from './gradle-test-engine.js';
export * from './stack-aware-test-executor.js';
export * from './stack-detection.js';
export * from './gradle-wrapper-provisioner.js';
export * from './disposable-workspace.js';
export * from './reviewer.js';
