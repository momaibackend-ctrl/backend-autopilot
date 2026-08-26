import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock } from '../../core/src/ports.js';
import type { ImplementationPlan, TestReport } from '../../schemas/src/index.js';
import type { CommandRunner } from './command-runner.js';

const files:Record<ImplementationPlan['testsRequired'][number],string>={UNIT:'tests/unit.test.js',INTEGRATION:'tests/integration.test.js',CONTRACT:'tests/contract.test.js',MIGRATION:'tests/migration.test.js',SECURITY:'tests/security.test.js',REGRESSION:'tests/regression.test.js'};
const scripts:Partial<Record<ImplementationPlan['testsRequired'][number],string>>={UNIT:'test:unit',INTEGRATION:'test:integration',SECURITY:'test:security'};
export class TestEngine {
  constructor(private commands:CommandRunner,private clock:Clock){}
  async run(workspace:string,taskId:string,plan:ImplementationPlan):Promise<TestReport>{
    const suites:TestReport['suites']=[];
    let packageScripts:Record<string,string>={};
    try{const pkg=JSON.parse(await readFile(join(workspace,'package.json'),'utf8')) as {scripts?:Record<string,string>};packageScripts=pkg.scripts??{};}catch{}
    for(const type of plan.testsRequired){
      const preferred=scripts[type];
      const script=preferred&&packageScripts[preferred]?preferred:packageScripts.test?'test':undefined;
      if(script){const r=await this.commands.run({command:'pnpm',args:[script],cwd:workspace,taskId,allowed:['TEST']});suites.push({type,command:r.record.command,passed:r.record.exitCode===0,exitCode:r.record.exitCode});continue;}
      const file=files[type];try{await access(join(workspace,file));}catch{suites.push({type,command:['node','--test',file],passed:false,exitCode:-1});continue;}const r=await this.commands.run({command:'node',args:['--test',file],cwd:workspace,taskId,allowed:['TEST']});suites.push({type,command:r.record.command,passed:r.record.exitCode===0,exitCode:r.record.exitCode});
    }
    return {passed:suites.length===plan.testsRequired.length&&suites.every(s=>s.passed),suites,finishedAt:this.clock.now()};
  }
}
