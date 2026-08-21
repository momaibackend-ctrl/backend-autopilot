# Backend Autopilot v0.4

Backend Autopilot is a standalone, provider-neutral control plane for policy-checked and reproducible backend development. It is not a Momna backend and never discovers or trusts existing external resources automatically.

v0.4 moves the production runtime off the developer workstation. The static Operator Console uses Supabase Auth and an authenticated Edge Control API; durable state and artifacts live in Supabase; semantic execution requests enqueue GitHub Actions jobs. Fastify remains a local-development adapter only.

## Remote deployment

The canonical source is the public sandbox repository `momaibackend-ctrl/backend-autopilot`. Its visibility was explicitly changed by the owner so the free account can publish Pages. Four reproducible workflows deploy and operate the remote system:

- `pages.yml` builds a Next.js static export and deploys GitHub Pages.
- `supabase.yml` applies versioned SQL, sets Edge secret references and deploys Edge Functions.
- `autopilot-execution.yml` claims one durable job, clones only its registered repository, installs dependencies, changes a deterministic task branch, tests, reviews, pushes and records evidence.
- `autopilot-reconcile.yml` periodically repairs terminal workflow states that could not write their callback.

Remote state uses project `qtyfdzjzmgxtrarpgcmn`: PostgreSQL stores envelopes and relational ownership metadata; the private `autopilot-artifacts` Storage bucket stores large blobs. Jobs have operation-id idempotency, per-task distributed claim/lease, exact branch/SHA recovery and bounded repair attempts. No persistent workspace volume or always-on application process exists.

Server credentials exist only as Supabase Edge secrets and GitHub Actions secrets. The browser receives only the Supabase URL and publishable key. See `SECRETS_MANIFEST.md`; no manifest contains credential values.

## Operator Console

```bash
cp .env.example .env
pnpm bootstrap
pnpm dev
```

