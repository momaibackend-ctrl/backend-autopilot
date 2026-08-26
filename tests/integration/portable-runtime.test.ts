import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPortableRuntime } from '../../apps/portable-runtime/src/app.js';

const config = {
  publicBaseUrl: 'https://backend.example.com',
  upstreamMcpUrl: 'https://upstream.example.com/functions/v1/mcp',
  upstreamControlApiUrl: 'https://upstream.example.com/functions/v1/control-api',
  oauthAuthorizationServerUrl: 'https://upstream.example.com/auth/v1',
  readinessCacheMs: 0,
};

const apps: ReturnType<typeof buildPortableRuntime>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

describe('portable runtime', () => {
  it('separates liveness from upstream readiness', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('offline'));
    const app = buildPortableRuntime(config, fetch); apps.push(app);
    expect((await app.inject('/health/live')).statusCode).toBe(200);
    const ready = await app.inject('/health/ready');
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ status: 'not_ready', dependencies: { mcpUpstream: 'unreachable' } });
  });

  it('publishes stable protected-resource metadata and proxies MCP auth unchanged', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const app = buildPortableRuntime(config, fetch); apps.push(app);
    const metadata = await app.inject('/mcp/.well-known/oauth-protected-resource');
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toEqual({ resource: 'https://backend.example.com/mcp', authorization_servers: ['https://upstream.example.com/auth/v1'], bearer_methods_supported: ['header'] });

    const response = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(response.statusCode).toBe(200);
    const [target, init] = fetch.mock.calls.at(-1)!;
    expect(target.toString()).toBe(config.upstreamMcpUrl);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
    expect(init?.body).toBe(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  });

  it('keeps the public discovery URL in an upstream 401 challenge', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401, headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer resource_metadata="https://upstream.example.com/functions/v1/mcp/.well-known/oauth-protected-resource"' } }));
    const app = buildPortableRuntime(config, fetch); apps.push(app);
    const response = await app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer resource_metadata="https://backend.example.com/mcp/.well-known/oauth-protected-resource"');
  });

  it('proxies Control API paths and query parameters without changing business payloads', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const app = buildPortableRuntime(config, fetch); apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/control-api/v1/projects?taskId=one', headers: { authorization: 'Bearer operator-session' } });
    expect(response.statusCode).toBe(200);
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(`${config.upstreamControlApiUrl}/v1/projects?taskId=one`);
  });
});
