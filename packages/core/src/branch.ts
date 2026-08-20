import type { Task } from '../../schemas/src/index.js';

export function deterministicTaskBranch(task:Pick<Task,'externalKey'|'title'>){
  const slug=task.title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)||'task';
  return `autopilot/${task.externalKey}-${slug}`;
}
