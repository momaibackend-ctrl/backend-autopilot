import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// The control-plane cutover is expressed almost entirely in GitHub Actions YAML, which nothing
// else in this suite type-checks or executes. A wrong secret name there does not fail a build --
// it fails at 03:00 against a suspended Supabase project, or worse, silently keeps writing to the
// retired one. These tests read the real workflow files and assert the properties the cutover
// depends on, so a regression is caught in CI instead of in production.
//
// They deliberately assert on secret *names* and structural markers only. No value is involved.

const root = resolve(__dirname, "../..");
const workflowDirectory = join(root, ".github/workflows");
const workflow = (name: string): string => readFileSync(join(workflowDirectory, name), "utf8");

/**
 * The workflow with every `#` comment line removed. "This file must not reference X" is a claim
 * about what the runner will actually do, and the comments explaining *why* X was retired name X
 * by necessity -- asserting over the raw text would make documenting a decision indistinguishable
 * from reversing it.
 */
const executable = (source: string): string =>
  source
    .split("\n")
    .filter(line => !/^\s*#/.test(line))
    .join("\n");

const RETIRED_SECRETS = ["AUTOPILOT_CONTROL_DATABASE_URL", "AUTOPILOT_SUPABASE_URL", "AUTOPILOT_SUPABASE_SERVICE_ROLE_KEY"];
const OLD_SUPABASE_PROJECT_REF = "qtyfdzjzmgxtrarpgcmn";
const NEXT_R2_SECRETS = ["AUTOPILOT_NEXT_R2_ACCOUNT_ID", "AUTOPILOT_NEXT_R2_BUCKET_NAME", "AUTOPILOT_NEXT_R2_ACCESS_KEY_ID", "AUTOPILOT_NEXT_R2_SECRET_ACCESS_KEY"];
const R2_RUNTIME_VARIABLES = ["AUTOPILOT_R2_ACCOUNT_ID", "AUTOPILOT_R2_BUCKET_NAME", "AUTOPILOT_R2_ACCESS_KEY_ID", "AUTOPILOT_R2_SECRET_ACCESS_KEY"];
// The generic Backend Autopilot system project. It is the control plane's own record and predates
// the cutover; it is the ONE identifier the workflows are allowed to carry.
const SYSTEM_PROJECT_ID = "ac6d68be-272c-4bca-aab1-cd1a442cf960";

describe("canonical execution workflow is bound to the next control plane", () => {
  const raw = workflow("autopilot-execution.yml");
  const source = executable(raw);

  it("takes DATABASE_URL from the next Postgres and every R2 credential from the next bucket", () => {
    expect(source).toContain("DATABASE_URL: ${{ secrets.AUTOPILOT_NEXT_DATABASE_URL }}");
    for (const [index, runtimeVariable] of R2_RUNTIME_VARIABLES.entries())
      expect(source).toContain(`${runtimeVariable}: \${{ secrets.${NEXT_R2_SECRETS[index]} }}`);
  });

  it("references no retired control-plane secret", () => {
    for (const name of RETIRED_SECRETS) expect(source).not.toContain(name);
  });

  it("does not require the legacy Supabase artifact credential, which would make the suspended project a boot dependency", () => {
    expect(source).not.toContain("AUTOPILOT_LEGACY_SUPABASE_URL");
    expect(source).not.toContain("AUTOPILOT_LEGACY_SUPABASE_SERVICE_ROLE_KEY");
  });

  it("keeps the execution safety envelope: job-id-only input, read-only contents, per-job concurrency, timeout and JDK 21", () => {
    expect(source).toContain("permissions:\n  contents: read");
    expect(source).toContain("group: autopilot-execution-${{ inputs.job_id }}");
    expect(source).toContain("cancel-in-progress: false");
    expect(source).toContain("timeout-minutes: 60");
    expect(source).toContain("java-version: '21'");
    // The dispatch surface stays exactly one opaque identifier.
    expect(source.match(/^ {6}\w+:$/gm)).toEqual(["      job_id:"]);
    expect(source).toContain("AUTOPILOT_GITHUB_TOKEN: ${{ secrets.AUTOPILOT_GITHUB_TOKEN }}");
    expect(source).toContain("GH_TOKEN: ${{ secrets.AUTOPILOT_GITHUB_TOKEN }}");
  });

  it("is the only production execution workflow -- no parallel *-next twin survives the cutover", () => {
    expect(readdirSync(workflowDirectory)).not.toContain("autopilot-execution-next.yml");
  });
});

describe("canonical Supabase deploy targets only the next project", () => {
  const source = executable(workflow("supabase.yml"));

  it("is workflow_dispatch only for the first cutover, gated on an exact confirmation", () => {
    expect(source).toContain("on:\n  workflow_dispatch:");
    expect(source).not.toContain("  push:");
    expect(source).toContain('if [ "$CONFIRM_INPUT" != "DEPLOY_NEXT_SUPABASE" ]; then');
  });

  it("derives the project ref from AUTOPILOT_NEXT_SUPABASE_URL with a fully anchored pattern instead of hardcoding one", () => {
    expect(source).not.toContain(OLD_SUPABASE_PROJECT_REF);
    expect(source).toContain("AUTOPILOT_NEXT_SUPABASE_URL: ${{ secrets.AUTOPILOT_NEXT_SUPABASE_URL }}");
    expect(source).toContain("'^https://[a-z0-9]{20}\\.supabase\\.co/?$'");
    // SUPABASE_PROJECT_ID is what scripts/mcp-health-check.ts builds its endpoint from, so writing
    // the derived ref there is what points the health check at the NEW project automatically.
    expect(source).toContain('echo "SUPABASE_PROJECT_ID=$project_ref" >> "$GITHUB_ENV"');
    expect(source).toContain('supabase functions deploy --project-ref "$SUPABASE_PROJECT_ID"');
  });

  it("uses the next access token and next Postgres, and no retired secret", () => {
    expect(source).toContain("SUPABASE_ACCESS_TOKEN: ${{ secrets.AUTOPILOT_NEXT_SUPABASE_ACCESS_TOKEN }}");
    expect(source).toContain("DATABASE_URL: ${{ secrets.AUTOPILOT_NEXT_DATABASE_URL }}");
    for (const name of RETIRED_SECRETS) expect(source).not.toContain(name);
  });

  it("does not require legacy Supabase credentials to deploy or boot the new runtime", () => {
    expect(source).not.toContain("AUTOPILOT_LEGACY_SUPABASE_URL");
    expect(source).not.toContain("AUTOPILOT_LEGACY_SUPABASE_SERVICE_ROLE_KEY");
  });

  it("sets the R2 runtime configuration as Edge secrets, and never a reserved SUPABASE_* name", () => {
    for (const [index, runtimeVariable] of R2_RUNTIME_VARIABLES.entries()) {
      expect(source).toContain(`${runtimeVariable}: \${{ secrets.${NEXT_R2_SECRETS[index]} }}`);
      expect(source).toContain(`${runtimeVariable}="$${runtimeVariable}"`);
    }
    // Supabase rejects `supabase secrets set SUPABASE_*`; both are injected by the platform.
    expect(source).not.toMatch(/secrets set[\s\S]*?\n\s+SUPABASE_(URL|SERVICE_ROLE_KEY)=/);
  });

  it("carries the pre-existing generic control-plane configuration across unchanged", () => {
    for (const expected of [
      'AUTOPILOT_CONTROL_REPOSITORY="momaibackend-ctrl/backend-autopilot"',
      'AUTOPILOT_CONTROL_REF="main"',
      'AUTOPILOT_EXECUTION_WORKFLOW="autopilot-execution.yml"',
      `AUTOPILOT_SYSTEM_PROJECT_ID="${SYSTEM_PROJECT_ID}"`,
      'AUTOPILOT_OPERATOR_EMAILS="momaibackend@gmail.com"',
      'AUTOPILOT_SUPERADMIN_EMAILS="momaibackend@gmail.com"',
      `AUTOPILOT_OPERATOR_PROJECT_IDS="${SYSTEM_PROJECT_ID}"`,
      `AUTOPILOT_MCP_PROJECT_IDS="${SYSTEM_PROJECT_ID}"`,
      'AUTOPILOT_CONSOLE_ORIGINS="https://momaibackend-ctrl.github.io"',
      'AUTOPILOT_MCP_TOKEN="$AUTOPILOT_MCP_TOKEN"',
      'AUTOPILOT_SUPERADMIN_MCP_TOKEN="$AUTOPILOT_SUPERADMIN_MCP_TOKEN"',
      'AUTOPILOT_RECONCILE_TOKEN="$AUTOPILOT_RECONCILE_TOKEN"',
    ])
      expect(source).toContain(expected);
  });

  it("deploys and health-checks all three Edge Functions' shared runtime, then records a NEXT-lineage rollback point", () => {
    expect(source).toContain("pnpm mcp:health-check");
    // The old tag was health-checked against the OLD project; redeploying it into the new one
    // would ship an unrelated runtime, so the new lineage gets its own tag and nothing else.
    expect(source).toContain("mcp-next-last-good");
    expect(source).not.toMatch(/(?<!next-)mcp-last-good/);
  });

  it("fails closed rather than rolling back when no next-lineage known-good exists yet", () => {
    expect(source).toContain("if ! git fetch origin refs/tags/mcp-next-last-good:refs/tags/mcp-next-last-good; then");
    expect(source).toMatch(/no known-good deployment tag \(mcp-next-last-good\) exists[\s\S]*?exit 1/);
  });

  it("is the only production Supabase deploy workflow -- no parallel *-next twin survives the cutover", () => {
    expect(readdirSync(workflowDirectory)).not.toContain("supabase-next.yml");
  });
});

describe("reconciliation targets the next control plane", () => {
  const source = executable(workflow("autopilot-reconcile.yml"));

  it("builds the endpoint from AUTOPILOT_NEXT_SUPABASE_URL rather than the retired control-api secret", () => {
    expect(source).not.toContain("AUTOPILOT_CONTROL_API_URL");
    expect(source).toContain("NEXT_SUPABASE_URL: ${{ secrets.AUTOPILOT_NEXT_SUPABASE_URL }}");
    expect(source).toContain('RECONCILE_URL="${NEXT_SUPABASE_URL%/}/functions/v1/reconcile"');
  });

  it("validates the URL with the same anchored pattern the deploy uses, so the token cannot be redirected", () => {
    expect(source).toContain("'^https://[a-z0-9]{20}\\.supabase\\.co/?$'");
  });

  it("keeps the 15-minute schedule and the unchanged reconcile token", () => {
    expect(source).toContain('- cron: "*/15 * * * *"');
    expect(source).toContain("RECONCILE_TOKEN: ${{ secrets.AUTOPILOT_RECONCILE_TOKEN }}");
  });
});

describe("epic verification is bound to the next control plane too", () => {
  const source = executable(workflow("autopilot-epic-verification.yml"));

  it("uses the next Postgres and R2, not the retired database or Supabase Storage", () => {
    expect(source).toContain("DATABASE_URL: ${{ secrets.AUTOPILOT_NEXT_DATABASE_URL }}");
    for (const [index, runtimeVariable] of R2_RUNTIME_VARIABLES.entries())
      expect(source).toContain(`${runtimeVariable}: \${{ secrets.${NEXT_R2_SECRETS[index]} }}`);
    for (const name of RETIRED_SECRETS) expect(source).not.toContain(name);
  });
});

describe("the operator console on GitHub Pages is built against the next project", () => {
  // This is the workflow that actually decides which Supabase project the PUBLIC site talks to.
  // Next inlines every NEXT_PUBLIC_* value into the exported JavaScript at build time, so the
  // deployed bundle has no runtime configuration to correct: whatever this file passes to
  // `pnpm build:console` is what momaibackend-ctrl.github.io/backend-autopilot/ will contact until
  // the next deploy. Before the cutover it carried the old project's URL as a literal, which is
  // precisely why updating the secrets left the live console still calling the suspended project.
  const raw = workflow("pages.yml");
  const source = executable(raw);

  it("hardcodes no Supabase project URL at all, and no retired project ref anywhere", () => {
    expect(source).not.toMatch(/[a-z0-9]{20}\.supabase\.co/);
    expect(raw).not.toContain(OLD_SUPABASE_PROJECT_REF);
  });

  it("derives the console's Supabase URL and control-api URL from the one canonical secret", () => {
    // The same secret supabase.yml derives the deploy ref from and autopilot-reconcile.yml builds
    // its endpoint from, so console, control plane and reconciliation cannot land on different
    // projects.
    expect(source).toContain("secrets.AUTOPILOT_NEXT_SUPABASE_URL");
    expect(source).toContain("NEXT_PUBLIC_SUPABASE_URL=$base");
    expect(source).toContain("NEXT_PUBLIC_AUTOPILOT_CONTROL_API_URL=$base/functions/v1/control-api");
  });

  it("takes the publishable key from the next project's secret, not the retired one", () => {
    expect(source).toContain("secrets.AUTOPILOT_NEXT_SUPABASE_PUBLISHABLE_KEY");
    expect(source).not.toContain("secrets.AUTOPILOT_SUPABASE_PUBLISHABLE_KEY");
  });

  it("validates the URL with the same fully anchored pattern the deploy and reconcile use", () => {
    // Unanchored, this would accept the /rest/v1/ form -- which supabase-js must never be given as
    // a base URL, since it appends /rest/v1 itself -- as well as https://<ref>.supabase.co.evil.com.
    expect(source).toContain(String.raw`'^https://[a-z0-9]{20}\.supabase\.co/?$'`);
  });

  it("fails the build rather than publishing a console with no or foreign Supabase configuration", () => {
    // A blank NEXT_PUBLIC_SUPABASE_URL builds and deploys perfectly happily and produces a console
    // that cannot sign anyone in, which is far harder to diagnose than a red workflow.
    expect(source).toContain("AUTOPILOT_NEXT_SUPABASE_URL is not a Supabase project base URL");
    expect(source).toContain("references a Supabase project other than the configured one");
  });

  it("asserts on the BUILT artifact, the only place the inlined project ref can be observed", () => {
    expect(source).toMatch(/grep -rhoE '\[a-z0-9\]\{20\}\\.supabase\\.co' apps\/operator-console\/\.next-static/);
  });

  it("keeps the OAuth consent route that the authorization redirect lands on", () => {
    expect(source).toContain("apps/operator-console/.next-static/oauth-consent/index.html");
  });

  it("still publishes under the repository base path, so the public URL is unchanged", () => {
    expect(source).toContain("NEXT_PUBLIC_GITHUB_PAGES_BASE_PATH: /backend-autopilot");
  });

  it("deploys from main only -- no retired release branch keeps a stale build alive", () => {
    expect(source).toContain("branches: [main]");
    expect(source).not.toContain("autopilot/v0.5-superadmin-mcp");
  });
});

describe("the polled console views read bounded data, not whole project histories", () => {
  // The old Supabase project exceeded a 5 GB egress allowance by roughly eightfold. The cause was
  // not any single large transfer: the console dashboard polls /v1/console/overview from every open
  // tab, and that endpoint built each card from `projectSnapshot` -- every artifact WITH its inline
  // content, plus the project's entire audit trail -- to render artifact counts, one CI badge and
  // five recent events. Cost scaled with recorded history multiplied by tab-seconds. The new
  // project has the same allowance, so these are the assertions that keep it from repeating.
  const controlApi = readFileSync(join(root, "supabase/functions/control-api/index.ts"), "utf8");
  const overview = controlApi.slice(controlApi.indexOf("async function overview("), controlApi.indexOf("function consolePrincipal("));
  const console_ = readFileSync(join(root, "apps/operator-console/app/components.tsx"), "utf8");

  it("reads the overview function, so a rename cannot make this vacuously pass", () => {
    expect(overview.length).toBeGreaterThan(0);
    expect(overview).toContain("async function overview(");
  });

  it("no longer builds the polled overview from a full project snapshot", () => {
    expect(overview).not.toContain("projectSnapshot");
  });

  it("takes artifact counts from content-free digests and the CI badge from one artifact", () => {
    expect(overview).toContain("listArtifactDigests");
    expect(overview).toContain("latestArtifactOfKind");
    expect(overview).not.toContain("listArtifacts(");
  });

  it("takes the activity feed from a bounded audit read", () => {
    expect(overview).toContain("listRecentAudit");
    expect(overview).not.toContain("listAudit(");
  });

  it("suspends console polling while the tab is hidden", () => {
    // A tab left open polls for as long as the browser runs, watched or not; at a five-second
    // interval one forgotten background tab outweighs every real operator session.
    expect(console_).toContain("visibilitychange");
    expect(console_).toContain("document.hidden");
    // Every polled view goes through the one helper, so none can reintroduce a bare interval.
    expect(console_).not.toMatch(/setInterval\([^)]*5_000\)/);
  });
});

