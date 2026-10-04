import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root=resolve(__dirname,'../..');
const edge=readFileSync(join(root,'supabase/functions/_shared/edge-runtime.ts'),'utf8');
const control=readFileSync(join(root,'supabase/functions/control-api/index.ts'),'utf8');
const mcp=readFileSync(join(root,'supabase/functions/mcp/index.ts'),'utf8');
const config=readFileSync(join(root,'supabase/config.toml'),'utf8');
const gate=readFileSync(join(root,'apps/operator-console/app/auth-gate.tsx'),'utf8');
const client=readFileSync(join(root,'apps/operator-console/app/lib/supabase.ts'),'utf8');

describe('Operator Console authentication boundary',()=>{
  it('validates Console sessions inside control-api',()=>{
    expect(config).toMatch(/\[functions\.control-api\][\s\S]*?verify_jwt\s*=\s*false/);
    expect(control).toContain("path==='/v1/auth/login'");
    expect(control).toContain("path==='/v1/auth/session'");
  });
  it('reads the Console credential only from a server-side environment reference',()=>{
    expect(edge).toContain("required('AUTOPILOT_CONSOLE_PASSWORD')");
    expect(edge).not.toContain('NEXT_PUBLIC_AUTOPILOT_CONSOLE_PASSWORD');
    expect(client).not.toContain('NEXT_PUBLIC_AUTOPILOT_CONSOLE_PASSWORD');
  });
  it('keeps the Console session type out of MCP authentication',()=>{
    expect(control).toContain('authenticatedControlOperator');
    expect(mcp).not.toContain('authenticatedControlOperator');
  });
  it('keeps magic-link sign-in only inside the OAuth consent gate',()=>{
    const normal=gate.slice(gate.indexOf('function ConsolePasswordGate'),gate.indexOf('function OAuthAuthGate'));
    const oauth=gate.slice(gate.indexOf('function OAuthAuthGate'));
    expect(normal).toContain('consoleLogin(username,password)');
    expect(normal).not.toContain('signInWithOtp');
    expect(oauth).toContain('signInWithOtp');
  });
  it('uses the console bearer for normal Control API calls',()=>{
    const authorized=client.slice(client.indexOf('export async function authorizedFetch'),client.indexOf('function getConsoleSessionToken'));
    expect(authorized).toContain('getConsoleSessionToken()');
    expect(authorized).not.toContain('supabase.auth.getSession');
    expect(authorized).not.toContain('apikey');
  });
});
