import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { z } from 'zod';

const httpUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname));
}, 'HTTPS is required except for loopback development URLs');

const portableRuntimeConfigSchema = z.object({
  publicBaseUrl: httpUrl.refine(value => {
    const url = new URL(value);
    return (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash;
  }, 'Public base URL must be an origin without a path, query, or fragment').transform(trimTrailingSlash),
  upstreamMcpUrl: httpUrl.transform(trimTrailingSlash),
  upstreamControlApiUrl: httpUrl.transform(trimTrailingSlash),
  oauthAuthorizationServerUrl: httpUrl.transform(trimTrailingSlash),
  readinessCacheMs: z.number().int().min(0).max(60_000).default(5_000),
  requestTimeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
});

export type PortableRuntimeConfig = z.input<typeof portableRuntimeConfigSchema>;
type RuntimeConfig = z.output<typeof portableRuntimeConfigSchema>;
type Fetch = typeof globalThis.fetch;

export function portableRuntimeConfigFromEnv(environment: NodeJS.ProcessEnv = process.env): PortableRuntimeConfig {
  const publicBaseUrl = environment['AUTOPILOT_PUBLIC_BASE_URL'];
  const upstreamMcpUrl = environment['AUTOPILOT_UPSTREAM_MCP_URL'];
  const upstreamControlApiUrl = environment['AUTOPILOT_UPSTREAM_CONTROL_API_URL'];
  const oauthAuthorizationServerUrl = environment['AUTOPILOT_OAUTH_AUTHORIZATION_SERVER_URL'];
  const missing = Object.entries({ AUTOPILOT_PUBLIC_BASE_URL: publicBaseUrl, AUTOPILOT_UPSTREAM_MCP_URL: upstreamMcpUrl, AUTOPILOT_UPSTREAM_CONTROL_API_URL: upstreamControlApiUrl, AUTOPILOT_OAUTH_AUTHORIZATION_SERVER_URL: oauthAuthorizationServerUrl }).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Portable runtime configuration is missing: ${missing.join(', ')}`);
  return {
    publicBaseUrl: publicBaseUrl!,
    upstreamMcpUrl: upstreamMcpUrl!,
    upstreamControlApiUrl: upstreamControlApiUrl!,
    oauthAuthorizationServerUrl: oauthAuthorizationServerUrl!,
    ...(environment['AUTOPILOT_UPSTREAM_TIMEOUT_MS'] ? { requestTimeoutMs: Number(environment['AUTOPILOT_UPSTREAM_TIMEOUT_MS']) } : {}),
  };
}

export function buildPortableRuntime(input: PortableRuntimeConfig, fetchImplementation: Fetch = globalThis.fetch): FastifyInstance {
  const config = portableRuntimeConfigSchema.parse(input);
  const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 32 * 1024 * 1024 });
  let readiness: { checkedAt: number; value: Readiness } | undefined;

  app.get('/health/live', async () => ({ status: 'ok', runtime: 'portable-container', version: '0.5.0' }));
  app.get('/health/ready', async (_request, reply) => sendReadiness(reply, await ready()));
  app.get('/up', async (_request, reply) => sendReadiness(reply, await ready()));
  app.get('/health', async (_request, reply) => {
    const result = await ready();
    return reply.code(result.ready ? 200 : 503).send({
      status: result.ready ? 'ok' : 'unavailable',
      platformVersion: '0.5.0',
      productionAutonomy: 'NOT_SUPPORTED',
      runtime: 'portable-container',
      publicBaseUrl: config.publicBaseUrl,
      dependencies: result.dependencies,
    });
  });

  app.get('/mcp/.well-known/oauth-protected-resource', async (_request, reply) => reply
    .header('cache-control', 'public, max-age=300')
    .send(protectedResourceMetadata(config)));

  registerProxy(app, '/mcp', config.upstreamMcpUrl, config, fetchImplementation);
  registerProxy(app, '/control-api', config.upstreamControlApiUrl, config, fetchImplementation);

  async function ready(): Promise<Readiness> {
    const now = Date.now();
    if (readiness && now - readiness.checkedAt < config.readinessCacheMs) return readiness.value;
    try {
      const response = await fetchImplementation(`${config.upstreamMcpUrl}/.well-known/oauth-protected-resource`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4_000) });
      const value: Readiness = response.ok
        ? { ready: true, dependencies: { mcpUpstream: 'ok' } }
        : { ready: false, dependencies: { mcpUpstream: `http_${response.status}` } };
      readiness = { checkedAt: now, value };
      return value;
    } catch {
      const value: Readiness = { ready: false, dependencies: { mcpUpstream: 'unreachable' } };
      readiness = { checkedAt: now, value };
      return value;
    }
  }

  return app;
}

type Readiness = { ready: boolean; dependencies: { mcpUpstream: string } };

function sendReadiness(reply: FastifyReply, result: Readiness) {
  return reply.code(result.ready ? 200 : 503).send({ status: result.ready ? 'ready' : 'not_ready', ...result });
}

function registerProxy(app: FastifyInstance, prefix: '/mcp' | '/control-api', upstream: string, config: RuntimeConfig, fetchImplementation: Fetch) {
  const handler = (request: FastifyRequest, reply: FastifyReply) => proxy(request, reply, prefix, upstream, config, fetchImplementation);
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const;
  app.route({ method: [...methods], url: prefix, handler });
  app.route({ method: [...methods], url: `${prefix}/*`, handler });
}

async function proxy(request: FastifyRequest, reply: FastifyReply, prefix: string, upstream: string, config: RuntimeConfig, fetchImplementation: Fetch) {
  const requestUrl = new URL(request.url, config.publicBaseUrl);
  const suffix = requestUrl.pathname.slice(prefix.length);
  const target = new URL(`${upstream}${suffix}${requestUrl.search}`);
  const headers = forwardHeaders(request.headers);
  const body = request.body === undefined ? undefined : typeof request.body === 'string' ? request.body : Buffer.isBuffer(request.body) ? request.body.toString('utf8') : JSON.stringify(request.body);
  try {
    const response = await fetchImplementation(target, {
      method: request.method,
      headers,
      ...(body === undefined || ['GET', 'HEAD'].includes(request.method) ? {} : { body }),
      redirect: 'manual',
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    for (const [name, value] of response.headers) {
      if (!hopByHopHeaders.has(name.toLowerCase()) && name.toLowerCase() !== 'content-length') reply.header(name, rewriteResponseHeader(name, value, prefix, config));
    }
    reply.code(response.status);
    return response.body ? reply.send(Readable.fromWeb(response.body as unknown as NodeReadableStream)) : reply.send();
  } catch (error) {
    request.log.error({ upstream: target.origin, error: error instanceof Error ? error.name : 'UnknownError' }, 'Portable runtime upstream request failed');
    return reply.code(502).send({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'The configured Backend Autopilot upstream is unavailable' } });
  }
}

function forwardHeaders(source: FastifyRequest['headers']) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || hopByHopHeaders.has(name.toLowerCase()) || ['host', 'content-length'].includes(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

function rewriteResponseHeader(name: string, value: string, prefix: string, config: RuntimeConfig) {
  if (name.toLowerCase() === 'www-authenticate' && prefix === '/mcp') {
    return value.replace(/resource_metadata="[^"]+"/i, `resource_metadata="${config.publicBaseUrl}/mcp/.well-known/oauth-protected-resource"`);
  }
  return value;
}

function protectedResourceMetadata(config: RuntimeConfig) {
  return {
    resource: `${config.publicBaseUrl}/mcp`,
    authorization_servers: [config.oauthAuthorizationServerUrl],
    bearer_methods_supported: ['header'],
  };
}

const hopByHopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function trimTrailingSlash(value: string) { return value.replace(/\/+$/, ''); }
