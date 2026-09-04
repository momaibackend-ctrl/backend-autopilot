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
