import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { deploymentSnapshotSchema, makePortableSnapshot } from './deployment-state.js';

const input=resolve(process.env['AUTOPILOT_EXPORT_STATE_INPUT']??'.autopilot/state.json');
const output=resolve(process.env['AUTOPILOT_EXPORT_STATE_OUTPUT']??'deployment/bootstrap-state.json');
const snapshot=deploymentSnapshotSchema.parse(JSON.parse(await readFile(input,'utf8')));
const portable=makePortableSnapshot(snapshot);
await mkdir(dirname(output),{recursive:true});
await writeFile(output,`${JSON.stringify(portable,null,2)}\n`,{encoding:'utf8',mode:0o600});
console.log(JSON.stringify({level:'info',event:'deployment.state_exported',output,counts:{
  projects:portable.projects.length,
  resources:portable.resources.length,
  tasks:portable.tasks.length,
  artifacts:portable.artifacts.length,
  runs:portable.runs.length,
  audit:portable.audit.length,
}}));
