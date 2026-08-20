import { PolicyViolation } from '../../core/src/errors.js';
import type { CommandCategory } from '../../schemas/src/index.js';

const destructive=new Set(['rm','rmdir','del','format','mkfs','shutdown','reboot']);
const allowed:Record<string,CommandCategory>={node:'TEST',pnpm:'BUILD',npm:'BUILD',npx:'BUILD',tsc:'BUILD',vitest:'TEST',git:'READ',supabase:'MIGRATION',gh:'NETWORK'};
export class CommandPolicy {
  classify(command:string,args:string[]):CommandCategory{
    const name=command.toLowerCase().replace(/\.exe$/,'');
    if(destructive.has(name))return 'DESTRUCTIVE';
    if(args.some(a=>/[;&|><`]/.test(a)))return 'UNKNOWN';
    if(name==='git'&&['push','fetch','pull','clone','ls-remote'].includes(args[0]??''))return 'NETWORK';
    if(name==='git'&&args[0]==='remote'&&['add','set-url','remove','rename'].includes(args[1]??''))return 'BUILD';
    if(name==='git'&&args[0]==='config')return 'BUILD';
    if(name==='git'&&args[0]==='branch'&&args[1]==='--show-current')return 'READ';
    if(name==='git'&&['checkout','switch','branch','add','commit'].includes(args[0]??''))return 'BUILD';
    if(name==='pnpm'||name==='npm'||name==='npx')return (args[0]==='test'||args.includes('vitest'))?'TEST':'BUILD';
    return allowed[name]??'UNKNOWN';
  }
  assertAllowed(command:string,args:string[],allowedCategories:CommandCategory[]){const category=this.classify(command,args);if(category==='UNKNOWN'||category==='DESTRUCTIVE'||!allowedCategories.includes(category))throw new PolicyViolation('Command is not allowed',{command,args,category});return category;}
}
