# Backend Autopilot v0.1

Backend Autopilot is a standalone control plane that turns structured backend requirements into policy-checked, reproducible changes in explicitly registered sandbox projects. It is not a backend for Momna and contains no Momna integration or credentials.

## Prerequisites

- Node.js 22 or newer
- pnpm 10
- Git
- Docker with Compose (for the persistent PostgreSQL runtime)

## Start locally

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:migrate
pnpm test
pnpm dev
```

The API listens on `http://127.0.0.1:4310`; `GET /health` reports runtime status. `pnpm bootstrap` combines dependency installation and migration after PostgreSQL is running.

For a non-persistent diagnostic session only:

```bash
AUTOPILOT_STORE=memory pnpm autopilot health
```

Memory mode is never presented as durable production state. Normal API, CLI, worker, and MCP startup require `DATABASE_URL`.

## MCP

Add a stdio server to an MCP client, with an absolute working directory and the environment loaded from your local secret manager or `.env`:

```json
{
  "mcpServers": {
    "backend-autopilot": {
      "command": "pnpm",
      "args": ["--dir", "C:/absolute/path/backend-autopilot", "mcp"],
      "env": {
        "DATABASE_URL": "postgresql://autopilot:autopilot@localhost:54329/autopilot"
      }
    }
  }
}
```

The MCP surface contains semantic operations only; there is no general shell tool. See [MCP_CONTRACT.md](MCP_CONTRACT.md).

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

The E2E test creates an isolated temporary Git repository from `examples/demo-notes/base`, applies `examples/demo-notes/implementation`, observes an intentional security-test failure, commits a repair on the same task branch, reruns six actual Node test suites, performs independent review, and asserts `READY` plus the required artifacts.

## Safety defaults

The external-resource allowlist is empty after installation. `OBSERVE` cannot execute, `GUARDED` can mutate only a registered sandbox workspace, and `AUTONOMOUS_PRODUCTION` always returns `NOT_SUPPORTED`. No existing GitHub or Supabase project is discovered or trusted automatically.

See [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md), [RUNBOOK.md](RUNBOOK.md), and [SETUP_REQUIRED.md](SETUP_REQUIRED.md).
