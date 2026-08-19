import 'dotenv/config';
import type { StateStore } from './ports.js';
import { systemClock } from './ports.js';
import { MemoryStateStore, PostgresStateStore } from '../../project-registry/src/index.js';
import { CommandPolicy, CommandRunner, ExecutionEngine, TestEngine } from '../../execution-engine/src/index.js';
import { LocalGitAdapter } from '../../adapters/git/src/index.js';
import { AutopilotService } from './application.js';

export function createService(options:{store?:StateStore}={}){
  const store=options.store??createConfiguredStore();const commands=new CommandRunner(new CommandPolicy(),systemClock);const git=new LocalGitAdapter(commands);return new AutopilotService({store,execution:new ExecutionEngine(git,systemClock),tests:new TestEngine(commands,systemClock),git,commands});
}
function createConfiguredStore():StateStore {
  if(process.env['AUTOPILOT_STORE']==='memory')return new MemoryStateStore();
  const url=process.env['DATABASE_URL'];if(!url)throw new Error('DATABASE_URL is required for persistent runtime. Use AUTOPILOT_STORE=memory only for tests/local diagnostics.');return new PostgresStateStore(url);
}
