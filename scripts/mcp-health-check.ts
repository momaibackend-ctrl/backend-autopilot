import 'dotenv/config';

// Run after every `supabase functions deploy` of the Superadmin MCP so a broken deployment is
// caught before it is recorded as the new rollback point (see .github/workflows/supabase.yml).
// Exits non-zero on any failure; the workflow then rolls back to the last known-good tag.
const endpoint = process.env['AUTOPILOT_REMOTE_MCP_URL'] ?? `https://${required('SUPABASE_PROJECT_ID')}.supabase.co/functions/v1/mcp`;
const token = required('AUTOPILOT_SUPERADMIN_MCP_TOKEN');
const requiredTools = ['system_health', 'runtime_status', 'superadmin_system_overview', 'superadmin_task_execute', 'superadmin_sandbox_pull_request_merge', 'superadmin_scenario_run', 'superadmin_task_rebase_onto_current_base'];

const list = await rpc<{ tools: Array<{ name: string }> }>('tools/list', {});
const names = new Set(list.tools.map(tool => tool.name));
const missing = requiredTools.filter(name => !names.has(name));
if (missing.length) throw new Error(`Deployed MCP tool roster is missing: ${missing.join(', ')}`);

// The control-api function is deployed by the same job but was never health-checked, so a broken
// import there would ship green and skip the rollback that guards the MCP function. An
// unauthenticated request must come back 401 from the function's own auth gate; a 5xx means the
// module failed to boot.
const controlApi = `${endpoint.replace(/\/mcp$/, '')}/control-api/health`;
const controlResponse = await fetch(controlApi, { method: 'GET' });
if (controlResponse.status >= 500)
  throw new Error(`control-api failed to boot (${controlResponse.status}): ${(await controlResponse.text()).slice(0, 300)}`);
console.log(JSON.stringify({ level: 'info', event: 'control_api.boot_check.succeeded', status: controlResponse.status }));

const health = await call<{ status?: string }>('system_health', {});
console.log(JSON.stringify({ level: 'info', event: 'mcp.health_check.succeeded', endpoint, toolCount: names.size, health }));

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) });
  const raw = await response.text();
  if (!response.ok) throw new Error(`MCP ${method} failed (${response.status}): ${raw.slice(0, 300)}`);
  const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5).trim())).at(-1) ?? JSON.parse(raw);
  if (data.error) throw new Error(data.error.message ?? `MCP ${method} returned an error`);
  return data.result as T;
}
async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await rpc<{ isError?: boolean; structuredContent?: { result: T }; content?: Array<{ text?: string }> }>('tools/call', { name, arguments: args });
  if (result.isError) throw new Error(result.content?.map(value => value.text).join('\n') ?? `Tool ${name} failed`);
  if (result.structuredContent?.result !== undefined) return result.structuredContent.result;
  const text = result.content?.[0]?.text;
  if (!text) throw new Error(`Tool ${name} returned no result`);
  return JSON.parse(text) as T;
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
