import { PolicyViolation } from '../../core/src/errors.js';
import type { CommandCategory } from '../../schemas/src/index.js';

const destructive=new Set(['rm','rmdir','del','format','mkfs','shutdown','reboot']);
const allowed:Record<string,CommandCategory>={node:'TEST',pnpm:'BUILD',npm:'BUILD',npx:'BUILD',tsc:'BUILD',vitest:'TEST',git:'READ',supabase:'MIGRATION',gh:'NETWORK'};
const gradleTaskIsTest=(task:string)=>task==='test'||task==='check'||/test$/i.test(task);
export class CommandPolicy {
  classify(command:string,args:string[]):CommandCategory{
    const base=command.split(/[\\/]/).pop()??command;
    const name=base.toLowerCase().replace(/\.exe$|\.bat$/,'');
    if(destructive.has(name))return 'DESTRUCTIVE';
    if(args.some(a=>/[;&|><`]/.test(a)))return 'UNKNOWN';
    if(name==='git'&&['push','fetch','pull','clone','ls-remote'].includes(args[0]??''))return 'NETWORK';
    if(name==='git'&&args[0]==='remote'&&['add','set-url','remove','rename'].includes(args[1]??''))return 'BUILD';
    if(name==='git'&&args[0]==='config')return 'BUILD';
    if(name==='git'&&args[0]==='branch'&&args[1]==='--show-current')return 'READ';
    if(name==='git'&&['checkout','switch','branch','add','commit','cherry-pick','merge','restore'].includes(args[0]??''))return 'BUILD';
    if(name==='pnpm'||name==='npm'||name==='npx')return (args[0]==='test'||args.includes('vitest'))?'TEST':'BUILD';
    if(name==='gradlew'||name==='gradle')return args.some(gradleTaskIsTest)?'TEST':'BUILD';
    return allowed[name]??'UNKNOWN';
  }
  assertAllowed(command:string,args:string[],allowedCategories:CommandCategory[]){const category=this.classify(command,args);if(category==='UNKNOWN'||category==='DESTRUCTIVE'||!allowedCategories.includes(category))throw new PolicyViolation('Command is not allowed',{command,args,category});return category;}
}
