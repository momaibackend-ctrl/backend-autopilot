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

## Next control-plane references (`supabase-next.yml` / `autopilot-execution-next.yml`, manual-only)

This manifest records which references the next-runtime workflows *require*; it cannot observe whether a given GitHub secret currently exists. Each workflow reports that itself, in a preflight step that prints missing secret **names** only and refuses to contact any provider until they are all present.

Only the five `AUTOPILOT_NEXT_*` references below are new. The next runtime reuses the existing `AUTOPILOT_GITHUB_TOKEN`, `AUTOPILOT_MCP_TOKEN`, `AUTOPILOT_SUPERADMIN_MCP_TOKEN` and `AUTOPILOT_RECONCILE_TOKEN` unchanged.

| Reference | Provider/storage | Scope | Lifecycle |
|---|---|---|---|
| `AUTOPILOT_NEXT_SUPABASE_ACCESS_TOKEN` | GitHub Actions secret | `supabase` CLI auth for the next project only | revoke through official Supabase account settings |
| `AUTOPILOT_NEXT_SUPABASE_URL` | GitHub Actions secret | next project's API URL; the deploy derives the 20-character project ref from its host and validates it, so no separate project-ref secret exists | replaced only if the next project itself changes |
| `AUTOPILOT_NEXT_DATABASE_URL` | GitHub Actions secret | next control-plane PostgreSQL: `pnpm db:migrate` in the deploy, and `DATABASE_URL` for `autopilot-execution-next.yml` | rotate in the next Supabase project |
| `AUTOPILOT_NEXT_R2_ACCOUNT_ID` / `AUTOPILOT_NEXT_R2_BUCKET_NAME` / `AUTOPILOT_NEXT_R2_ACCESS_KEY_ID` / `AUTOPILOT_NEXT_R2_SECRET_ACCESS_KEY` | GitHub Actions secrets; set as the next project's Edge secrets `AUTOPILOT_R2_*`, and passed directly to the next execution runner | `R2ArtifactBlobStore` on both the Edge and runner sides | rotate in Cloudflare R2 |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are **not** in this table and must never be set through `supabase secrets set`: Supabase reserves the `SUPABASE_` prefix and injects both into every hosted Edge Function automatically, scoped to the project the function runs in. `createEdgeRuntime` reads them with `Deno.env.get` and therefore picks up the next project's own pair once deployed there.

Legacy artifact reads need no duplicated secrets either. `supabase-next.yml` passes the **existing** `AUTOPILOT_SUPABASE_URL` and `AUTOPILOT_SUPABASE_SERVICE_ROLE_KEY` into the next project as its `AUTOPILOT_LEGACY_SUPABASE_URL` / `AUTOPILOT_LEGACY_SUPABASE_SERVICE_ROLE_KEY` Edge secrets, so `RoutingArtifactBlobStore` can keep resolving pre-cutover `storage.provider === "supabase"` references. That is a read credential handed to the new runtime -- nothing is deployed to, or changed in, the current Supabase project.

`autopilot-execution-next.yml` needs no Supabase Storage credential at all: with a complete `AUTOPILOT_R2_*` set, `createArtifactBlobStore` selects R2 and never resolves one. It references neither `AUTOPILOT_CONTROL_DATABASE_URL` nor the `AUTOPILOT_SUPABASE_*` pair.

`supabase-next.yml` is `workflow_dispatch`-only, requires its `confirm` input to equal exactly `DEPLOY_NEXT_SUPABASE`, and (until the migration branch merges) refuses to run from any branch other than `autopilot/migrate-next-supabase-r2`. No value from this table is ever printed by either workflow.
