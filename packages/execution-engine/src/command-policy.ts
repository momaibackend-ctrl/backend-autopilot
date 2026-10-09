import { PolicyViolation } from '../../core/src/errors.js';
import type { CommandCategory } from '../../schemas/src/index.js';

const destructive=new Set(['rm','rmdir','del','format','mkfs','shutdown','reboot']);
const allowed:Record<string,CommandCategory>={node:'TEST',pnpm:'BUILD',npm:'BUILD',npx:'BUILD',tsc:'BUILD',vitest:'TEST',git:'READ',supabase:'MIGRATION',gh:'NETWORK'};
// Throwaway environments run the project's own code in containers. The container may do anything
// inside itself; what it may never get is the host: no privileged mode, no host namespaces, no
// added capabilities or devices, no Docker socket and no bind of a host system directory.
const dockerSubcommands=new Set(['run','exec','logs','rm','inspect','pull','version']);
const dockerResourceSubcommands:Record<string,Set<string>>={network:new Set(['create','rm']),volume:new Set(['create','rm'])};
const dockerForbiddenFlag=/^(--privileged|--pid|--ipc|--uts|--userns|--cgroupns|--cap-add|--device|--security-opt|--volumes-from|--add-host)(=|$)/;
const hostSystemPath=/(^|[\s=,])(source=)?\/(proc|sys|dev|etc|root|boot|var\/run|run|var\/lib\/docker)?(\/|:|,|$)/;
function dockerCategory(args:string[]):CommandCategory{
  const [sub='',action='']=args;
  if(!(dockerSubcommands.has(sub)||dockerResourceSubcommands[sub]?.has(action)))return 'UNKNOWN';
  for(const [index,arg] of args.entries()){
    if(dockerForbiddenFlag.test(arg))return 'UNKNOWN';
    if(/docker\.sock/.test(arg))return 'UNKNOWN';
    const previous=args[index-1]??'';
    if((previous==='--network'||previous==='--net')&&arg==='host')return 'UNKNOWN';
    if(/^--(network|net)=host$/.test(arg))return 'UNKNOWN';
    const mount=previous==='-v'||previous==='--volume'||previous==='--mount'?arg:/^--(volume|mount)=/.test(arg)?arg.slice(arg.indexOf('=')+1):undefined;
    // A bind of `/` or of a host system directory; a named volume or a workspace path is fine.
    if(mount!==undefined&&hostSystemPath.test(` ${mount}`))return 'UNKNOWN';
  }
  return 'ENVIRONMENT';
}
const gradleTaskIsTest=(task:string)=>task==='test'||task==='check'||/test$/i.test(task);
export class CommandPolicy {
  classify(command:string,args:string[]):CommandCategory{
    const base=command.split(/[\\/]/).pop()??command;
    const name=base.toLowerCase().replace(/\.exe$|\.bat$/,'');
    if(destructive.has(name))return 'DESTRUCTIVE';
    // The metacharacter scan is defence-in-depth only: every command is spawned with shell:false
    // (command-runner.ts) and nothing in this repository ever enables a shell, so `&`, `;`, `|`
    // and backticks reach the child process as inert literal argv entries and are never
    // interpreted. It still earns its place on argument positions that could name another
    // command, but a commit message is opaque human text carried straight through from the task
    // title -- and a title as ordinary as "Privacy & Consent Enforcement" (CORE-BE-11) made the
    // `-m` value trip this scan and fail the entire execution before a single command ran.
    const messageFlag=name==='git'&&args[0]==='commit'?args.findIndex(a=>a==='-m'||a==='--message'):-1;
    const opaqueValue=messageFlag>=0?messageFlag+1:-1;
    if(args.some((a,index)=>index!==opaqueValue&&/[;&|><`]/.test(a)))return 'UNKNOWN';
    if(name==='git'&&['push','fetch','pull','clone','ls-remote'].includes(args[0]??''))return 'NETWORK';
    if(name==='git'&&args[0]==='remote'&&['add','set-url','remove','rename'].includes(args[1]??''))return 'BUILD';
    if(name==='git'&&args[0]==='config')return 'BUILD';
    if(name==='git'&&args[0]==='branch'&&args[1]==='--show-current')return 'READ';
    if(name==='git'&&['checkout','switch','branch','add','commit','cherry-pick','merge','restore'].includes(args[0]??''))return 'BUILD';
    if(name==='pnpm'||name==='npm'||name==='npx')return (args[0]==='test'||(args[0]??'').startsWith('test:')||args.includes('vitest'))?'TEST':'BUILD';
    if(name==='docker')return dockerCategory(args);
    if(name==='gradlew'||name==='gradle')return args.some(gradleTaskIsTest)?'TEST':'BUILD';
    return allowed[name]??'UNKNOWN';
  }
  assertAllowed(command:string,args:string[],allowedCategories:CommandCategory[]){const category=this.classify(command,args);if(category==='UNKNOWN'||category==='DESTRUCTIVE'||!allowedCategories.includes(category))throw new PolicyViolation('Command is not allowed',{command,args,category});return category;}
}
