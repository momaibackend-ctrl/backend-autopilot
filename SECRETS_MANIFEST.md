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

## Next Supabase project references (`supabase-next.yml`, manual-only)

Not yet configured; the workflow fails closed until they are. Entirely separate from the references above -- none of them are read from or written to the current live Supabase project.

| Reference | Provider/storage | Scope | Lifecycle |
|---|---|---|---|
| `AUTOPILOT_NEXT_SUPABASE_ACCESS_TOKEN` | GitHub Actions secret | `supabase` CLI auth for the next project only | revoke through official Supabase account settings |
| `AUTOPILOT_NEXT_SUPABASE_PROJECT_REF` | GitHub Actions secret | next Supabase project ref | replaced only if the next project itself changes |
| `AUTOPILOT_NEXT_SUPABASE_URL` | GitHub Actions secret; becomes the next project's Edge secret `SUPABASE_URL` | new control-state store (`PostgrestStateStore`) | rotate in the next Supabase project |
| `AUTOPILOT_NEXT_SUPABASE_SERVICE_ROLE_KEY` | GitHub Actions secret; becomes the next project's Edge secret `SUPABASE_SERVICE_ROLE_KEY` | new control-state store | rotate in the next Supabase project |
| `AUTOPILOT_NEXT_R2_ACCOUNT_ID` | GitHub Actions secret; becomes the next project's Edge secret `AUTOPILOT_R2_ACCOUNT_ID` | R2ArtifactBlobStore | rotate in Cloudflare R2 |
| `AUTOPILOT_NEXT_R2_BUCKET_NAME` | GitHub Actions secret; becomes the next project's Edge secret `AUTOPILOT_R2_BUCKET_NAME` | R2ArtifactBlobStore | replaced only if the bucket changes |
| `AUTOPILOT_NEXT_R2_ACCESS_KEY_ID` | GitHub Actions secret; becomes the next project's Edge secret `AUTOPILOT_R2_ACCESS_KEY_ID` | R2ArtifactBlobStore | rotate in Cloudflare R2 |
| `AUTOPILOT_NEXT_R2_SECRET_ACCESS_KEY` | GitHub Actions secret; becomes the next project's Edge secret `AUTOPILOT_R2_SECRET_ACCESS_KEY` | R2ArtifactBlobStore | rotate in Cloudflare R2 |
| `AUTOPILOT_NEXT_LEGACY_SUPABASE_URL` | GitHub Actions secret; becomes the next project's Edge secret `AUTOPILOT_LEGACY_SUPABASE_URL` | reads pre-cutover `storage.provider === "supabase"` artifacts via `RoutingArtifactBlobStore`; points at the OLD/current live Supabase project's Storage, deliberately never at `SUPABASE_URL` itself | rotate in the current (soon-to-be-legacy) Supabase project |
| `AUTOPILOT_NEXT_LEGACY_SUPABASE_SERVICE_ROLE_KEY` | GitHub Actions secret; becomes the next project's Edge secret `AUTOPILOT_LEGACY_SUPABASE_SERVICE_ROLE_KEY` | same legacy artifact reads | rotate in the current (soon-to-be-legacy) Supabase project |

`supabase-next.yml` is `workflow_dispatch`-only, requires its `confirm` input to equal exactly `DEPLOY_NEXT_SUPABASE`, and never runs on push. No value from this table is ever printed by the workflow.
