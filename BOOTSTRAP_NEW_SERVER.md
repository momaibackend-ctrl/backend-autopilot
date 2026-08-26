# Bootstrap Backend Autopilot on a new Linux server

This runbook deploys the existing Backend Autopilot public surface to an ordinary x86-64 Linux VPS with Kamal. It creates no database, Redis instance, paid PaaS, or provider-specific server resource. Supabase Auth/Postgres/Storage/Edge and GitHub Actions remain unchanged.

## 1. Server requirements

- A clean Debian/Ubuntu-compatible x86-64 VM with a public IPv4 address, SSH key access, and a user that can install Docker (root is the Kamal default).
- TCP 22 from the deploy runner and TCP 80/443 from the internet. Do not expose application port 4310 publicly; `kamal-proxy` reaches it on Docker networking.
- A practical minimum is 1 GB RAM, 1 vCPU, and 10 GB free disk for this stateless gateway. State is not stored on the VPS.
- A stable hostname such as `backend.example.com` that you control.
- Kamal 2.12.0 on the deploy machine, or use the provided manual GitHub Actions workflow.

Do not purchase a server or enable a paid add-on automatically. Any standard VPS/VM is suitable; no provider API appears in the application or deployment config.

## 2. DNS and Cloudflare

Create an `A` record for the stable hostname pointing to the server IP. For first certificate issuance, DNS-only is the simplest bootstrap state. After `kamal setup` and the HTTPS checks pass, enable Cloudflare proxying and set SSL/TLS mode to **Full (strict)**. Keep the origin reachable on 80/443 for Kamal's provider-neutral Let's Encrypt certificate.

The permanent integration URLs are:

```text
Backend / Control API: https://backend.example.com/control-api
MCP:                   https://backend.example.com/mcp
OAuth resource:        https://backend.example.com/mcp/.well-known/oauth-protected-resource
OAuth authorization:   existing configured Supabase Auth server
```

Cloudflare Tunnel is optional and intentionally not installed by default. Direct proxied DNS keeps a DNS-only/direct-origin fallback and avoids making `cloudflared` a mandatory process.

## 3. Configuration and secrets

Set these non-secret deployment variables locally or as GitHub Environment variables:

```bash
export AUTOPILOT_SERVER_IP=203.0.113.10
export AUTOPILOT_SSH_USER=root
export AUTOPILOT_PUBLIC_HOST=backend.example.com
export AUTOPILOT_UPSTREAM_MCP_URL=https://PROJECT_REF.supabase.co/functions/v1/mcp
export AUTOPILOT_UPSTREAM_CONTROL_API_URL=https://PROJECT_REF.supabase.co/functions/v1/control-api
export AUTOPILOT_OAUTH_AUTHORIZATION_SERVER_URL=https://PROJECT_REF.supabase.co/auth/v1
export KAMAL_REGISTRY_USERNAME=GITHUB_LOGIN
export KAMAL_REGISTRY_PASSWORD=GHCR_TOKEN
```

`KAMAL_REGISTRY_PASSWORD` is the only Kamal secret for this gateway. Give it only the package permissions needed to push/pull the image. For local Kamal, copy `.kamal/secrets.example` to ignored `.kamal/secrets`; values remain in the environment and never enter Git.

For `.github/workflows/deploy-portable.yml`, create GitHub Environment `portable-runtime` with the six `AUTOPILOT_*` variables above (except the registry username/password, which use the workflow identity) and secret `AUTOPILOT_SSH_PRIVATE_KEY`. Protect the environment with approval if desired. The workflow is manual and cannot start billing or create a VPS.

After cutover, set repository variable `AUTOPILOT_PUBLIC_CONTROL_API_URL=https://backend.example.com/control-api` so future Console builds use the stable origin. Set existing secret `AUTOPILOT_CONTROL_API_URL` to the same value for reconciliation. MCP smoke/E2E commands can use `AUTOPILOT_REMOTE_MCP_URL=https://backend.example.com/mcp`.

## 4. Initial deployment

From a clean clone on Linux/macOS with Docker and Kamal:

```bash
gem install kamal --version 2.12.0
cp .kamal/secrets.example .kamal/secrets
kamal registry login
kamal setup
```

On Windows, use the manual `Deploy portable runtime with Kamal` GitHub Actions workflow with command `setup`; local Docker Desktop is not required.

Kamal installs Docker when needed, builds `docker/Dockerfile`, pushes the image to GHCR, starts `kamal-proxy`, waits for `/up`, and switches traffic only after readiness succeeds.

## 5. Ordinary deployment

```bash
kamal deploy
```

Or run the manual deployment workflow with command `deploy`. CI separately builds the same Dockerfile after the full repository verification job.

## 6. Health and protocol verification

```bash
curl --fail https://backend.example.com/health
curl --fail https://backend.example.com/health/live
curl --fail https://backend.example.com/health/ready
curl --fail https://backend.example.com/mcp/.well-known/oauth-protected-resource
AUTOPILOT_REMOTE_MCP_URL=https://backend.example.com/mcp pnpm mcp:health-check
```

The final command also requires the existing ignored `AUTOPILOT_SUPERADMIN_MCP_TOKEN`; never paste it into a command log or document. Verify Console sign-in/OAuth and run the existing remote E2E gates before changing a production connector.

Useful operations:

```bash
kamal app details
kamal app logs --follow
kamal app containers -q
kamal audit
```

## 7. Rollback

List retained versions and roll back to an exact known-good Git SHA:

```bash
kamal app containers -q
kamal rollback PREVIOUS_GIT_SHA
```

Kamal retains five container versions in this configuration. Do not roll back the Supabase database or Edge functions as part of a gateway rollback; the gateway is stateless.

## 8. Move to another server

1. Provision a clean replacement VM and verify SSH without changing the application repository.
2. Set `AUTOPILOT_SERVER_IP` to the new IP and run `kamal setup`. If certificate validation cannot reach the new host while the stable DNS record still targets the old host, bootstrap once with a temporary validation hostname, then restore `AUTOPILOT_PUBLIC_HOST` to the stable hostname for cutover.
3. Change only the stable hostname's `A/AAAA` origin to the new IP. Keep Cloudflare proxying and the public URL unchanged.
4. Run `kamal deploy` against the stable hostname and repeat all health/MCP/OAuth checks.
5. Keep the old server stopped but recoverable until logs and remote E2E are clean; then remove it through that VPS provider's own process.

No business code, MCP tool configuration, OAuth client callback, Supabase project, database, Storage bucket, or GitHub Actions job identity changes during this move.

## 9. Complete hosting outage

If the current VPS or provider disappears:

1. Create any ordinary replacement Linux VM.
2. Update `AUTOPILOT_SERVER_IP`, load the existing SSH/registry references, and run `kamal setup`.
3. Point the stable DNS record to the replacement IP.
4. Verify health, MCP tools/list + `system_health`, OAuth discovery/sign-in, job status/resume, and the Console.

During recovery, the direct Supabase Edge MCP and Control API URLs remain emergency endpoints. Durable jobs, operation IDs, run IDs, leases, checkpoints, heartbeats, artifacts, and terminal results remain in Supabase/Postgres and do not depend on the lost VPS filesystem. Never re-dispatch a job merely because the gateway restarted; inspect its existing `jobId`/`runId` first.
