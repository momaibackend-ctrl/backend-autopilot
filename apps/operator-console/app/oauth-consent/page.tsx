"use client";
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { supabase, supabasePublishableKey, supabaseUrl } from '../lib/supabase';

type AuthorizationDetails={
  client_id:string;
  client_name?:string;
  redirect_uri:string;
  scope?:string;
};

export default function Page(){
  return <Suspense fallback={<p>Loading authorization request…</p>}><Consent/></Suspense>;
}

function Consent(){
  const authorizationId=useSearchParams().get('authorization_id');
  const [details,setDetails]=useState<AuthorizationDetails>();
  const [error,setError]=useState('');
  const [pending,setPending]=useState(false);

  useEffect(()=>{
    if(!authorizationId){setError('Missing authorization_id.');return;}
    if(!supabase||!supabaseUrl){setError('Supabase Auth is not configured.');return;}
    let active=true;
    void (async()=>{
      const {data}=await supabase.auth.getSession();
      if(!data.session){setError('Sign in as an allowlisted operator to review this request.');return;}
      const response=await fetch(`${supabaseUrl}/auth/v1/oauth/authorizations/${encodeURIComponent(authorizationId)}`,{headers:{authorization:`Bearer ${data.session.access_token}`,apikey:supabasePublishableKey}});
      if(!active)return;
      if(!response.ok){setError(`Authorization request could not be loaded (${response.status}).`);return;}
      setDetails(await response.json() as AuthorizationDetails);
    })();
    return()=>{active=false;};
  },[authorizationId]);

  async function decide(approve:boolean){
    if(!authorizationId||!supabase||!supabaseUrl)return;
    setPending(true);
    setError('');
    const {data}=await supabase.auth.getSession();
    if(!data.session){setError('Operator session expired. Reload and sign in again.');setPending(false);return;}
    const response=await fetch(`${supabaseUrl}/auth/v1/oauth/authorizations/${encodeURIComponent(authorizationId)}/consent`,{
      method:'POST',
      headers:{authorization:`Bearer ${data.session.access_token}`,apikey:supabasePublishableKey,'content-type':'application/json'},
      body:JSON.stringify({action:approve?'approve':'deny'}),
    });
    const body=await response.json().catch(()=>undefined) as {redirect_url?:string;msg?:string}|undefined;
    if(!response.ok||!body?.redirect_url){setError(body?.msg??`The authorization decision could not be completed (${response.status}).`);setPending(false);return;}
    window.location.href=body.redirect_url;
  }

  return (
    <div className="page">
      <div className="title"><div><h2>Authorize application access</h2><p>Review what this application is requesting before approving.</p></div></div>
      {error && <div className="errorState" role="alert"><p>{error}</p></div>}
      {!error && !details && <p>Loading authorization request…</p>}
      {details && (
        <section className="panel">
          <h2>{details.client_name??details.client_id}</h2>
          <div className="statusGrid">
            <div className="info"><span>Requested scope</span><strong>{details.scope??'(none declared)'}</strong></div>
            <div className="info"><span>Will redirect to</span><strong>{details.redirect_uri}</strong></div>
          </div>
          <p className="muted">Approving signs this application in as you. Backend Autopilot separately re-verifies SUPERADMIN status on every request — OAuth sign-in alone does not grant elevated access.</p>
          <div className="form">
            <button disabled={pending} onClick={()=>void decide(true)}>{pending?'Working…':'Approve'}</button>
            <button disabled={pending} onClick={()=>void decide(false)}>Deny</button>
          </div>
        </section>
      )}
    </div>
  );
}
