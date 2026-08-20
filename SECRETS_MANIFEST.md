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
| `DATABASE_URL` | hosting-managed secret/reference | Backend Autopilot control-plane PostgreSQL only | rotate in hosting provider; never point at a target-project database |
| `GH_TOKEN` | hosting server variable | dedicated `momaibackend-ctrl` sandbox identity | refresh/revoke with official GitHub OAuth; verify identity before every provider write |
| `AUTOPILOT_LIVE_SANDBOX_SUPABASE_ACCESS_TOKEN` | hosting server variable | registered sandbox Supabase account | revoke through official Supabase account settings |
| `AUTOPILOT_BACKEND_AUTOPILOT_LIVE_SANDBOX_DB_PASSWORD` | hosting server variable | registered target database only | rotate through the registered semantic operation |
| `AUTOPILOT_BACKEND_AUTOPILOT_LIVE_SANDBOX_DATABASE_URL` | hosting server variable | registered target database adapter only | regenerate after target password rotation |
| `AUTOPILOT_CONSOLE_BASIC_AUTH` | hosting server variable | public Operator Console access boundary | generate randomly; rotate in hosting variables and the owner's gitignored local `.env` |

Hosting variables are server-side only. The deployment snapshot contains the reference names above where required by registered resources, but never their values.
