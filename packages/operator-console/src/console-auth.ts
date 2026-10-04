const encoder=new TextEncoder();
const decoder=new TextDecoder();
const version='bac1';
const passwordKdfIterations=210_000;
const passwordKdfSalt=encoder.encode('backend-autopilot-console-auth-v1');

export type ConsoleSessionClaims={v:1;sub:string;iat:number;exp:number};

export async function slowSecretEqual(left:string,right:string){
  const [a,b]=await Promise.all([passwordDigest(left),passwordDigest(right)]);
  return constantTimeBytesEqual(a,b);
}

export async function issueConsoleToken(input:{subject:string;nowSeconds:number;ttlSeconds:number;signingMaterial:string}){
  const claims:ConsoleSessionClaims={v:1,sub:input.subject,iat:input.nowSeconds,exp:input.nowSeconds+input.ttlSeconds};
  const payload=base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const signature=await signatureFor(payload,input.signingMaterial);
  return `${version}.${payload}.${base64UrlEncode(signature)}`;
}

export async function verifyConsoleToken(token:string,input:{subject:string;nowSeconds:number;maxTtlSeconds:number;signingMaterial:string}):Promise<ConsoleSessionClaims|undefined>{
  const parts=token.split('.');
  if(parts.length!==3||parts[0]!==version)return undefined;
  const [,payload,signatureText]=parts;
  if(!payload||!signatureText)return undefined;
  let supplied:Uint8Array;
  try{supplied=base64UrlDecode(signatureText);}catch{return undefined;}
  const expected=await signatureFor(payload,input.signingMaterial);
  if(!constantTimeBytesEqual(expected,supplied))return undefined;
  let claims:Partial<ConsoleSessionClaims>;
  try{claims=JSON.parse(decoder.decode(base64UrlDecode(payload))) as Partial<ConsoleSessionClaims>;}catch{return undefined;}
  if(claims.v!==1||claims.sub!==input.subject||typeof claims.iat!=='number'||typeof claims.exp!=='number')return undefined;
  if(claims.exp<=input.nowSeconds||claims.iat>input.nowSeconds+60||claims.exp-claims.iat<=0||claims.exp-claims.iat>input.maxTtlSeconds)return undefined;
  return claims as ConsoleSessionClaims;
}

async function passwordDigest(value:string){
  const key=await crypto.subtle.importKey('raw',encoder.encode(value),'PBKDF2',false,['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:passwordKdfSalt,iterations:passwordKdfIterations},key,256));
}
async function signatureFor(payload:string,material:string){
  const root=await crypto.subtle.digest('SHA-256',encoder.encode(`backend-autopilot-console-session:${material}`));
  const key=await crypto.subtle.importKey('raw',root,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(payload)));
}
function constantTimeBytesEqual(left:Uint8Array,right:Uint8Array){
  if(left.length!==right.length)return false;
  let difference=0;
  for(let index=0;index<left.length;index++)difference|=left[index]!^right[index]!;
  return difference===0;
}
function base64UrlEncode(value:Uint8Array){
  let binary='';
  for(const byte of value)binary+=String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function base64UrlDecode(value:string){
  const normalized=value.replace(/-/g,'+').replace(/_/g,'/');
  const padded=normalized+'='.repeat((4-normalized.length%4)%4);
  const binary=atob(padded);
  return Uint8Array.from(binary,char=>char.charCodeAt(0));
}
