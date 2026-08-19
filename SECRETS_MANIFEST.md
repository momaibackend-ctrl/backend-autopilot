# Secrets Manifest

Values are intentionally omitted. The live sandbox uses only these references:

| Reference | Provider/storage | Scope | Lifecycle |
|---|---|---|---|
| `AUTOPILOT_LIVE_SANDBOX_SUPABASE_ACCESS_TOKEN` | local gitignored `.env` | dedicated sandbox Supabase account | revoke through official Supabase account settings |
| `AUTOPILOT_BACKEND_AUTOPILOT_LIVE_SANDBOX_DB_PASSWORD` | local gitignored `.env` | database project `qtyfdzjzmgxtrarpgcmn` | rotate through the registered Supabase project operation |
| `AUTOPILOT_BACKEND_AUTOPILOT_LIVE_SANDBOX_DATABASE_URL` | local gitignored `.env` | database project `qtyfdzjzmgxtrarpgcmn` | regenerate after password rotation |
| `AUTOPILOT_LIVE_DATABASE_URL` | GitHub Actions secret in `momaibackend-ctrl/momnabackend` | live E2E workflow only | replace or delete through repository settings/semantic adapter |

The project-scoped `SECRETS_MANIFEST` artifact contains the same references and lifecycle metadata. Neither manifest contains credential values.
