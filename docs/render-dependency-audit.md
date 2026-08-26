# Render dependency audit

Audit baseline: commit `8d4c5aee48b7746efe919f6c73d86814563416e1` on `autopilot/mcp-reliability-phase2-checkpoints-heartbeat`.

| Category | Repository evidence | Result |
| --- | --- | --- |
| Runtime dependency | No Render imports, SDK, hostnames, environment variables, filesystem assumptions, or API calls | None |
| Deployment dependency | No `render.yaml`, Render Blueprint, deploy hook, CLI command, or Render workflow | None |
| Configuration dependency | No `RENDER_*`, `onrender.com`, callback, origin, or secret reference | None |
| Documentation only | No Render instructions or URLs before this audit | None |

The active remote architecture found by the audit was Supabase Edge/Auth/Postgres/Storage + GitHub Actions/Pages. AI Studio-specific code or callback configuration was not present. The old Dockerfile was incomplete as a public deployment artifact, but it was not Render-specific.

No Render resource was suspended automatically. The local Resource Registry has no active Render record, and neither a Render CLI login nor a Render credential reference exists. Direct discovery followed by mutation is prohibited by the repository's resource-ownership rules. If a legacy service exists, keep it as a disabled fallback and suspend that exact already-known service in the Render Dashboard, or first add a provider adapter and an active project-owned Resource Registry record. The official Render API operation for a known service is `POST /v1/services/{serviceId}/suspend`; do not list/discover services and then mutate an inferred match.

The portable runtime makes any untracked Render service disposable: it is outside DNS, OAuth discovery, MCP, Control API, CI, and deployment configuration.
