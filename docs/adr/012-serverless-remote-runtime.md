# ADR 012: Serverless remote runtime

Status: accepted for v0.4; supersedes ADR 011 for production deployment.

## Context

The local v0.3 composition required a Windows process, a Next server, Fastify and persistent filesystem workspaces. The required deployment may use only GitHub Pages, Supabase and GitHub Actions, with no continuously running application server.

## Decision

Deploy the Operator Console as a Next.js static export on GitHub Pages. Authenticate operators with Supabase Auth. Run the protected Control API and stateless HTTP MCP as Supabase Edge Functions. Store state in Supabase Postgres and large artifacts in a private Storage bucket. Represent long work as durable execution jobs and dispatch only their UUID to a fixed GitHub Actions workflow. Each runner re-authorizes the registered sandbox resource, obtains a distributed lease, creates an ephemeral checkout and records branch/SHA/results before exit. A scheduled Actions workflow invokes a short-lived reconciliation function.

Fastify, local Git and stdio MCP remain development adapters, not production dependencies. `AUTONOMOUS_PRODUCTION` and all production writes remain technically unsupported.

## Consequences

- The local computer and persistent workspace volumes are not required after deployment.
- Edge requests remain short and never run subprocesses.
- Job operation IDs, database uniqueness and leases provide duplicate/concurrency protection.
- Repository recovery uses registered identity plus the persisted exact task branch and SHA.
- GitHub Actions and Supabase are explicit provider adapters; the domain layer remains unchanged and can accept other providers later.
