# ADR 014: Portable public runtime in front of the existing control plane

## Status

Accepted.

## Context

The deployed v0.5 control plane is Supabase Edge plus Supabase Auth/Postgres/Storage, with durable execution dispatched to GitHub Actions. The repository contains no Render runtime code, Render environment variables, `render.yaml`, deploy hooks, or `onrender.com` URLs. The existing Dockerfile built only the local Fastify adapter, so it was not an equivalent public origin: it lacked HTTP MCP, stable OAuth discovery, separate liveness/readiness, and a reproducible server deployment.

Moving the proven Edge functions, state, Auth, Storage, execution leases, and 83-tool MCP surface in one infrastructure change would create unnecessary migration risk. Supabase is an existing explicit provider adapter and is not part of the requested Render removal.

## Decision

Add a stateless, provider-neutral public runtime that runs as an ordinary OCI container. It owns stable public paths and forwards authenticated requests without interpreting or changing business payloads:

- `/mcp` forwards the complete Streamable HTTP MCP surface;
- `/control-api` forwards the existing Control API;
- `/mcp/.well-known/oauth-protected-resource` is generated from `AUTOPILOT_PUBLIC_BASE_URL`, while the authorization server remains configurable;
- upstream `WWW-Authenticate` discovery links are rewritten to the stable public resource URL;
- `/health/live` checks the process, while `/health/ready` and `/up` verify upstream MCP discovery.

All origin/upstream addresses are configuration. Kamal 2 deploys the image to an ordinary Linux server through `kamal-proxy`, using a hostname and server IP supplied at deployment time. Cloudflare is recommended as proxied DNS/TLS/WAF in front of the origin, but it is not required for application execution: the same hostname can be DNS-only or moved to another DNS provider. Cloudflare Tunnel is deliberately optional and absent from the default deployment so a tunnel outage or account lock cannot become a new mandatory runtime dependency.

The existing Supabase Edge URL remains a direct emergency endpoint and may also remain the upstream indefinitely. Render is neither deleted nor used by this deployment.

## Consequences

- A server change updates deployment variables and DNS, not application code, OAuth metadata code, MCP tools, or connector paths.
- Container restarts cannot duplicate execution jobs: operation IDs, job uniqueness, leases, run/checkpoint state, heartbeat, and terminal results remain in the existing durable control store.
- Kamal provides health-gated cutover, graceful drain, retained image versions, logs, restart policy, and rollback without introducing Kubernetes or a VPS-specific API.
- The public runtime still depends on the intentionally retained Supabase/GitHub components. Replacing those providers is a separate adapter migration, not part of removing Render.
