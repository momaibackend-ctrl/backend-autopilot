import { DependencyBlocked, InvalidState } from '../../core/src/errors.js';
import type { Clock, IdGenerator, StateStore } from '../../core/src/ports.js';
import type { Task, TaskState } from '../../schemas/src/index.js';

const transitions:Record<TaskState,TaskState[]>={
  INGESTED:['ANALYZING','BLOCKED'],ANALYZING:['PLANNED','BLOCKED','FAILED'],BLOCKED:['ANALYZING','PLANNED'],PLANNED:['IMPLEMENTING','BLOCKED'],
  IMPLEMENTING:['TESTING','FAILED','BLOCKED'],TESTING:['REVIEWING','IMPLEMENTING','BLOCKED','FAILED'],REVIEWING:['READY','IMPLEMENTING','BLOCKED','FAILED'],
  // READY is terminal for ordinary work. The one way out is re-verification of already-verified
  // work on a newer base (a merged dependency invalidated the base it was proven against), which
  // re-enters the identical IMPLEMENTING -> TESTING -> REVIEWING -> READY gate chain. Manual
  // superadmin transitions still cannot leave READY: that table is separate and unchanged.
  READY:['IMPLEMENTING'],FAILED:['ANALYZING','IMPLEMENTING']
};
export class DependencyEngine {
  constructor(private store:StateStore){}
  async assertReady(task:Task){
    const deps=task.relationships.filter(r=>r.type==='DEPENDS_ON');
    const blocked:string[]=[];
    for(const dep of deps){const t=await this.store.getTask(task.projectId,dep.targetTaskId);if(!t||t.state!=='READY')blocked.push(dep.targetTaskId);}
    if(blocked.length)throw new DependencyBlocked('Required task dependencies are not READY',{blocked});
    const conflicts=task.relationships.filter(r=>r.type==='CONFLICTS_WITH');
    for(const rel of conflicts){const t=await this.store.getTask(task.projectId,rel.targetTaskId);if(t&&t.state!=='FAILED')throw new DependencyBlocked('Conflicting task is active',{taskId:rel.targetTaskId});}
  }
}
export class WorkflowEngine {
  constructor(private store:StateStore,private ids:IdGenerator,private clock:Clock){}
  async transition(task:Task,to:TaskState,reason:string,actor:string,inputArtifactIds:string[]=[],outputArtifactIds:string[]=[]){
    if(!transitions[task.state].includes(to))throw new InvalidState(`Transition ${task.state} -> ${to} is not allowed`);
    const from=task.state;const updated={...task,state:to,updatedAt:this.clock.now()};
    return this.store.transitionTask(updated,{id:this.ids.next(),taskId:task.id,from,to,reason,actor,inputArtifactIds,outputArtifactIds,timestamp:this.clock.now()});
  }
}
