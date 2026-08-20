import 'dotenv/config';
import type { StateStore } from './ports.js';
import { systemClock, uuidGenerator } from './ports.js';
import { FileStateStore, MemoryStateStore, PostgresStateStore } from '../../project-registry/src/index.js';
import { CommandPolicy, CommandRunner, ExecutionEngine, TestEngine } from '../../execution-engine/src/index.js';
import { LocalGitAdapter } from '../../adapters/git/src/index.js';
import { AutopilotService } from './application.js';
import { DotEnvSecretProvider } from './secrets.js';
import { LiveGitHubAdapter } from '../../adapters/github/src/index.js';
import { ExternalPostgresAdapter } from '../../adapters/database/src/index.js';
import { LiveSupabaseCliAdapter, SupabaseManagementApiAdapter } from '../../adapters/supabase/src/index.js';
import { RuntimeCapabilityProbe, SandboxBootstrapService } from '../../bootstrap/src/index.js';
import { OperatorConsoleService } from '../../operator-console/src/index.js';

export function createService(options:{store?:StateStore}={}){
  return createRuntime(options).service;
}
export function createRuntime(options:{store?:StateStore}={}){const store=options.store??createConfiguredStore();const commands=new CommandRunner(new CommandPolicy(),systemClock);const git=new LocalGitAdapter(commands);const tests=new TestEngine(commands,systemClock);const service=new AutopilotService({store,execution:new ExecutionEngine(git,systemClock),tests,git,commands});const secrets=new DotEnvSecretProvider();const github=new LiveGitHubAdapter(commands);const database=new ExternalPostgresAdapter(secrets);const supabase=new LiveSupabaseCliAdapter(commands,secrets);const supabaseApi=new SupabaseManagementApiAdapter(secrets,process.env['AUTOPILOT_SUPABASE_ACCESS_TOKEN_REF']??'SUPABASE_ACCESS_TOKEN');const capabilities=new RuntimeCapabilityProbe(store,secrets,systemClock);const bootstrap=new SandboxBootstrapService({store,clock:systemClock,ids:uuidGenerator,commands,secrets,github,supabase,supabaseApi,database,capabilities});const operator=new OperatorConsoleService({service,store,tests,commands,database,secrets,clock:systemClock,ids:uuidGenerator,capabilities:projectId=>capabilities.capture(projectId)});return {service,bootstrap,operator,store,secrets,providers:{github,database,supabase,supabaseApi}};}
function createConfiguredStore():StateStore {
  if(process.env['AUTOPILOT_STORE']==='memory')return new MemoryStateStore();
  const url=process.env['DATABASE_URL'];if(url)return new PostgresStateStore(url);const path=process.env['AUTOPILOT_STATE_PATH'];return path?new FileStateStore(path):new FileStateStore();
}
