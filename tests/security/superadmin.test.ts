import { describe, expect, it } from "vitest";
import { SuperadminService } from "../../packages/superadmin/src/index.js";
import { testService } from "../helpers/service.js";

const superadmin={actor:"test-superadmin",role:"SUPERADMIN" as const};
const operator={actor:"test-operator",role:"PROJECT_OPERATOR" as const};

async function fixture(){
  const {store,service}=testService();
  const system=await service.projectCreate({name:"System",slug:"system",sourceType:"TEST",environment:"SANDBOX",autonomyMode:"AUTONOMOUS_STAGING",workspacePath:""});
  const admin=new SuperadminService({store,service,systemProjectId:system.id});
  return {store,service,system,admin};
}

describe("SUPERADMIN semantic control",()=>{
  it("is global but cannot bypass production, arbitrary Git registration, or READY gates",async()=>{
    const {admin}=await fixture();
    await expect(admin.systemOverview(operator)).rejects.toMatchObject({code:"POLICY_VIOLATION"});
    await expect(admin.projectCreate(superadmin,{name:"Production",slug:"production",sourceType:"MCP",environment:"PRODUCTION",autonomyMode:"OBSERVE",workspacePath:""},"project-prod-1")).rejects.toMatchObject({code:"NOT_SUPPORTED"});
    const created=await admin.projectCreate(superadmin,{name:"Temporary",slug:"temporary",sourceType:"MCP",environment:"SANDBOX",autonomyMode:"AUTONOMOUS_STAGING",workspacePath:""},"project-create-1");
    const project=created.value as {id:string};
    expect(()=>admin.resourceCreate(superadmin,{projectId:project.id,type:"GITHUB_REPOSITORY",provider:"github",externalReference:"someone/arbitrary",environment:"SANDBOX",permissions:["READ"],secretRefs:[],status:"ACTIVE"},"resource-create-1")).toThrowError(expect.objectContaining({code:"POLICY_VIOLATION"}));
    const taskResult=await admin.taskCreate(superadmin,{projectId:project.id,externalKey:"TEMP-1",title:"Initial",description:"Data",requirements:["One"],relationships:[]},"task-create-1");
    const task=taskResult.value as {id:string};
    await admin.taskUpdate(superadmin,project.id,task.id,{title:"Updated",requirements:["One","Two"]},"task-update-1");
    await expect(admin.taskTransition(superadmin,project.id,task.id,"READY","Try to bypass readiness","task-ready-1")).rejects.toMatchObject({code:"INVALID_STATE"});
    expect(()=>admin.settingUpsert(superadmin,{key:"safety.production_writes",value:"ENABLED",description:"attack",visibility:"PUBLIC"},"setting-unsafe-1")).toThrowError(/NOT_SUPPORTED/);
  });

  it("persists screen content, validation, audit tool identity, idempotency, and safe tombstones",async()=>{
    const {store,admin}=await fixture();
    const created=await admin.projectCreate(superadmin,{name:"Console E2E",slug:"console-e2e",sourceType:"MCP",environment:"SANDBOX",autonomyMode:"AUTONOMOUS_STAGING",workspacePath:""},"project-create-2");
    const project=created.value as {id:string;slug:string};
    const replay=await admin.projectCreate(superadmin,{name:"Console E2E",slug:"console-e2e",sourceType:"MCP",environment:"SANDBOX",autonomyMode:"AUTONOMOUS_STAGING",workspacePath:""},"project-create-2");
    expect(replay.idempotentReplay).toBe(true);
    const taskResult=await admin.taskCreate(superadmin,{projectId:project.id,externalKey:"E2E-1",title:"Lifecycle",description:"Remote",requirements:["Observable"],relationships:[]},"task-create-2");
    const task=taskResult.value as {id:string};
    await admin.validationRun(superadmin,project.id,{taskId:task.id,suite:"SMOKE",operationId:"validation-run-2"});
    const screen=await admin.screenUpsert(superadmin,{screenId:"dashboard",navigationLabel:"Dashboard",title:"Superadmin proof",description:"Remote MCP controlled",enabled:true,navigationOrder:10,blocks:[{id:"proof",type:"TEXT",title:"v0.5",content:"Semantic MCP content"}]},"screen-update-2");
    expect((screen.value as {title:string}).title).toBe("Superadmin proof");
    const events=await store.listAudit(project.id);
    expect(events.some(value=>value.action==="mcp.task_create"&&value.actor==="test-superadmin")).toBe(true);
    expect(events.some(value=>value.action==="mcp.validation_run")).toBe(true);
    await admin.taskDelete(superadmin,project.id,task.id,{operationId:"task-delete-2",confirmation:"DELETE_TASK",reason:"Remove temporary E2E data"});
    expect((await admin.taskGet(superadmin,project.id,task.id)).deletedAt).toBeTruthy();
    await admin.projectDelete(superadmin,project.id,project.slug,{operationId:"project-delete-2",confirmation:"ARCHIVE_PROJECT",reason:"Remove temporary E2E project"});
    expect((await admin.projectGet(superadmin,project.id)).status).toBe("ARCHIVED");
  });
});
