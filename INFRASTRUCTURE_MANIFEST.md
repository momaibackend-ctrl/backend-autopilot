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
