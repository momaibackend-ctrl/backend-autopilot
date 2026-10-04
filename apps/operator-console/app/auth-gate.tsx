"use client";
import { useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { consoleLogin, localDevelopment, supabase, validateConsoleSession } from './lib/supabase';

export function AuthGate({children}:{children:ReactNode}){
  const [oauthRoute,setOauthRoute]=useState<boolean>();
  useEffect(()=>setOauthRoute(window.location.pathname.includes('/oauth-consent')),[]);
  if(oauthRoute===undefined)return <div className="authPage">Loading secure operator session…</div>;
  if(oauthRoute)return <OAuthAuthGate>{children}</OAuthAuthGate>;
  return <ConsolePasswordGate>{children}</ConsolePasswordGate>;
}

function ConsolePasswordGate({children}:{children:ReactNode}){
  const [authenticated,setAuthenticated]=useState<boolean|undefined>(localDevelopment?true:undefined);
  const [username,setUsername]=useState('annet');
  const [password,setPassword]=useState('');
  const [message,setMessage]=useState('');
  const [pending,setPending]=useState(false);

  useEffect(()=>{
    if(localDevelopment)return;
    let active=true;
    void validateConsoleSession().then(valid=>{if(active)setAuthenticated(valid);});
    const expired=()=>setAuthenticated(false);
    window.addEventListener('autopilot:session-expired',expired);
    return()=>{active=false;window.removeEventListener('autopilot:session-expired',expired);};
  },[]);

  if(authenticated===undefined)return <div className="authPage">Loading secure operator session…</div>;
  if(authenticated)return <>{children}</>;
  return <div className="authPage"><form className="authCard" onSubmit={async event=>{
    event.preventDefault();setPending(true);setMessage('');
    try{await consoleLogin(username,password);setPassword('');setAuthenticated(true);}
    catch(error){setMessage(error instanceof Error?error.message:'Sign-in failed');}
    finally{setPending(false);}
  }}>
    <span className="brandMark">BA</span>
    <h1>Backend Autopilot</h1>
    <p>Sign in to the Operator Console.</p>
    <label>Login<input type="text" required value={username} onChange={event=>setUsername(event.target.value)} autoComplete="username"/></label>
    <label>Password<input type="password" required value={password} onChange={event=>setPassword(event.target.value)} autoComplete="current-password"/></label>
    <button type="submit" disabled={pending}>{pending?'Signing in…':'Sign in'}</button>
    {message&&<p>{message}</p>}
  </form></div>;
}

function OAuthAuthGate({children}:{children:ReactNode}){
  const [session,setSession]=useState<Session|null|undefined>(localDevelopment?null:undefined);
  const [email,setEmail]=useState('');
  const [message,setMessage]=useState('');
  useEffect(()=>{
    if(localDevelopment)return;
    if(!supabase){setSession(null);return;}
    void supabase.auth.getSession().then(({data})=>setSession(data.session));
    const {data}=supabase.auth.onAuthStateChange((_event,value)=>setSession(value));
    return()=>data.subscription.unsubscribe();
  },[]);
  if(localDevelopment)return <>{children}</>;
  if(session===undefined)return <div className="authPage">Loading OAuth operator session…</div>;
  if(!session)return <div className="authPage"><form className="authCard" onSubmit={async event=>{
    event.preventDefault();if(!supabase)return;
    const redirect=`${window.location.origin}${window.location.pathname}${window.location.search}`;
    const {error}=await supabase.auth.signInWithOtp({email,options:{emailRedirectTo:redirect}});
    setMessage(error?.message??'Check your email for the OAuth sign-in link.');
  }}>
    <span className="brandMark">BA</span>
    <h1>Backend Autopilot OAuth</h1>
    <p>Supabase Auth is used only for ChatGPT MCP OAuth consent.</p>
    <label>Email<input type="email" required value={email} onChange={event=>setEmail(event.target.value)} autoComplete="email"/></label>
    <button type="submit">Send OAuth sign-in link</button>
    {message&&<p>{message}</p>}
  </form></div>;
  return <>{children}</>;
}
