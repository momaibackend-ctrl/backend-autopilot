import { describe,expect,it } from 'vitest';
import type { DeploymentSnapshot } from '../../scripts/deployment-state.js';
import { assertSecretFree, makePortableSnapshot, materializeSnapshot } from '../../scripts/deployment-state.js';

const now='2026-08-21T00:00:00.000Z';
function snapshot():DeploymentSnapshot{return {
  projects:[{id:'11111111-1111-4111-8111-111111111111',name:'Sandbox',slug:'sandbox',sourceType:'LOCAL',environment:'STAGING',autonomyMode:'AUTONOMOUS_STAGING',status:'ACTIVE',workspacePath:'C:\\Users\\owner\\sandbox',createdAt:now,updatedAt:now}],
  resources:[{resourceId:'22222222-2222-4222-8222-222222222222',type:'GIT_REPOSITORY',provider:'local',externalReference:'C:\\Users\\owner\\sandbox',projectId:'11111111-1111-4111-8111-111111111111',environment:'SANDBOX',permissions:['READ','WRITE'],status:'ACTIVE',secretRefs:[],createdAt:now}],
  contexts:[],tasks:[],artifacts:[],runs:[],transitions:[],audit:[],
};}

describe('deployment state portability',()=>{
  it('removes Windows workspace paths and materializes a server root',()=>{
    const portable=makePortableSnapshot(snapshot());
    expect(JSON.stringify(portable)).not.toContain('C:\\\\Users');
    expect(portable.projects[0]?.workspacePath).toContain('${AUTOPILOT_WORKSPACE_ROOT}');
    const remote=materializeSnapshot(portable,'/data/workspaces');
    expect(remote.projects[0]?.workspacePath.replaceAll('\\','/')).toMatch(/\/data\/workspaces\/sandbox$/);
    expect(remote.resources[0]?.externalReference).toBe(remote.projects[0]?.workspacePath);
  });
  it('rejects credential-shaped state',()=>{
    expect(()=>assertSecretFree({value:'ghp_abcdefghijklmnopqrstuvwxyz123456'})).toThrow(/credential-shaped/);
    expect(()=>assertSecretFree({value:'postgresql://user:plain-password@host/db'})).toThrow(/credential-shaped/);
  });
});
