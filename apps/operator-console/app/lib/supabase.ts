"use client";
import { createClient } from '@supabase/supabase-js';

const url=process.env['NEXT_PUBLIC_SUPABASE_URL']??'';
const key=process.env['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY']??'';
export const localDevelopment=process.env['NEXT_PUBLIC_AUTOPILOT_LOCAL_DEV']==='true';
export const supabase=url&&key?createClient(url,key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}}):undefined;
export const controlApi=process.env['NEXT_PUBLIC_AUTOPILOT_CONTROL_API_URL']??'';

export async function authorizedFetch(path:string,init:RequestInit={}){if(localDevelopment)return fetch(`/api/control${path}`,init);if(!supabase)throw new Error('Supabase Auth is not configured');if(!controlApi)throw new Error('Remote Control API is not configured');const {data}=await supabase.auth.getSession();if(!data.session)throw new Error('Operator authentication is required');const headers=new Headers(init.headers);headers.set('authorization',`Bearer ${data.session.access_token}`);headers.set('apikey',key);if(init.body&&!headers.has('content-type'))headers.set('content-type','application/json');return fetch(`${controlApi}${path}`,{...init,headers});}
