# Infrastructure Manifest

Explicitly allowlisted live sandbox resources for project `ac6d68be-272c-4bca-aab1-cd1a442cf960`:

| Provider | Type | External reference | Environment | Status |
|---|---|---|---|---|
| GitHub | account | `momaibackend-ctrl` | sandbox | active |
| GitHub | private repository | `momaibackend-ctrl/momna-backend` | sandbox | active; canonical Momna product backend, created 2026-08-21 |
| GitHub | private repository | `momaibackend-ctrl/momnabackend` | sandbox | deleted; the separate 2026-08-19 proof repository, kept here only so its historical evidence resolves |
| Supabase | organization | `ijtsfyzuflwwodlwlryl` | sandbox | active |
| Supabase | project | `shzdgtatfonznkprnxrz` | sandbox | active |
| PostgreSQL | database | `supabase:shzdgtatfonznkprnxrz:postgres` | sandbox | active |
| Supabase | organization | `kfvanzquedbxzvotsuiv` | sandbox | retired with its project |
| Supabase | project | `qtyfdzjzmgxtrarpgcmn` | sandbox | retired; the egress allowance is exhausted and every Edge Function answers `402` |

`momnabackend` and `momna-backend` are two different repositories, not one repository renamed: `momnabackend` was registered on 2026-08-19 and has since been deleted, and `momna-backend` was created separately on 2026-08-21 and carries all of `CORE-BE-01..22`, the `CORE-QA`/`CORE-CONTRACT`/`CORE-HANDOVER` work and the `MOMNA-E17` onboarding definitions. GitHub serves no rename redirect between them.

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

The Resource Registry has not yet caught up with the control-plane cutover: it still records `qtyfdzjzmgxtrarpgcmn` and its database as `ACTIVE` and does not carry `shzdgtatfonznkprnxrz` at all. Nothing at runtime reads those rows to reach the control plane — the workflows derive the project from `AUTOPILOT_NEXT_SUPABASE_URL` and the local tooling from `AUTOPILOT_CONTROL_SUPABASE_URL` — so this is a registry-accuracy gap, not a live dependency on the retired project.

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
