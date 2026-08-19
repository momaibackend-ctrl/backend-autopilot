import { spawn } from 'node:child_process';
import type { Clock } from '../../core/src/ports.js';
import type { CommandCategory, CommandRecord } from '../../schemas/src/index.js';
import type { CommandPolicy } from './command-policy.js';

export interface CommandResult {record:CommandRecord;stdout:string;stderr:string;}
export class CommandRunner {
  private journal=new Map<string,CommandResult[]>();
  constructor(private policy:CommandPolicy,private clock:Clock){}
  async run(input:{command:string;args:string[];cwd:string;taskId:string;allowed:CommandCategory[];env?:Record<string,string>;sensitiveArgIndexes?:number[];stdin?:string}):Promise<CommandResult>{
    const category=this.policy.assertAllowed(input.command,input.args,input.allowed);const startedAt=this.clock.now();
    const result=await new Promise<{exitCode:number;stdout:string;stderr:string}>((resolve,reject)=>{
      const child=spawn(input.command,input.args,{cwd:input.cwd,shell:false,windowsHide:true,env:{...process.env,...input.env}});let stdout='',stderr='';if(input.stdin!==undefined)child.stdin.end(input.stdin);
      child.stdout.on('data',(v:Buffer)=>stdout+=v.toString());child.stderr.on('data',(v:Buffer)=>stderr+=v.toString());child.on('error',reject);child.on('close',code=>resolve({exitCode:code??-1,stdout,stderr}));
    });
    const loggedArgs=input.args.map((arg,index)=>input.sensitiveArgIndexes?.includes(index)?'[REDACTED]':arg);const entry={record:{command:[input.command,...loggedArgs],cwd:input.cwd,startedAt,finishedAt:this.clock.now(),exitCode:result.exitCode,taskId:input.taskId,category},stdout:result.stdout,stderr:result.stderr};this.journal.set(input.taskId,[...(this.journal.get(input.taskId)??[]),entry]);return entry;
  }
  drain(taskId:string){const entries=this.journal.get(taskId)??[];this.journal.delete(taskId);return entries;}
}
