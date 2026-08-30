import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const endpoint = "https://qtyfdzjzmgxtrarpgcmn.supabase.co/functions/v1/mcp";
const token = process.env["AUTOPILOT_SUPERADMIN_MCP_TOKEN"]!;
const projectId = "ac6d68be-272c-4bca-aab1-cd1a442cf960";
const root = "C:/tmp/qa";
const stamp = "momna-qa-testdb-02";
const KEY = "CORE-QA-06";

const created = [
  "src/test/kotlin/com/momna/platform/database/PostgresIntegrationDatabase.kt",
  "src/test/kotlin/com/momna/platform/database/PostgresIntegrationDatabaseTest.kt",
];
const updated = [
  "src/test/kotlin/com/momna/platform/database/PostgresContractIntegrationTest.kt",
  "src/test/kotlin/com/momna/platform/database/PostgresFieldRegistryIntegrationTest.kt",
  "src/test/kotlin/com/momna/platform/database/OptionalPostgresMigrationTest.kt",
  "src/test/kotlin/com/momna/platform/audit/PostgresAuditStoreIntegrationTest.kt",
  "src/test/kotlin/com/momna/platform/storage/OptionalS3SmokeTest.kt",
  ".github/workflows/ci.yml",
  ".env.example",
  "docs/handover/configuration.md",
  "docs/handover/local-development.md",
  "docs/handover/testing.md",
  "docs/handover/known-issues.md",
];
const changes = [
  ...created.map((p) => ({ path: p, content: readFileSync(join(root, p), "utf8"), operation: "CREATE" as const })),
  ...updated.map((p) => ({ path: p, content: readFileSync(join(root, p), "utf8"), operation: "UPDATE" as const })),
];

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const r = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }) });
  const raw = await r.text();
  if (!r.ok) throw new Error(`${method} ${r.status}: ${raw.slice(0, 500)}`);
  const d = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5).trim())).at(-1) ?? JSON.parse(raw);
  if (d.error) throw new Error(d.error.message);
  return d.result as T;
}
async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await rpc<{ isError?: boolean; structuredContent?: { result: T }; content?: Array<{ text?: string }> }>("tools/call", { name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${res.content?.map((v) => v.text).join("\n")}`);
  return (res.structuredContent?.result ?? JSON.parse(res.content![0]!.text!)) as T;
}
const brief = (label: string, v: unknown) => console.log(label, JSON.stringify(v).slice(0, 300));

const step = process.argv[2];

if (step === "create") {
  await call("superadmin_task_create", {
    operationId: `${stamp}-create`, projectId, externalKey: KEY,
    title: "Make the PostgreSQL integration suite impossible to skip silently in CI",
    description:
      "TEST_DATABASE_URL and POSTGRES_TEST_URL gated different PostgreSQL test classes while CI set only the first, and a test with no URL returned early, so PostgresContractIntegrationTest and PostgresFieldRegistryIntegrationTest reported green on every CI run without ever executing. Unify the test database configuration behind one resolver, make an unconfigured database a hard failure where the suite is declared mandatory, keep it explicitly skippable where it is not, and prove in CI that the required classes actually executed. Test infrastructure and CI only: no product behaviour, no Core contract, no API semantics, no schema and no migration changes.",
    requirements: [
      "Introduce one resolver that is the single place deciding where the test database is and whether the PostgreSQL suite runs.",
      "Make TEST_DATABASE_URL canonical and keep POSTGRES_TEST_URL working as a deprecated alias, so the two can never again gate different test classes.",
      "Where the suite is declared mandatory, an absent or placeholder database must fail the tests rather than return early.",
      "Where it is not declared mandatory, the tests must remain skippable and be reported as skipped rather than as passed.",
      "Improve the observability of the test suite itself: a skipped PostgreSQL layer must be visible as skipped in the JUnit report and in the CI log output, so what actually ran is never ambiguous to anyone reading the result.",
      "CI must set both variables from the same disposable PostgreSQL and declare the suite mandatory.",
      "CI must prove that every required PostgreSQL test class produced executed, non-skipped, non-failing cases, and fail otherwise.",
      "Cover the resolver itself with unit tests that need no database.",
      "Change no Kotlin main source, no migration, no contract registry file and no product behaviour.",
    ],
    relationships: [{ type: "SUPERSEDES", targetTaskId: "807dc366-fd09-4176-af4e-92ddb977a865" }],
  });
  console.log("created");
}

const tasks = await call<Array<{ id: string; externalKey: string; state: string }>>("superadmin_task_list", { projectId });
const task = tasks.find((t) => t.externalKey === KEY);
if (!task) throw new Error(`${KEY} not found`);
brief("task:", { id: task.id, state: task.state });

if (step === "analyze") brief("analyzed:", await call("superadmin_task_analyze", { operationId: `${stamp}-analyze`, projectId, taskId: task.id }));
if (step === "plan") brief("planned:", await call("superadmin_task_plan", { operationId: `${stamp}-plan`, projectId, taskId: task.id }));
if (step === "execute") {
  console.log(`executing ${changes.length} files, ${changes.reduce((n, c) => n + c.content.length, 0)} bytes`);
  brief("executed:", await call("superadmin_task_execute", { operationId: `${stamp}-exec`, projectId, taskId: task.id, changes }));
}
if (step === "status") {
  const s = await call<{ task: { state: string }; runs: Array<{ branch?: string; commitSha?: string }> }>("superadmin_task_status", { projectId, taskId: task.id });
  brief("status:", { state: s.task.state, run: s.runs.filter((r) => r.branch).at(-1) });
}
if (step === "readiness") brief("readiness:", await call("superadmin_task_readiness", { projectId, taskId: task.id }));
if (step === "pr" || step === "merge") {
  const canonical = await call<{ active: { resourceId: string; defaultBranch: string } }>("superadmin_canonical_repository_get", { projectId });
  const runs = await call<Array<{ branch?: string; commitSha?: string }>>("superadmin_run_list", { projectId, taskId: task.id });
  const head = runs.filter((r) => r.branch).at(-1)!;
  if (step === "pr")
    brief("pr:", await call("superadmin_sandbox_pull_request_open", {
      operationId: `${stamp}-pr`, projectId, taskId: task.id, resourceId: canonical.active.resourceId,
      base: canonical.active.defaultBranch, head: head.branch!,
      title: "Make the PostgreSQL integration suite impossible to skip silently in CI",
      body: "`TEST_DATABASE_URL` and `POSTGRES_TEST_URL` gated *different* PostgreSQL test classes while CI set only the first. Because a test with no URL returned early, `PostgresContractIntegrationTest` and `PostgresFieldRegistryIntegrationTest` reported green on every CI run without ever executing — a skipped layer and a passing layer were indistinguishable.\n\n- One resolver, `PostgresIntegrationDatabase`, now owns where the test database is. `TEST_DATABASE_URL` is canonical; `POSTGRES_TEST_URL` is a pure alias nothing reads directly.\n- `MOMNA_REQUIRE_POSTGRES_TESTS` declares the suite mandatory, which CI sets: an absent or placeholder database is then a hard failure.\n- Without that flag the suite stays skippable, but a skip is now *reported as a skip*, not as a pass.\n- A new CI step reads the JUnit results and fails unless every required PostgreSQL class produced executed, non-skipped, non-failing cases.\n- The resolver has 10 unit tests that need no database.\n\nTest infrastructure and CI only: no Kotlin main source, no migration, no contract registry file, no product behaviour.",
    }));
  if (step === "merge")
    brief("merged:", await call("superadmin_sandbox_pull_request_merge", { operationId: `${stamp}-merge`, projectId, taskId: task.id, resourceId: canonical.active.resourceId }));
}