For local development, open [http://localhost:3000](http://localhost:3000). The explicit `NEXT_PUBLIC_AUTOPILOT_LOCAL_DEV=true` test/dev composition uses the local Fastify proxy. Production builds never set that flag: they are static files that call the authenticated HTTPS Edge API directly. The live HTTPS Console is [https://momaibackend-ctrl.github.io/backend-autopilot/](https://momaibackend-ctrl.github.io/backend-autopilot/).

`pnpm pages:e2e` is the reproducible live browser gate. It requires explicit sandbox URL/ref, the permanent operator email list, and existing gitignored credential references. It creates a confirmed one-use Supabase Auth identity, verifies Pages → Auth → Edge API → live Postgres state, then deletes the identity and restores the permanent allowlist even when the test fails.

The main sections are Dashboard, Projects, Tasks, Runs, Validation, Infrastructure, Artifacts, Audit, Capabilities, and Settings. Project and task drill-downs expose the complete evidence chain from requirements and plan through branch/commit, migration, tests, exact-SHA CI, IndependentReview, and final manifest.

Validation suites: `SMOKE`, `CRUD`, `AUTHENTICATION`, `AUTHORIZATION`, `RLS`, `REGRESSION`, and `FULL`. The API Explorer is generated from persisted OpenAPI artifacts. Request Runner and saved scenarios require an explicitly registered, non-production `HTTP_API` resource. Browser credentials and production validation are technically rejected.

## Lightweight start — Docker is optional

Prerequisites: Node.js 22+, pnpm 10, and Git. The durable bootstrap registry uses `.autopilot/state.json` until an external control-plane `DATABASE_URL` is configured.

```bash
cp .env.example .env
pnpm bootstrap
pnpm check
pnpm dev
```

Docker Compose remains an optional local PostgreSQL convenience, not a dependency. To use an external PostgreSQL control plane, place its URL in the gitignored `.env`, then run `pnpm db:migrate` and restart the service. Target database URLs are always project-scoped secret references.

## Actual capabilities

```bash
pnpm autopilot capabilities
pnpm autopilot capabilities --project <project-id>
```

Statuses are evidence-based: `SUPPORTED`, `CONFIGURED`, `LIVE_TESTED`, `MOCK`, `NOT_CONFIGURED`, or `NOT_SUPPORTED`. An implemented adapter is never reported as live until audit evidence exists.

## Autonomous sandbox bootstrap

1. Create an `AUTONOMOUS_STAGING` project with environment `STAGING` and a clean sandbox Git workspace.
2. Log in through official provider flows only when requested:

   ```bash
   gh auth login --web --hostname github.com
   gh auth switch --hostname github.com --user <dedicated-sandbox-login>
   supabase login
   ```

3. Confirm that each active identity is a dedicated sandbox account. Backend Autopilot detects and registers account/organization IDs itself:

   ```bash
   pnpm autopilot sandbox-github-register --project <id> --expected-login <dedicated-sandbox-login> --confirm-dedicated-sandbox
   pnpm autopilot sandbox-github-repository-register --project <id> --account-resource <id> --repository <owner/name> --confirm-explicit-sandbox-target
   pnpm autopilot sandbox-supabase-register --project <id> --confirm-dedicated-sandbox
   ```

4. Register the exact existing Supabase target, configure its generated database credential, then call `sandbox_bootstrap` through MCP or the CLI:

   ```bash
   pnpm autopilot sandbox-supabase-project-register --project <id> --organization-resource <id> --expected-project-ref <ref> --confirm-explicit-sandbox-target
   pnpm autopilot sandbox-supabase-database-configure --project <id> --supabase-project-resource <id> --confirm-credential-rotation
   pnpm autopilot sandbox-bootstrap --file bootstrap.json
   ```

Bootstrap either creates a policy-named private sandbox repository or adopts exactly one human-confirmed existing private repository owned by the active sandbox identity. Existing GitHub accounts are never logged out. It creates or adopts one explicitly authorized Supabase sandbox project, stores generated database credentials only in `.env`, registers resources, waits for the database, applies versioned migrations, configures structured RLS, optionally configures Auth/Storage, observes CI, writes manifests, and captures capabilities.

For an implementation run, `sandbox_github_ci_verify` binds CI evidence to the exact commit SHA before IndependentReview can make a GitHub-backed task `READY`. `sandbox_github_pull_request_open` then opens one idempotent PR from that task's exact `autopilot/*` branch.

Passwords are never accepted as persistent inputs. Generated secrets are replaceable through `MutableSecretProvider`; manifests contain reference names and lifecycle procedures only.

## MCP

Production MCP is an authenticated, stateless Streamable HTTP endpoint:

```text
https://qtyfdzjzmgxtrarpgcmn.supabase.co/functions/v1/mcp
Authorization: Bearer <AUTOPILOT_MCP_TOKEN>
```

Local stdio remains available for development:

```json
{
  "mcpServers": {
    "backend-autopilot": {
      "command": "pnpm",
      "args": ["--dir", "C:/absolute/path/backend-autopilot", "mcp"]
    }
  }
}
```

The MCP surface has semantic operations only. External provisioning requires explicit sandbox account resources; deletion requires separate destructive tools and matching confirmation objects. See [MCP_CONTRACT.md](MCP_CONTRACT.md).

## Verification

```bash
pnpm check
```

`pnpm check` runs lint, strict TypeScript, all Vitest unit/integration/security/E2E tests, both builds, seeds a sanitized persisted console fixture, starts the full API/UI pair, and runs Playwright Chromium E2E. `pnpm bootstrap` installs the local Chromium binary. CI installs Chromium plus its OS dependencies.

External live database tests run when `AUTOPILOT_LIVE_DATABASE_URL` is explicitly supplied. GitHub/Supabase live bootstrap is never triggered by the ordinary test suite.

The local E2E creates an isolated Git repository, intentionally fails security tests, commits a repair on the same task branch, reruns six suites, performs IndependentReview, and proves the formal `READY` gates. The completed live proof additionally used repository `momaibackend-ctrl/momnabackend`, Supabase project `qtyfdzjzmgxtrarpgcmn`, exact commit `6314f9b903cff61887b08f89c2d7754f60204f57`, GitHub Actions run `32264809746`, and pull request [#1](https://github.com/momaibackend-ctrl/momnabackend/pull/1).

See [OPERATOR_CONSOLE.md](OPERATOR_CONSOLE.md), [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md), [THREAT_MODEL.md](THREAT_MODEL.md), [RUNBOOK.md](RUNBOOK.md), and [SETUP_REQUIRED.md](SETUP_REQUIRED.md).
