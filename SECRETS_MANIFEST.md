# Secrets Manifest

Values are intentionally omitted. The live sandbox uses only these references:

| Reference | Provider/storage | Scope | Lifecycle |
|---|---|---|---|
| `AUTOPILOT_LIVE_SANDBOX_SUPABASE_ACCESS_TOKEN` | local gitignored `.env` | dedicated sandbox Supabase account | revoke through official Supabase account settings |
| `AUTOPILOT_BACKEND_AUTOPILOT_LIVE_SANDBOX_DB_PASSWORD` | local gitignored `.env` | database project `qtyfdzjzmgxtrarpgcmn` | rotate through the registered Supabase project operation |
| `AUTOPILOT_BACKEND_AUTOPILOT_LIVE_SANDBOX_DATABASE_URL` | local gitignored `.env` | database project `qtyfdzjzmgxtrarpgcmn` | regenerate after password rotation |
| `AUTOPILOT_LIVE_DATABASE_URL` | GitHub Actions secret in `momaibackend-ctrl/momnabackend` | live E2E workflow only | replace or delete through repository settings/semantic adapter |

The project-scoped `SECRETS_MANIFEST` artifact contains the same references and lifecycle metadata. Neither manifest contains credential values.

## Remote control-plane references

| Reference | Provider/storage | Scope | Lifecycle |
|---|---|---|---|
| `AUTOPILOT_CONTROL_DATABASE_URL` | GitHub Actions secret | control-plane PostgreSQL and migrations | rotate with the sandbox database credential |
| `AUTOPILOT_SUPABASE_SERVICE_ROLE_KEY` | GitHub Actions secret / Supabase managed Edge secret | Actions callback and private Storage | rotate in the registered Supabase project |
| `AUTOPILOT_SUPABASE_PUBLISHABLE_KEY` | GitHub Actions secret used at static build | browser Supabase Auth bootstrap; not privileged | rotate in the registered Supabase project |
| `AUTOPILOT_GITHUB_TOKEN` | GitHub Actions and Supabase Edge secrets | dedicated `momaibackend-ctrl` sandbox repositories | refresh/revoke with official GitHub OAuth; verify identity before provider writes |
| `AUTOPILOT_SUPABASE_ACCESS_TOKEN` | GitHub Actions secret | reproducible Edge/schema deployment | revoke through official Supabase account settings |
| `AUTOPILOT_MCP_TOKEN` | Supabase Edge and authorized MCP client only | remote semantic MCP | rotate both endpoints; never send to the browser |
| `AUTOPILOT_SUPERADMIN_MCP_TOKEN` | Supabase Edge and one authorized superadmin MCP client only | global semantic administration; separate from project-scoped MCP | rotate both endpoints; never send to the browser or use as a project token |
| `AUTOPILOT_RECONCILE_TOKEN` | Supabase Edge and reconciliation workflow only | scheduled recovery endpoint | rotate both endpoints |
| `AUTOPILOT_SSH_PRIVATE_KEY` | GitHub Environment `portable-runtime` only | SSH access to the explicitly configured Kamal server | rotate on the server and replace the environment secret |
| `KAMAL_REGISTRY_PASSWORD` | ephemeral workflow token or local ignored `.kamal/secrets` | push/pull only the GHCR runtime image | rotate/revoke in GitHub; never pass to the application container |

Local copies use the gitignored `.env` under their `AUTOPILOT_CONTROL_*` names. Deployed copies are server-side only. Workflow inputs contain only a job UUID, never any value above.

The portable application container receives no new credential: client bearer/OAuth headers are forwarded to the already authorized upstream. Its public hostname, server IP, upstream URLs, and OAuth authorization-server URL are non-secret deployment variables.
