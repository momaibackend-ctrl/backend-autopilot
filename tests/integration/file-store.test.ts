import { afterEach,describe,expect,it } from 'vitest';import { mkdtemp,rm } from 'node:fs/promises';import { join } from 'node:path';import { tmpdir } from 'node:os';import { FileStateStore } from '../../packages/project-registry/src/file-store.js';import { createService } from '../../packages/core/src/runtime.js';
let root:string|undefined;afterEach(async()=>{if(root)await rm(root,{recursive:true,force:true});root=undefined;});describe('file bootstrap store',()=>{it('survives process-style reconstruction without Docker',async()=>{root=await mkdtemp(join(tmpdir(),'autopilot-file-store-'));const path=join(root,'state.json');const first=createService({store:new FileStateStore(path)});const project=await first.projectCreate({name:'Durable bootstrap',slug:'durable-bootstrap',sourceType:'LOCAL',environment:'STAGING',autonomyMode:'AUTONOMOUS_STAGING',workspacePath:root});const second=createService({store:new FileStateStore(path)});expect(await second.projectGet(project.id)).toEqual(project);});});

describe('file bootstrap store missions',()=>{
  it('keeps missions across reconstruction, with the key unique per project',async()=>{
    root=await mkdtemp(join(tmpdir(),'autopilot-file-missions-'));const path=join(root,'state.json');
    const first=new FileStateStore(path);const service=createService({store:first});
    const project=await service.projectCreate({name:'Missions',slug:'missions',sourceType:'LOCAL',environment:'SANDBOX',autonomyMode:'AUTONOMOUS_STAGING',workspacePath:root});
    const now=new Date().toISOString();
    const mission={id:crypto.randomUUID(),projectId:project.id,key:'PARITY',title:'Port matches',goal:{kind:'DELIVERY' as const,targetResourceId:crypto.randomUUID()},taskIds:[],status:'ACTIVE' as const,createdAt:now,updatedAt:now};
    await first.createMission(mission);
    await first.updateMission({...mission,status:'ACHIEVED',achievedAt:now});
    const second=new FileStateStore(path);
    expect(await second.listMissions(project.id)).toEqual([{...mission,status:'ACHIEVED',achievedAt:now}]);
    await expect(second.createMission({...mission,id:crypto.randomUUID()})).rejects.toMatchObject({code:'CONFLICT'});
  });
});
