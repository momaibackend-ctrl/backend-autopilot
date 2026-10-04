import { mkdir, writeFile } from 'node:fs/promises';
import { issueConsoleToken, slowSecretEqual, verifyConsoleToken } from '../packages/operator-console/src/console-auth.js';

const seed=20261004;
let state=seed>>>0;
const next=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/2**32;};
const makeText=(length:number)=>Array.from({length},()=>String.fromCharCode(33+Math.floor(next()*90))).join('');
let generatedCases=0;

for(let i=0;i<32;i++){
  const left=makeText(16);
  const right=left.slice(0,-1)+(left.at(-1)==='!'?'?':'!');
  if(!await slowSecretEqual(left,left))throw new Error('equality invariant failed');
  if(await slowSecretEqual(left,right))throw new Error('inequality invariant failed');
  generatedCases+=2;
}
for(let i=0;i<64;i++){
  const subject='operator-'+makeText(6);
  const material=crypto.randomUUID()+crypto.randomUUID();
  const now=1_800_000_000+Math.floor(next()*100_000);
  const ttl=60+Math.floor(next()*(12*60*60-60));
  const token=await issueConsoleToken({subject,nowSeconds:now,ttlSeconds:ttl,signingMaterial:material});
  const valid=await verifyConsoleToken(token,{subject,nowSeconds:now,maxTtlSeconds:12*60*60,signingMaterial:material});
  if(!valid||valid.exp!==now+ttl)throw new Error('round-trip invariant failed');
  if(await verifyConsoleToken(token,{subject,nowSeconds:now+ttl,maxTtlSeconds:12*60*60,signingMaterial:material}))throw new Error('expiry invariant failed');
  generatedCases+=2;
}
await mkdir('reports',{recursive:true});
await writeFile('reports/property-based-report.json',JSON.stringify({
  framework:'UNKNOWN',properties:4,generatedCases,shrinking:false,replaySeeds:[String(seed)],counterexamples:0
},null,2));
console.log(`console auth property checks passed: ${generatedCases} cases`);
