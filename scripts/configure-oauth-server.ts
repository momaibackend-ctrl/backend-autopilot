import 'dotenv/config';

// The GoTrue settings that make the ChatGPT connector work are NOT deployable from
// supabase/config.toml: `supabase config push` diffs the ENTIRE remote [auth] block against that
// file, so pushing it would reset every setting the file does not declare. That is why config.toml
// carries a comment calling itself documentation only -- and it is exactly why the new project came
// up with a hand-approximated OAuth configuration that was wrong in four places while the file said
// otherwise. Documentation that nothing enforces drifts.
//
// This script is the enforcement: it PATCHes only the named fields via the Management API (which
// merges rather than replaces, so unrelated production settings are untouched), then re-reads the
// live config and fails if any field did not take. It is idempotent -- a run against an
// already-correct project changes nothing and still verifies.
//
// Run by .github/workflows/supabase.yml after every control-plane deploy, so the OAuth
// configuration is re-asserted on the same cadence as the Edge Functions it belongs to.

const projectRef = required('SUPABASE_PROJECT_ID');
const token = required('SUPABASE_ACCESS_TOKEN');
// Pages serves the console under a repository base path, so every URL below is anchored on it.
const consoleBase = process.env['AUTOPILOT_CONSOLE_BASE_URL'] ?? 'https://momaibackend-ctrl.github.io/backend-autopilot';

const desired = {
  // Where GoTrue sends an operator after email sign-in. The trailing slash matters: Pages is a
  // trailingSlash:true static export, so the unslashed form takes an extra redirect hop.
  site_url: `${consoleBase}/dashboard/`,
  // Without an allowlist, any redirect back into the console that is not exactly site_url is
  // rejected. `/**` covers /dashboard/, /oauth-consent/ and every other exported route.
  uri_allow_list: `${consoleBase}/**`,
  oauth_server_enabled: true,
  // GoTrue concatenates this onto site_url literally (verified empirically on this hosted
  // project), so reaching .../backend-autopilot/oauth-consent/ from a site_url that already ends
  // in /dashboard/ requires the dot-segment the browser then normalizes away. A plain
  // "/oauth-consent/" would resolve against the origin and lose the /backend-autopilot base path;
  // "/dashboard/oauth-consent/" -- what this project was actually set to -- is a 404 on Pages.
  oauth_server_authorization_path: '/../oauth-consent/',
  // ChatGPT's custom connector self-registers via Dynamic Client Registration (RFC 7591), because
  // Supabase does not implement the newer CIMD mechanism it would otherwise prefer. With this off,
  // registration fails 403 oauth_dynamic_client_registration_disabled and the connector can never
  // reach the consent screen at all. Registration grants nothing on its own: every resulting token
  // still needs a signed-in SUPERADMIN to approve on /oauth-consent/, and the MCP server
  // re-verifies the SUPERADMIN role on every tool call.
  oauth_server_allow_dynamic_registration: true,
} as const;

const endpoint = `https://api.supabase.com/v1/projects/${projectRef}/config/auth`;
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

const patch = await fetch(endpoint, { method: 'PATCH', headers, body: JSON.stringify(desired) });
if (!patch.ok) throw new Error(`Auth config PATCH failed (${patch.status}): ${(await patch.text()).slice(0, 300)}`);

// Re-read rather than trusting the PATCH response: a field the API silently ignores would
// otherwise look applied, which is the failure mode this whole script exists to catch.
const verify = await fetch(endpoint, { headers });
if (!verify.ok) throw new Error(`Auth config re-read failed (${verify.status}): ${(await verify.text()).slice(0, 300)}`);
const live = await verify.json() as Record<string, unknown>;

const drift = Object.entries(desired).filter(([key, value]) => live[key] !== value);
if (drift.length)
  throw new Error(`Auth config did not take for: ${drift.map(([key, value]) => `${key} (wanted ${JSON.stringify(value)}, got ${JSON.stringify(live[key])})`).join('; ')}`);

console.log(JSON.stringify({ level: 'info', event: 'oauth_server.configured', projectRef, applied: desired }));

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
