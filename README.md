# Backend Autopilot v0.5

Backend Autopilot is a standalone, provider-neutral control plane for policy-checked and reproducible backend development. It is not a Momna backend and never discovers or trusts existing external resources automatically.

v0.5 adds a dedicated `SUPERADMIN` application boundary and authenticated HTTP MCP surface. A superadmin can administer every project and the server-driven Operator Console without project membership, while resource allowlisting, PolicyEngine, secret redaction and the hard production-write denial remain mandatory. The static Console uses Supabase Auth and an authenticated Edge Control API; durable state and artifacts live in Supabase; semantic execution requests enqueue GitHub Actions jobs. Fastify remains a local-development adapter only.

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

The navigation and safe text/metric/JSON blocks for Dashboard, Projects, Tasks, Runs, Validation Center, API Explorer, Database, Infrastructure, Artifacts, Audit, Capabilities, Settings, and future screens are persisted `ConsoleScreen` objects. `superadmin_screen_*` tools update those objects through the domain layer; the browser never edits or evaluates source code or HTML. Project and task drill-downs expose the complete evidence chain from requirements and plan through branch/commit, migration, tests, exact-SHA CI, IndependentReview, and final manifest.

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
Authorization: Bearer <AUTOPILOT_SUPERADMIN_MCP_TOKEN>
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

The separate superadmin credential activates 83 semantic tools, including complete project/task/job/run/artifact/scenario/validation/settings/screen/operator/membership administration and `superadmin_system_overview`. The ordinary project token remains project-scoped. External provisioning still requires explicit sandbox resources; destructive operations require operation IDs, exact object identity, confirmation enums and a reason. There is no shell, SQL console, filesystem path or arbitrary repository URL tool. See [MCP_CONTRACT.md](MCP_CONTRACT.md).

The deployed end-to-end proof is invoked only against HTTPS MCP and the live Pages Console:

```bash
pnpm superadmin:remote:e2e
```

It creates and edits temporary entities, drives a real task through the durable GitHub runner to `READY`, reads job/run/artifact/audit evidence, changes the Dashboard through `superadmin_screen_upsert`, verifies the rendered value in a real browser, then tombstones/archive-cleans the temporary control-plane records and deletes the temporary sandbox branch.

The completed v0.5 proof produced task `81aa842b-bdc6-44f0-b363-6d14ccfebf5a`, job `76c10d89-b102-408d-ad13-7dc5d1adfd10`, run `ea95ac09-3455-4f75-9400-c63dd879d727`, target commit `6806c50e21c4d30b320a8a09bd5f059111ac072e`, 24 lifecycle artifacts and successful Actions run `32485647205`. Its temporary project/task were tombstoned, the Console screen restored and the task branch removed after the proof.

## Verification

```bash
pnpm check
```

`pnpm check` runs lint, strict TypeScript, all Vitest unit/integration/security/E2E tests, both builds, seeds a sanitized persisted console fixture, starts the full API/UI pair, and runs Playwright Chromium E2E. `pnpm bootstrap` installs the local Chromium binary. CI installs Chromium plus its OS dependencies.

External live database tests run when `AUTOPILOT_LIVE_DATABASE_URL` is explicitly supplied. GitHub/Supabase live bootstrap is never triggered by the ordinary test suite.

The local E2E creates an isolated Git repository, intentionally fails security tests, commits a repair on the same task branch, reruns six suites, performs IndependentReview, and proves the formal `READY` gates. The completed live proof additionally used repository `momaibackend-ctrl/momnabackend`, Supabase project `qtyfdzjzmgxtrarpgcmn`, exact commit `6314f9b903cff61887b08f89c2d7754f60204f57`, GitHub Actions run `32264809746`, and pull request [#1](https://github.com/momaibackend-ctrl/momnabackend/pull/1).

See [OPERATOR_CONSOLE.md](OPERATOR_CONSOLE.md), [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md), [THREAT_MODEL.md](THREAT_MODEL.md), [RUNBOOK.md](RUNBOOK.md), and [SETUP_REQUIRED.md](SETUP_REQUIRED.md).
