# Infrastructure Manifest

Explicitly allowlisted live sandbox resources for project `ac6d68be-272c-4bca-aab1-cd1a442cf960`:

| Provider | Type | External reference | Environment | Status |
|---|---|---|---|---|
| GitHub | account | `momaibackend-ctrl` | sandbox | active |
| GitHub | private repository | `momaibackend-ctrl/momnabackend` | sandbox | active |
| Supabase | organization | `kfvanzquedbxzvotsuiv` | sandbox | active |
| Supabase | project | `qtyfdzjzmgxtrarpgcmn` | sandbox | active |
| PostgreSQL | database | `supabase:qtyfdzjzmgxtrarpgcmn:postgres` | sandbox | active |

The repository and Supabase project existed before registration; Backend Autopilot verified and adopted them rather than creating duplicates. Migration, RLS, Auth, Storage, CI, and PR evidence is retained in project-scoped artifacts and the audit log. Destruction remains unavailable without a separate resource-bound confirmation object.

## Control-plane deployment resources

| Provider | Type | External reference | Environment | Status |
|---|---|---|---|---|
| GitHub | public source repository | `momaibackend-ctrl/backend-autopilot` | control-plane staging | active; visibility explicitly changed by the owner for Pages |
| GitHub Pages | static Operator Console | `https://momaibackend-ctrl.github.io/backend-autopilot/` | control-plane staging | active; HTTPS enforced; workflow run `32480823254` passed |
| Supabase | Auth / Postgres / Storage / Edge | `qtyfdzjzmgxtrarpgcmn` | control-plane sandbox | active |
| Supabase Edge | Control API | `https://qtyfdzjzmgxtrarpgcmn.supabase.co/functions/v1/control-api` | control-plane sandbox | active |
| Supabase Edge | HTTP MCP | `https://qtyfdzjzmgxtrarpgcmn.supabase.co/functions/v1/mcp` | control-plane sandbox | active |
| GitHub Actions | ephemeral execution | `autopilot-execution.yml` | sandbox targets only | configured |

The source repository was used only after `gh auth status` and `gh api user` both proved that `momaibackend-ctrl` was active with `ADMIN` authority. Stored accounts including `oopsie-star` were not logged out or modified. The published Console passed a live browser path through Supabase Auth and the authenticated Edge Control API; its temporary test identity and memberships were removed afterward. There is no persistent execution volume or always-on application service.