describe("product isolation: the cutover surface stays generic", () => {
  // Backend Autopilot is a generic control plane, and it is never the backend of a connected
  // product (AGENTS.md, "Product boundary"). A connected product may exist only as project,
  // resource and task DATA inside the control-plane database -- never as runtime code, deployment
  // configuration, a hardcoded repository, or a hardcoded project identifier.
  //
  // The guarded surface is the set of files the cutover itself authors: the canonical workflows
  // plus the R2/artifact-storage runtime closure and the Edge wiring that selects it. Two
  // deliberate exclusions, both about *pre-existing* content rather than anything introduced here:
  //
  //  - the migration-only workflows (`next-*.yml`), whose exclusion lists are task DATA copied
  //    from the control-plane database, which is exactly where product specifics belong;
  //  - `scripts/run-execution-job.ts`, whose blob-store selection this cutover rewrote but whose
  //    unrelated retry logic has carried historical `MOMNA-nnn` incident references in prose since
  //    long before it. Its cutover-authored line is asserted to be provider-neutral below instead.
  const guardedFiles = [
    ".github/workflows/autopilot-execution.yml",
    ".github/workflows/supabase.yml",
    ".github/workflows/autopilot-reconcile.yml",
    ".github/workflows/autopilot-epic-verification.yml",
    ".github/workflows/pages.yml",
    "packages/adapters/r2/src/artifact-storage.ts",
    "packages/adapters/artifact-storage/src/router.ts",
    "packages/adapters/artifact-storage/src/wiring.ts",
    "packages/adapters/supabase/src/artifact-storage.ts",
    "supabase/functions/_shared/edge-runtime.ts",
    "supabase/functions/_shared/edge-dependencies.ts",
    "supabase/functions/mcp/deno.json",
    "supabase/functions/control-api/deno.json",
    "supabase/functions/reconcile/deno.json",
  ];
  const contents = guardedFiles.map(path => ({ path, source: readFileSync(join(root, path), "utf8") }));

  it("reads every guarded file, so a renamed path cannot make this suite vacuously pass", () => {
    expect(contents.every(file => file.source.length > 0)).toBe(true);
    expect(contents).toHaveLength(guardedFiles.length);
  });

  it("names no connected product", () => {
    expect(contents.filter(file => /momna/i.test(file.source)).map(file => file.path)).toEqual([]);
  });

  it("carries no project identifier other than the control plane's own generic system project", () => {
    const pattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const found = new Set(contents.flatMap(file => file.source.match(pattern) ?? []).map(value => value.toLowerCase()));
    expect([...found]).toEqual([SYSTEM_PROJECT_ID]);
  });

  it("hardcodes no repository other than the control plane's own", () => {
    const found = new Set(contents.flatMap(file => file.source.match(/momaibackend-ctrl\/[A-Za-z0-9._-]+/g) ?? []));
    expect([...found]).toEqual(["momaibackend-ctrl/backend-autopilot"]);
  });

  it("keeps the execution runner's cutover-authored storage selection provider-neutral", () => {
    const runner = readFileSync(join(root, "scripts/run-execution-job.ts"), "utf8");
    expect(runner).toContain("import { createArtifactBlobStore } from '../packages/adapters/artifact-storage/src/wiring.js';");
    expect(runner).not.toContain("new SupabaseStorageArtifactBlobStore(");
  });
});

// The workflows moved to the next project, but the local developer entry points did not: the seed
// fixture kept naming the retired Supabase project and a repository that has since been deleted.
// Nothing failed, because a stale identifier here only surfaces as an opaque 401 or an E2E console
// showing resources that no longer exist. These assertions make that stale-by-omission case loud.
describe("local developer entry points name the live control plane, not the retired one", () => {
  const seed = readFileSync(join(root, "scripts/seed-console-e2e.ts"), "utf8");

  it("seeds no retired Supabase project reference", () => {
    expect(seed).not.toContain(OLD_SUPABASE_PROJECT_REF);
  });

  it("seeds only repositories that still exist", () => {
    // `momnabackend` was a separate repository from `momna-backend` and has been deleted.
    expect(seed).not.toMatch(/momaibackend-ctrl\/momnabackend\b/);
  });
});
