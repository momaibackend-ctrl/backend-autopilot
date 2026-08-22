import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';

// Proves the actual GoTrue OAuth 2.1 Server contract the fixed oauth-consent page relies on:
// a repeat /authorize for the same client+scope resolves straight to a redirect (no consent UI
// needed) once a grant exists, and reverts to requiring consent again once that grant is revoked.
// Uses a throwaway DCR-registered test client and a non-interactively minted session for the
// real allowlisted SUPERADMIN operator (via the Admin API's magic-link generate+verify, so no
// email is actually sent -- the OTP is consumed by this script immediately). Never touches the
// real ChatGPT-registered client or its grants.
const supabaseUrl = required('AUTOPILOT_CONTROL_SUPABASE_URL');
const serviceRoleKey = required('AUTOPILOT_CONTROL_SUPABASE_SERVICE_ROLE_KEY');
const publishableKey = required('AUTOPILOT_CONTROL_SUPABASE_PUBLISHABLE_KEY');
const superadminEmail = process.env['AUTOPILOT_OAUTH_E2E_SUPERADMIN_EMAIL'] ?? 'momaibackend@gmail.com';
const mcpEndpoint = process.env['AUTOPILOT_REMOTE_MCP_URL'] ?? `${supabaseUrl}/functions/v1/mcp`;
const redirectUri = 'https://example.com/oauth-consent-e2e-callback';

const proof: Record<string, unknown> = {};

// 1. Register a throwaway public OAuth client via Dynamic Client Registration (RFC 7591) -- the
//    same mechanism ChatGPT's connector uses to self-register, never a pre-shared client.
const client = await call<{ client_id: string }>('POST', '/auth/v1/oauth/clients/register', publishableKey, {
  client_name: `oauth-consent-e2e-${Date.now().toString(36)}`,
  redirect_uris: [redirectUri],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
});
proof['clientId'] = client.client_id;

// 2. Mint a real session for the allowlisted SUPERADMIN operator without sending an email: the
//    Admin API issues a magic-link OTP, which is immediately consumed via /auth/v1/verify.
const link = await call<{ hashed_token: string }>('POST', '/auth/v1/admin/generate_link', serviceRoleKey, { type: 'magiclink', email: superadminEmail }, false, false, serviceRoleKey);
const operatorSession = await call<{ access_token: string; refresh_token: string }>('POST', '/auth/v1/verify', publishableKey, { type: 'magiclink', token_hash: link.hashed_token });

// 3. First authorize: no grant exists yet -> must require consent.
const first = await authorize(client.client_id);
const firstDetails = await getAuthorizationDetails(first.authorizationId, operatorSession.access_token);
if (!('client' in firstDetails)) throw new Error('First authorize unexpectedly skipped consent -- no prior grant should exist for a brand-new test client');
proof['firstConsentRequired'] = true;

// 4. Approve it -- this is the one-time, real, manual-equivalent Approve.
const approved = await postConsent(first.authorizationId, operatorSession.access_token, 'approve');
const firstTokens = await exchangeCode(client.client_id, approved.redirect_url, first.codeVerifier);
proof['refreshTokenIssued'] = Boolean(firstTokens.refresh_token);
proof['firstAccessTokenHealthCheck'] = await mcpHealthCheck(firstTokens.access_token);

// 5. Second authorize for the SAME client + SAME scope, brand-new authorization_id (this is
//    exactly what a new ChatGPT chat does) -- must now resolve straight to a redirect.
const second = await authorize(client.client_id);
const secondDetails = await getAuthorizationDetails(second.authorizationId, operatorSession.access_token);
proof['repeatConsentSkipped'] = 'redirect_url' in secondDetails;
if (!('redirect_url' in secondDetails)) throw new Error('Repeat authorize with an unchanged grant still required consent -- fix did not take effect');
const secondTokens = await exchangeCode(client.client_id, secondDetails.redirect_url, second.codeVerifier);
proof['repeatAccessTokenHealthCheck'] = await mcpHealthCheck(secondTokens.access_token);

