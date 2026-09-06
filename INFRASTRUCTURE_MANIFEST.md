# Infrastructure Manifest

Explicitly allowlisted live sandbox resources for project `ac6d68be-272c-4bca-aab1-cd1a442cf960`:

| Provider | Type | External reference | Environment | Status |
|---|---|---|---|---|
| GitHub | account | `momaibackend-ctrl` | sandbox | active |
| GitHub | private repository | `momaibackend-ctrl/momnabackend` | sandbox | active |
| Supabase | organization | `kfvanzquedbxzvotsuiv` | sandbox | active |
| Supabase | project | `shzdgtatfonznkprnxrz` | sandbox | active |
| PostgreSQL | database | `supabase:shzdgtatfonznkprnxrz:postgres` | sandbox | active |

Explicitly allowlisted resources for project `f40add71-0c6a-41f2-b407-9c858b500ab0` (`momna-backend-aicorn-org`):

| Provider | Type | External reference | Environment | Status |
|---|---|---|---|---|
| GitHub | organization account | `AICorn-Rocket-Group` | sandbox | active |
| GitHub | private repository | `AICorn-Rocket-Group/momna-backend` | sandbox | active; canonical development repository at version 1 |

This namespace is not owned by the sandbox identity. `momaibackend-ctrl` holds ADMIN on that one
repository as an explicitly invited collaborator and holds nothing else in the organization, which
is the entire basis on which the registration was accepted — see
`scripts/register-organization-repository.ts`. The repository is a separate project precisely
because a project has exactly one canonical development repository: registering it beside
`momaibackend-ctrl/momna-backend` would have left it unexecutable, and promoting it inside the
existing project would have superseded that mirror instead of adding to it. Either repository is
withdrawn from the connector at any time with `superadmin_resource_update` `status=DISABLED`, and
restored with `status=ACTIVE`; a disabled repository fails every execution, PR and read path with
`Resource is disabled`.

The repository and Supabase project existed before registration; Backend Autopilot verified and adopted them rather than creating duplicates. Migration, RLS, Auth, Storage, CI, and PR evidence is retained in project-scoped artifacts and the audit log. Destruction remains unavailable without a separate resource-bound confirmation object.

## Control-plane deployment resources

| Provider | Type | External reference | Environment | Status |
|---|---|---|---|---|
| GitHub | public source repository | `momaibackend-ctrl/backend-autopilot` | control-plane staging | active; visibility explicitly changed by the owner for Pages |
| GitHub Pages | static Operator Console | `https://momaibackend-ctrl.github.io/backend-autopilot/` | control-plane staging | active; HTTPS enforced; v0.5 workflow run `32485121737` passed |
| Supabase | Auth / Postgres / Storage / Edge | `shzdgtatfonznkprnxrz` | control-plane sandbox | active |
| Supabase Edge | Control API | `https://shzdgtatfonznkprnxrz.supabase.co/functions/v1/control-api` | control-plane sandbox | active |
| Supabase Edge | HTTP MCP v0.5 | `https://shzdgtatfonznkprnxrz.supabase.co/functions/v1/mcp` | control-plane sandbox | semantic SUPERADMIN surface; no shell/SQL/path |
| GitHub Actions | ephemeral execution | `autopilot-execution.yml` | sandbox targets only | v0.5 remote proof run `32485647205` passed |

The source repository is mutated only after `gh auth status` and `gh api user` both prove that `momaibackend-ctrl` is active with `ADMIN` authority. Stored accounts including `oopsie-star` are never logged out or modified. The published Console and HTTP MCP have separate authentication boundaries. v0.5 Supabase deploy `32484862615` and Linux CI `32485595615` passed. There is no persistent execution volume or always-on application service.
