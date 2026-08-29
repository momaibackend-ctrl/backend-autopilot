import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock } from '../../core/src/ports.js';
import type { ImplementationPlan, TestReport } from '../../schemas/src/index.js';
import type { CommandRunner } from './command-runner.js';
import { buildPropertyBasedReport, parsePropertyRunnerOutput } from './property-based-report.js';
import { readPropertyReportFile } from './gradle-test-engine.js';

const files:Record<ImplementationPlan['testsRequired'][number],string>={UNIT:'tests/unit.test.js',INTEGRATION:'tests/integration.test.js',PROPERTY:'tests/property.test.js',CONTRACT:'tests/contract.test.js',MIGRATION:'tests/migration.test.js',SECURITY:'tests/security.test.js',REGRESSION:'tests/regression.test.js'};
const scripts:Partial<Record<ImplementationPlan['testsRequired'][number],string>>={UNIT:'test:unit',INTEGRATION:'test:integration',PROPERTY:'test:property',SECURITY:'test:security'};
export class TestEngine {
  constructor(private commands:CommandRunner,private clock:Clock){}
  async run(workspace:string,taskId:string,plan:ImplementationPlan):Promise<TestReport>{
    const suites:TestReport['suites']=[];
    let packageScripts:Record<string,string>={};
    try{const pkg=JSON.parse(await readFile(join(workspace,'package.json'),'utf8')) as {scripts?:Record<string,string>};packageScripts=pkg.scripts??{};}catch(error){
      // Silently falling through to the file-existence suite below (tests/unit.test.js etc.) is
      // correct for a genuinely missing package.json, but swallowing the real reason otherwise
      // makes every other read failure indistinguishable from that -- and, precisely because the
      // suites below never shell out, leaves no COMMAND_LOG evidence either. Log the real cause so
      // a future occurrence is diagnosable from the raw job log instead of another guessing session.
      console.log(JSON.stringify({level:'warn',event:'test_engine.package_json_unreadable',workspace,taskId,error:error instanceof Error?error.message:String(error)}));
    }
    // fast-check prints nothing at all on a passing run, so a green PROPERTY suite proves only
    // that some file ran. The transcript is kept and, if it says nothing, the project's own
    // reports/property-based-report.json is read -- and if neither exists the layer is UNVERIFIED.
    let propertyTranscript='';
    for(const type of plan.testsRequired){
      const preferred=scripts[type];
      const script=preferred&&packageScripts[preferred]?preferred:packageScripts.test?'test':undefined;
      if(script){const r=await this.commands.run({command:'pnpm',args:[script],cwd:workspace,taskId,allowed:['TEST']});if(type==='PROPERTY')propertyTranscript+=`
${r.stdout}`;suites.push({type,command:r.record.command,passed:r.record.exitCode===0,exitCode:r.record.exitCode});continue;}
      const file=files[type];try{await access(join(workspace,file));}catch{suites.push({type,command:['node','--test',file],passed:false,exitCode:-1});continue;}const r=await this.commands.run({command:'node',args:['--test',file],cwd:workspace,taskId,allowed:['TEST']});if(type==='PROPERTY')propertyTranscript+=`
${r.stdout}`;suites.push({type,command:r.record.command,passed:r.record.exitCode===0,exitCode:r.record.exitCode});
    }
    const propertyRequired=plan.testsRequired.includes('PROPERTY');
    const fromOutput=propertyTranscript?parsePropertyRunnerOutput(propertyTranscript):undefined;
    const fromFile=fromOutput?undefined:await readPropertyReportFile(workspace);
    const propertyBased=buildPropertyBasedReport({required:propertyRequired,suitePassed:suites.find(s=>s.type==='PROPERTY')?.passed===true,parsed:fromOutput??fromFile,source:fromOutput?'PARSED_RUNNER_OUTPUT':fromFile?'REPORT_FILE':'NONE'});
    const gated=propertyRequired?suites.map(s=>s.type==='PROPERTY'?{...s,passed:propertyBased.status==='PASS',exitCode:propertyBased.status==='PASS'?0:s.exitCode||1}:s):suites;
    return {passed:gated.length===plan.testsRequired.length&&gated.every(s=>s.passed),suites:gated,...(propertyRequired||propertyBased.evidence!=='NONE'?{propertyBased}:{}),finishedAt:this.clock.now()};
  }
}
