# Backend Autopilot v0.2

Backend Autopilot is a standalone, provider-neutral control plane for policy-checked and reproducible backend development. It is not a Momna backend and never discovers or trusts existing external resources automatically.

## Lightweight start — Docker is optional

Prerequisites: Node.js 22+, pnpm 10, and Git. The durable bootstrap registry uses `.autopilot/state.json` until an external control-plane `DATABASE_URL` is configured.

```bash
cp .env.example .env
pnpm bootstrap
pnpm check
pnpm dev
```

Docker Compose remains an optional local PostgreSQL convenience, not a dependency. To use an external PostgreSQL control plane, place its URL in the gitignored `.env`, then run `pnpm db:migrate` and restart the service. Target database URLs are always project-scoped secret references.

## Actual capabilities

```bash
pnpm autopilot capabilities
pnpm autopilot capabilities --project <project-id>
```

Statuses are evidence-based: `SUPPORTED`, `CONFIGURED`, `LIVE_TESTED`, `MOCK`, `NOT_CONFIGURED`, or `NOT_SUPPORTED`. An implemented adapter is never reported as live until audit evidence exists.

## Autonomous sandbox bootstrap

1. Create an `AUTONOMOUS_STAGING` project with environment `STAGING` and a clean sandbox Git workspace.
2. Log in through official provider flows only when requested:

   ```bash
   gh auth login --web --hostname github.com
   supabase login
   ```

3. Confirm that each active identity is a dedicated sandbox account. Backend Autopilot detects and registers account/organization IDs itself:

   ```bash
   pnpm autopilot sandbox-github-register --project <id> --confirm-dedicated-sandbox
   pnpm autopilot sandbox-supabase-register --project <id> --confirm-dedicated-sandbox
   ```

4. Call `sandbox_bootstrap` through MCP or `pnpm autopilot sandbox-bootstrap --file bootstrap.json`.

Bootstrap creates and pushes a private sandbox repository, creates the Supabase project, stores generated database credentials only in `.env`, registers resources, waits for the database, applies versioned migrations, configures structured RLS, optionally configures Auth/Storage, observes CI, writes manifests, and captures capabilities.

Passwords are never accepted as persistent inputs. Generated secrets are replaceable through `MutableSecretProvider`; manifests contain reference names and lifecycle procedures only.

## MCP

```json
{
  "mcpServers": {
    "backend-autopilot": {
      "command": "pnpm",
      "args": ["--dir", "C:/absolute/path/backend-autopilot", "mcp"]
    }
  }
}
```

The MCP surface has semantic operations only. External provisioning requires explicit sandbox account resources; deletion requires separate destructive tools and matching confirmation objects. See [MCP_CONTRACT.md](MCP_CONTRACT.md).

## Verification

```bash
pnpm check
```

External live database tests run when `AUTOPILOT_LIVE_DATABASE_URL` is explicitly supplied. GitHub/Supabase live bootstrap is never triggered by the ordinary test suite.

The local E2E creates an isolated Git repository, intentionally fails security tests, commits a repair on the same task branch, reruns six suites, performs IndependentReview, and proves the formal `READY` gates.

See [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md), [THREAT_MODEL.md](THREAT_MODEL.md), [RUNBOOK.md](RUNBOOK.md), and [SETUP_REQUIRED.md](SETUP_REQUIRED.md).
