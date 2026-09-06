import { describe,expect,it } from 'vitest';
import { LiveGitHubAdapter } from '../../packages/adapters/github/src/index.js';
import type { CommandRunner } from '../../packages/execution-engine/src/command-runner.js';

const projectId=crypto.randomUUID();
const repository={resourceId:crypto.randomUUID(),type:'GITHUB_REPOSITORY' as const,provider:'github',externalReference:'AICorn-Rocket-Group/momna-backend',projectId,environment:'SANDBOX' as const,permissions:['READ' as const,'WRITE' as const,'ADMIN' as const],status:'ACTIVE' as const,secretRefs:[],createdAt:new Date().toISOString()};

describe('organization repository ADMIN collaborator write guard',()=>{
  it('allows a non-owner identity with live ADMIN permission on the exact registered repository',async()=>{
    const calls:Array<{command:string;args:string[]}>=[];
    const commands={run:async(input:{command:string;args:string[]})=>{
      calls.push({command:input.command,args:input.args});
      if(input.command==='gh'&&input.args[0]==='api')return {record:{exitCode:0},stdout:'momaibackend-ctrl\n',stderr:''};
      if(input.command==='gh'&&input.args[0]==='repo'&&input.args[1]==='view')return {record:{exitCode:0},stdout:'ADMIN\n',stderr:''};
      if(input.command==='git'&&input.args[0]==='push')return {record:{exitCode:0},stdout:'',stderr:''};
      throw new Error(`unexpected command: ${input.command} ${input.args.join(' ')}`);
    }} as unknown as CommandRunner;
    const result=await new LiveGitHubAdapter(commands).push(repository,{workspace:process.cwd(),branch:'autopilot/test-org-admin',correlationId:projectId});
    expect(result).toEqual({success:true,branch:'autopilot/test-org-admin'});
    expect(calls).toContainEqual({command:'gh',args:['repo','view',repository.externalReference,'--json','viewerPermission','--jq','.viewerPermission']});
  });

  it('rejects a non-owner identity without live ADMIN permission',async()=>{
    const commands={run:async(input:{command:string;args:string[]})=>{
      if(input.command==='gh'&&input.args[0]==='api')return {record:{exitCode:0},stdout:'momaibackend-ctrl\n',stderr:''};
      if(input.command==='gh'&&input.args[0]==='repo'&&input.args[1]==='view')return {record:{exitCode:0},stdout:'WRITE\n',stderr:''};
      throw new Error(`unexpected command: ${input.command} ${input.args.join(' ')}`);
    }} as unknown as CommandRunner;
    await expect(new LiveGitHubAdapter(commands).push(repository,{workspace:process.cwd(),branch:'autopilot/test-org-write',correlationId:projectId})).rejects.toMatchObject({code:'HUMAN_ACTION_REQUIRED',details:{expectedOwner:'AICorn-Rocket-Group',actual:'momaibackend-ctrl',repository:repository.externalReference,viewerPermission:'WRITE'}});
  });

  it('fails closed when the live repository permission lookup fails',async()=>{
    const commands={run:async(input:{command:string;args:string[]})=>{
      if(input.command==='gh'&&input.args[0]==='api')return {record:{exitCode:0},stdout:'momaibackend-ctrl\n',stderr:''};
      if(input.command==='gh'&&input.args[0]==='repo'&&input.args[1]==='view')return {record:{exitCode:1},stdout:'',stderr:'forbidden'};
      throw new Error(`unexpected command: ${input.command} ${input.args.join(' ')}`);
    }} as unknown as CommandRunner;
    await expect(new LiveGitHubAdapter(commands).push(repository,{workspace:process.cwd(),branch:'autopilot/test-org-permission-failure',correlationId:projectId})).rejects.toMatchObject({code:'HUMAN_ACTION_REQUIRED',details:{repository:repository.externalReference}});
  });
});
