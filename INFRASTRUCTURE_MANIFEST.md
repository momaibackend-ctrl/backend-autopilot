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
| GitHub Pages | static Operator Console | `https://momaibackend-ctrl.github.io/backend-autopilot/` | control-plane staging | active; HTTPS enforced; v0.5 workflow run `32485121737` passed |
| Supabase | Auth / Postgres / Storage / Edge | `qtyfdzjzmgxtrarpgcmn` | control-plane sandbox | active |
| Supabase Edge | Control API | `https://qtyfdzjzmgxtrarpgcmn.supabase.co/functions/v1/control-api` | control-plane sandbox | active |
| Supabase Edge | HTTP MCP v0.5 | `https://qtyfdzjzmgxtrarpgcmn.supabase.co/functions/v1/mcp` | control-plane sandbox | semantic SUPERADMIN surface; no shell/SQL/path |
| GitHub Actions | ephemeral execution | `autopilot-execution.yml` | sandbox targets only | v0.5 remote proof run `32485647205` passed |

Portable deployment artifacts are present (`docker/Dockerfile`, `config/deploy.yml`, manual GitHub Actions deployment), but no VPS or Cloudflare DNS record was created or adopted during this change. Such an external resource must be explicitly selected and registered before mutation. Render has no registry record and no repository dependency; see `docs/render-dependency-audit.md`.

The source repository is mutated only after `gh auth status` and `gh api user` both prove that `momaibackend-ctrl` is active with `ADMIN` authority. Stored accounts including `oopsie-star` are never logged out or modified. The published Console and HTTP MCP have separate authentication boundaries. v0.5 Supabase deploy `32484862615` and Linux CI `32485595615` passed. There is no persistent execution volume or always-on application service.