// 6. Refresh token grant actually works.
const refreshed = await call<{ access_token: string }>('POST', '/auth/v1/oauth/token', publishableKey, {
  grant_type: 'refresh_token',
  refresh_token: firstTokens.refresh_token,
  client_id: client.client_id,
}, true);
proof['refreshGrantWorks'] = Boolean(refreshed.access_token);

// 7. Revoke the grant, then a third authorize must require consent again.
await call('DELETE', `/auth/v1/user/oauth/grants?client_id=${encodeURIComponent(client.client_id)}`, operatorSession.access_token, undefined, true, true);
const third = await authorize(client.client_id);
const thirdDetails = await getAuthorizationDetails(third.authorizationId, operatorSession.access_token);
proof['revokeForcesNewConsent'] = 'client' in thirdDetails;
if (!('client' in thirdDetails)) throw new Error('Authorize after revocation unexpectedly skipped consent');
// Deny the still-open third authorization request rather than leaving it dangling.
await postConsent(third.authorizationId, operatorSession.access_token, 'deny');

console.log(JSON.stringify({ level: 'info', event: 'oauth_consent_e2e.succeeded', proof }, null, 2));

async function authorize(clientId: string) {
  const codeVerifier = randomBytes(48).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(12).toString('hex');
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'openid', code_challenge: codeChallenge, code_challenge_method: 'S256', state });
  const response = await fetch(`${supabaseUrl}/auth/v1/oauth/authorize?${query}`, { headers: { apikey: publishableKey }, redirect: 'manual' });
  const location = response.headers.get('location');
  if (!location) throw new Error(`Authorize did not redirect (status ${response.status}): ${(await response.text()).slice(0, 300)}`);
  const authorizationId = new URL(location, supabaseUrl).searchParams.get('authorization_id');
  if (!authorizationId) throw new Error(`Authorize redirect carried no authorization_id: ${location}`);
  return { authorizationId, codeVerifier, state };
}
async function getAuthorizationDetails(authorizationId: string, operatorToken: string) {
  return call<{ client: unknown } | { redirect_url: string }>('GET', `/auth/v1/oauth/authorizations/${encodeURIComponent(authorizationId)}`, operatorToken);
}
async function postConsent(authorizationId: string, operatorToken: string, action: 'approve' | 'deny') {
  return call<{ redirect_url: string }>('POST', `/auth/v1/oauth/authorizations/${encodeURIComponent(authorizationId)}/consent`, operatorToken, { action });
}
async function exchangeCode(clientId: string, redirectUrl: string, codeVerifier: string) {
  const code = new URL(redirectUrl).searchParams.get('code');
  if (!code) throw new Error(`Consent redirect carried no code: ${redirectUrl}`);
  return call<{ access_token: string; refresh_token: string }>('POST', '/auth/v1/oauth/token', publishableKey, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: codeVerifier }, true);
}
async function mcpHealthCheck(accessToken: string) {
  const response = await fetch(mcpEndpoint, { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'superadmin_system_overview', arguments: {} } }) });
  const raw = await response.text();
  const line = raw.split(/\r?\n/).find(entry => entry.startsWith('data:'));
  const data = JSON.parse(line ? line.slice(5).trim() : raw) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
  if (data.result?.isError) throw new Error(`MCP call with OAuth token failed: ${data.result.content?.map(c => c.text).join('\n')}`);
  return Boolean(data.result);
}
async function call<T>(method: string, path: string, bearer: string, body?: unknown, formEncoded = false, allowEmptyBody = false, apikeyOverride?: string): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${bearer}`, apikey: apikeyOverride ?? publishableKey };
  let requestBody: string | undefined;
  if (body !== undefined) {
    if (formEncoded) { headers['content-type'] = 'application/x-www-form-urlencoded'; requestBody = new URLSearchParams(body as Record<string, string>).toString(); }
    else { headers['content-type'] = 'application/json'; requestBody = JSON.stringify(body); }
  }
  const response = await fetch(`${supabaseUrl}${path}`, requestBody===undefined?{ method, headers }:{ method, headers, body: requestBody });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${text.slice(0, 400)}`);
  if (allowEmptyBody && !text) return {} as T;
  return JSON.parse(text) as T;
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
