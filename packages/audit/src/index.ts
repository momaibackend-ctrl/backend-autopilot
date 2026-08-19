import type { Clock, IdGenerator, StateStore } from '../../core/src/ports.js';

const secretPattern=/(token|secret|password|authorization|api[_-]?key)/i;
export function redact(value:unknown):unknown{
  if(Array.isArray(value))return value.map(redact);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,secretPattern.test(k)?'[REDACTED]':redact(v)]));
  if(typeof value==='string')return value.replace(/(?:gh[pousr]_|sbp_)[A-Za-z0-9_-]+/g,'[REDACTED]').replace(/(password|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi,'$1=[REDACTED]');
  return value;
}
export class AuditLog {
  constructor(private store:StateStore,private ids:IdGenerator,private clock:Clock){}
  async record(input:{actor:string;action:string;projectId:string;taskId?:string;resourceId?:string;input:unknown;result:unknown;reason:string;correlationId:string}){
    await this.store.appendAudit({id:this.ids.next(),actor:input.actor,action:input.action,projectId:input.projectId,...(input.taskId?{taskId:input.taskId}:{}),...(input.resourceId?{resourceId:input.resourceId}:{}),timestamp:this.clock.now(),input:redact(input.input),result:redact(input.result),reason:input.reason,correlationId:input.correlationId});
  }
}
