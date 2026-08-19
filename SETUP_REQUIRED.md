# Setup required

This machine has Node, pnpm, Git, GitHub CLI and Supabase CLI, but no Docker or local PostgreSQL client/server. To verify the persistent runtime exactly as documented, a human must install/start Docker Desktop (or provide a PostgreSQL 16 `DATABASE_URL`), then run:

```bash
docker compose up -d
pnpm db:migrate
```

No GitHub repository was created: several accounts are configured and selecting an external owner is an authorization choice. If publishing is wanted, choose the owner explicitly and run `gh repo create <owner>/backend-autopilot --private --source .`.

No Supabase authorization is required for the control plane. Add target-scoped credentials only when an explicitly registered sandbox Supabase project is introduced.
