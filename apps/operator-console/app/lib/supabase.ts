"use client";
import { createClient } from '@supabase/supabase-js';

export const supabaseUrl=process.env['NEXT_PUBLIC_SUPABASE_URL']??'';
export const supabasePublishableKey=process.env['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY']??'';
const key=supabasePublishableKey;
export const localDevelopment=process.env['NEXT_PUBLIC_AUTOPILOT_LOCAL_DEV']==='true';
export const supabase=supabaseUrl&&key?createClient(supabaseUrl,key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}}):undefined;
export const controlApi=process.env['NEXT_PUBLIC_AUTOPILOT_CONTROL_API_URL']??'';
const consoleSessionStorageKey='backend-autopilot-console-session';
type ConsoleSession={token:string;expiresAt:string;user:{login:string;role:string}};

export async function consoleLogin(username:string,password:string){
  if(!controlApi)throw new Error('Remote Control API is not configured');
  const response=await fetch(`${controlApi}/v1/auth/login`,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({username,password}),
    cache:'no-store',
  });
  const body=await response.json().catch(()=>undefined) as ConsoleSession|{error?:{message?:string}}|undefined;
  if(!response.ok||!body||!('token' in body))throw new Error(body&&'error' in body?body.error?.message??'Invalid login or password':'Invalid login or password');
  localStorage.setItem(consoleSessionStorageKey,JSON.stringify({token:body.token,expiresAt:body.expiresAt}));
  return body.user;
}

export async function validateConsoleSession(){
  if(localDevelopment)return true;
  if(!controlApi)return false;
  const token=getConsoleSessionToken();
  if(!token)return false;
  try{
    const response=await fetch(`${controlApi}/v1/auth/session`,{headers:{authorization:`Bearer ${token}`},cache:'no-store'});
    if(response.ok)return true;
  }catch{
    clearConsoleSession();
    return false;
  }
  clearConsoleSession();
  return false;
}

export function clearConsoleSession(){
  if(typeof window!=='undefined')localStorage.removeItem(consoleSessionStorageKey);
}

export async function authorizedFetch(path:string,init:RequestInit={}){
  if(localDevelopment)return fetch(`/api/control${path}`,init);
  if(!controlApi)throw new Error('Remote Control API is not configured');
  const token=getConsoleSessionToken();
  if(!token)throw new Error('Operator authentication is required');
  const headers=new Headers(init.headers);
  headers.set('authorization',`Bearer ${token}`);
  if(init.body&&!headers.has('content-type'))headers.set('content-type','application/json');
  const response=await fetch(`${controlApi}${path}`,{...init,headers});
  if(response.status===401){
    clearConsoleSession();
    if(typeof window!=='undefined')window.dispatchEvent(new Event('autopilot:session-expired'));
  }
  return response;
}

function getConsoleSessionToken(){
  if(typeof window==='undefined')return '';
  const raw=localStorage.getItem(consoleSessionStorageKey);
  if(!raw)return '';
  try{
    const session=JSON.parse(raw) as {token?:string;expiresAt?:string};
    if(!session.token||!session.expiresAt||Date.parse(session.expiresAt)<=Date.now()){clearConsoleSession();return '';}
    return session.token;
  }catch{clearConsoleSession();return '';}
}
