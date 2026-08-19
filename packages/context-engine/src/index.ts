import { createHash } from 'node:crypto';
import type { Clock, IdGenerator, StateStore } from '../../core/src/ports.js';
import type { ContextSectionType, ProjectContext } from '../../schemas/src/index.js';
import { projectContextSchema } from '../../schemas/src/index.js';

export interface ContextImport {type:ContextSectionType;content:unknown;sourceType:'TASK_SOURCE'|'FILE'|'MCP'|'USER'|'REPOSITORY'|'DECISION';sourceRef:string;}
export class ContextEngine {
  constructor(private store:StateStore,private ids:IdGenerator,private clock:Clock){}
  async import(projectId:string,items:ContextImport[]):Promise<ProjectContext>{
    const previous=await this.store.getLatestContext(projectId);
    const version=String(Number(previous?.version??0)+1);
    const context=projectContextSchema.parse({id:this.ids.next(),projectId,version,createdAt:this.clock.now(),sections:[...(previous?.sections??[]),...items.map(item=>({
      id:this.ids.next(),type:item.type,content:item.content,provenance:{sourceType:item.sourceType,sourceRef:item.sourceRef,importedAt:this.clock.now(),contentHash:hash(item.content),trustedAsInstructions:false}
    }))]});
    return this.store.saveContext(context);
  }
}
function hash(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
