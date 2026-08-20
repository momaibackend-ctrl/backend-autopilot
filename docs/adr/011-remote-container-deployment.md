# ADR 011: GitHub-driven remote container deployment

Status: superseded by ADR 012. Retained only as decision history; it is not a deployable v0.4 architecture.

## Context

The v0.3 runtime is not a static or conventional serverless application. The existing architecture runs a Fastify process, invokes fixed Git/GitHub/Supabase/Node commands, and maintains a checked-out target workspace. Deploying only the Next.js UI would remove existing functions; moving execution into provider-specific functions would replace the architecture.

## Decision

Deploy one Linux container from the private `momaibackend-ctrl/backend-autopilot` GitHub repository. Next.js is the only public port. It proxies same-origin `/api/control/*` requests to the Fastify process over a server-only internal origin. A server-side Basic Auth gate protects both console pages and API routes; the unauthenticated health route contains no project data.

Use a dedicated PostgreSQL service for `StateStore` and a volume mounted at `/data` for target Git workspaces. On the first empty-database start, an audited, credential-shaped-data-checked snapshot imports the existing v0.3 projects, tasks, runs, artifacts, transitions, and audit events transactionally. Workspace paths are materialized under `/data/workspaces`; no Windows path is committed. The exact allowlisted private target repository is restored with the dedicated sandbox GitHub identity. Subsequent starts never re-import over non-empty state and reuse the volume.

The container includes pinned, checksum-verified GitHub and Supabase CLIs and runs `pnpm check` during its Linux image build. Hosting variables supply credentials; neither the image nor GitHub contains secret values. GitHub-connected deployments replace local file copying and redeploy on source changes.

## Consequences

- The application chain and business rules remain unchanged.
- PostgreSQL preserves control-plane state across restarts/redeploys; the volume preserves Git metadata and working data.
- One container avoids a new distributed execution protocol. The internal Fastify port is not internet-exposed.
- A volume-backed service is intentionally single-replica in v0.3 and may have a short redeploy interruption. Horizontal execution coordination and object-storage workspaces remain future infrastructure work, not v0.3 product scope.
- Static hosting and function-only serverless platforms remain incompatible with the current Git/process execution adapter.
