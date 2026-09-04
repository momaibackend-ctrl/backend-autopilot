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

Local copies use the gitignored `.env` under their `AUTOPILOT_CONTROL_*` names. Deployed copies are server-side only. Workflow inputs contain only a job UUID, never any value above.

`AUTOPILOT_CONTROL_DATABASE_URL`, `AUTOPILOT_SUPABASE_URL` and `AUTOPILOT_SUPABASE_SERVICE_ROLE_KEY` are **retired** as of the control-plane cutover: no workflow references them any more. They are kept in the table above only as a record of what the pre-cutover deployment used, and can be deleted from repository settings once the historical artifact blobs have been copied into R2.

## Next control-plane references (post-cutover canonical deployment)

This manifest records which references the canonical workflows *require*; it cannot observe whether a given GitHub secret currently exists. Each workflow reports that itself, in a preflight step that prints missing secret **names** only and refuses to contact any provider until they are all present.

Only the five `AUTOPILOT_NEXT_*` references below are new. The runtime reuses the existing `AUTOPILOT_GITHUB_TOKEN`, `AUTOPILOT_MCP_TOKEN`, `AUTOPILOT_SUPERADMIN_MCP_TOKEN` and `AUTOPILOT_RECONCILE_TOKEN` unchanged.

| Reference | Provider/storage | Scope | Lifecycle |
|---|---|---|---|
| `AUTOPILOT_NEXT_SUPABASE_ACCESS_TOKEN` | GitHub Actions secret | `supabase` CLI auth for the next project only | revoke through official Supabase account settings |
| `AUTOPILOT_NEXT_SUPABASE_URL` | GitHub Actions secret | next project's API URL; `supabase.yml` derives and validates the 20-character project ref from its host, and `autopilot-reconcile.yml` builds `/functions/v1/reconcile` from it, and `pages.yml` derives the console's `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_AUTOPILOT_CONTROL_API_URL` from it, so no separate project-ref or control-API-URL secret exists. It must be the bare project base URL (`https://<ref>.supabase.co`) -- a `/rest/v1/` form fails every workflow's anchored validation, and supabase-js appends `/rest/v1` itself | replaced only if the next project itself changes |
| `AUTOPILOT_NEXT_SUPABASE_MANAGEMENT_TOKEN` (optional) | GitHub Actions secret | account-level Supabase token used ONLY by the deploy's `pnpm oauth:configure` step, to read and correct the GoTrue OAuth server settings the ChatGPT connector depends on; the scoped deploy token is refused (403) by that endpoint | revoke through official Supabase account settings. If absent, the deploy still succeeds but emits a `::warning::` that the OAuth configuration was not verified |
| `AUTOPILOT_NEXT_SUPABASE_PUBLISHABLE_KEY` | GitHub Actions secret, inlined into the static console at build time by `pages.yml` | browser Supabase Auth bootstrap for the next project; not privileged (it is public by design once the bundle ships) | rotate in the next Supabase project, then re-run the Pages deploy -- the value is baked into the published bundle, so rotating alone does not take effect |
| `AUTOPILOT_REMOTE_MCP_URL` | GitHub Actions secret; local `.env` for the remote E2E scripts | the next project's `/functions/v1/mcp` endpoint | replaced only if the next project itself changes |
| `AUTOPILOT_NEXT_DATABASE_URL` | GitHub Actions secret | next control-plane PostgreSQL: `pnpm db:migrate` in the deploy, and `DATABASE_URL` for `autopilot-execution.yml` and `autopilot-epic-verification.yml` | rotate in the next Supabase project |
| `AUTOPILOT_NEXT_R2_ACCOUNT_ID` / `AUTOPILOT_NEXT_R2_BUCKET_NAME` / `AUTOPILOT_NEXT_R2_ACCESS_KEY_ID` / `AUTOPILOT_NEXT_R2_SECRET_ACCESS_KEY` | GitHub Actions secrets; set as the next project's Edge secrets `AUTOPILOT_R2_*`, and passed directly to the execution and epic-verification runners | `R2ArtifactBlobStore` on both the Edge and runner sides | rotate in Cloudflare R2 |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are **not** in this table and must never be set through `supabase secrets set`: Supabase reserves the `SUPABASE_` prefix and injects both into every hosted Edge Function automatically, scoped to the project the function runs in. `createEdgeRuntime` reads them with `Deno.env.get` and therefore picks up the next project's own pair once deployed there.

`AUTOPILOT_LEGACY_SUPABASE_URL` / `AUTOPILOT_LEGACY_SUPABASE_SERVICE_ROLE_KEY` are supported by `readLegacySupabaseConfigFromEnv` but are **deliberately not configured by any workflow** for the first cutover. The previous Supabase project is suspended, so requiring them would make a dead provider a boot dependency of the new control plane. Every new externalized artifact is written to R2; reads of pre-cutover `storage.provider = "supabase"` references fail closed with a typed `CredentialMissing` until those historical blobs are separately copied into R2. That is a known, bounded limitation, not a fallback to the old project.

The canonical deploy is `workflow_dispatch`-only and requires its `confirm` input to equal exactly `DEPLOY_NEXT_SUPABASE`. Its rollback point is the `mcp-next-last-good` tag, scoped to the next project's own deployment lineage; the pre-cutover `mcp-last-good` tag is never redeployed into it. No value from any table above is ever printed by any workflow.
