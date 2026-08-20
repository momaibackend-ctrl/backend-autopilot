import 'dotenv/config';
import type { StateStore } from './ports.js';
import { systemClock, uuidGenerator } from './ports.js';
import { FileStateStore, MemoryStateStore, PostgresStateStore } from '../../project-registry/src/index.js';
import { CommandPolicy, CommandRunner, ExecutionEngine, TestEngine } from '../../execution-engine/src/index.js';
import { LocalGitAdapter } from '../../adapters/git/src/index.js';
import { AutopilotService } from './application.js';
import { DotEnvSecretProvider } from './secrets.js';
import { LiveGitHubAdapter } from '../../adapters/github/src/index.js';
import { GitHubActionsDispatcher } from '../../adapters/github/src/actions-dispatcher.js';
import { ExternalPostgresAdapter } from '../../adapters/database/src/index.js';
import { LiveSupabaseCliAdapter, SupabaseManagementApiAdapter } from '../../adapters/supabase/src/index.js';
import { SupabaseStorageArtifactBlobStore } from '../../adapters/supabase/src/artifact-storage.js';
import { RuntimeCapabilityProbe, SandboxBootstrapService } from '../../bootstrap/src/index.js';
import { OperatorConsoleService } from '../../operator-console/src/index.js';
import { AsyncExecutionCoordinator, type ExecutionJobDispatcher } from './async-execution.js';

export function createService(options:{store?:StateStore;dispatcher?:ExecutionJobDispatcher}={}){
  return createRuntime(options).service;
}
export function createRuntime(options:{store?:StateStore;dispatcher?:ExecutionJobDispatcher}={}){const store=options.store??createConfiguredStore();const commands=new CommandRunner(new CommandPolicy(),systemClock);const git=new LocalGitAdapter(commands);const tests=new TestEngine(commands,systemClock);const artifactBlobs=createArtifactBlobs();const service=new AutopilotService({store,execution:new ExecutionEngine(git,systemClock),tests,git,commands,...(artifactBlobs?{artifactBlobs}: {})});const secrets=new DotEnvSecretProvider();const github=new LiveGitHubAdapter(commands);const database=new ExternalPostgresAdapter(secrets);const supabase=new LiveSupabaseCliAdapter(commands,secrets);const supabaseApi=new SupabaseManagementApiAdapter(secrets,process.env['AUTOPILOT_SUPABASE_ACCESS_TOKEN_REF']??'SUPABASE_ACCESS_TOKEN');const capabilities=new RuntimeCapabilityProbe(store,secrets,systemClock);const bootstrap=new SandboxBootstrapService({store,clock:systemClock,ids:uuidGenerator,commands,secrets,github,supabase,supabaseApi,database,capabilities});const operator=new OperatorConsoleService({service,store,tests,commands,database,secrets,clock:systemClock,ids:uuidGenerator,capabilities:projectId=>capabilities.capture(projectId)});const dispatcher=options.dispatcher??createConfiguredDispatcher();const asyncExecution=dispatcher?new AsyncExecutionCoordinator(store,dispatcher):undefined;return {service,bootstrap,operator,asyncExecution,store,secrets,providers:{github,database,supabase,supabaseApi}};}
function createArtifactBlobs(){const url=process.env['SUPABASE_URL'];const key=process.env['SUPABASE_SERVICE_ROLE_KEY'];return url&&key?new SupabaseStorageArtifactBlobStore(url,key):undefined;}
function createConfiguredDispatcher(){const token=process.env['AUTOPILOT_GITHUB_DISPATCH_TOKEN'];const repository=process.env['AUTOPILOT_CONTROL_REPOSITORY'];return token&&repository?new GitHubActionsDispatcher(token,repository,process.env['AUTOPILOT_EXECUTION_WORKFLOW']??'autopilot-execution.yml',process.env['AUTOPILOT_CONTROL_REF']??'autopilot/v0.4-remote-runtime'):undefined;}
function createConfiguredStore():StateStore {
  if(process.env['AUTOPILOT_STORE']==='memory')return new MemoryStateStore();
  const url=process.env['DATABASE_URL'];if(url)return new PostgresStateStore(url);const path=process.env['AUTOPILOT_STATE_PATH'];return path?new FileStateStore(path):new FileStateStore();
}
