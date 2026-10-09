// Entry point of the environment job (ADR 018): plan, start and verify one checked-out project,
// then write the evidence file the record job validates. It runs with no control-plane secret.
//
//   tsx scripts/run-ephemeral-environment.ts --source <dir> --out <evidence.json>
//       [--root <dir>] [--openapi <file>]... [--collection <file>]... [--strip-prefix /api]
//       [--run-id <id>] [--expect PROVEN|NOT_PROVEN] [--input <input.json>]
//       [--counterpart-source <dir>] [--counterpart-root <dir>] [--counterpart-label <name>]
//
// --counterpart-source runs a parity comparison: the reference implementation in that directory
// runs the same scenarios in its own fresh environment and every response is compared.
//
// --input is what the HTTP E2E prepare job hands over: {root?, stripPathPrefix?, scenarios?}. Saved
// scenarios in it replace the repository's own collections.
//
// Without --openapi/--collection the project's own contracts and Postman collections are found
// by the same discovery the control plane uses. The exit code is 0 whatever the verdict -- the
// verdict is evidence, not a crash -- unless --expect is given and does not match (self-test).
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { systemClock } from "../packages/core/src/ports.js";
import { DockerRuntime } from "../packages/ephemeral-environment/src/docker-runtime.js";
import { executeComparison, executeEnvironment } from "../packages/ephemeral-environment/src/executor.js";
import { planEnvironment, type ProjectFiles } from "../packages/ephemeral-environment/src/plan.js";
import { CommandPolicy } from "../packages/execution-engine/src/command-policy.js";
import { CommandRunner } from "../packages/execution-engine/src/command-runner.js";
import { extractApiOperations, importPostmanCollection, type ApiInventory, type ImportedScenario } from "../packages/http-runner/src/collection.js";
import { discoverRepositoryApi, parseStructuredDocument } from "../packages/http-runner/src/contract-discovery.js";

function options(argv: string[]) {
  const values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Unexpected argument ${key ?? ""}`);
    values.set(key.slice(2), [...(values.get(key.slice(2)) ?? []), value]);
    index += 1;
  }
  return values;
}

const skipped = new Set(["node_modules", ".git", ".gradle", "build", "dist", "target", ".venv", "venv", "__pycache__", ".next", ".autopilot-cache"]);
async function listFiles(root: string) {
  const files: Array<{ path: string; size: number }> = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (files.length >= 20_000) return;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skipped.has(entry.name)) await walk(absolute);
      } else if (entry.isFile()) files.push({ path: relative(root, absolute).split(sep).join("/"), size: (await stat(absolute)).size });
    }
  };
  await walk(root);
  return files;
}

async function main() {
  const args = options(process.argv.slice(2));
  const source = resolve(args.get("source")?.[0] ?? ".");
  const out = args.get("out")?.[0];
  if (!out) throw new Error("--out is required");
  const files = await listFiles(source);
  const read = (path: string) => readFile(join(source, path), "utf8").catch(() => undefined);
  const project: ProjectFiles = { paths: files.map((file) => file.path), read };
  const handed = args.get("input")?.[0]
    ? (JSON.parse(await readFile(args.get("input")?.[0] as string, "utf8")) as {
        root?: string;
        stripPathPrefix?: string;
        scenarios?: ImportedScenario[];
        counterpart?: { root?: string; label?: string };
      })
    : {};
  const root = args.get("root")?.[0] ?? handed.root;
  const plan = await planEnvironment(project, root === undefined ? {} : { root });

  let inventory: ApiInventory | undefined;
  let collections: unknown[] = [];
  const explicitContracts = args.get("openapi") ?? [];
  const explicitCollections = args.get("collection") ?? [];
  if (explicitContracts.length) {
    const merged: ApiInventory = { operations: [], excluded: [] };
    for (const path of explicitContracts) {
      const value = extractApiOperations(parseStructuredDocument(path, await readFile(path, "utf8")));
      merged.operations.push(...value.operations.map((operation) => ({ ...operation, contract: path })));
      merged.excluded.push(...value.excluded);
    }
    inventory = merged;
  }
  if (!explicitContracts.length || !explicitCollections.length) {
    const discovery = await discoverRepositoryApi({ commitSha: "local", listFiles: async () => ({ files, truncated: false }), readFile: read });
    if (!explicitContracts.length && (discovery.contracts.length || discovery.inventory.incomplete?.length)) inventory = discovery.inventory;
    if (!explicitCollections.length)
      collections = await Promise.all(discovery.collections.map(async (collection) => parseStructuredDocument(collection.path, (await read(collection.path)) ?? "")));
  }
  for (const path of explicitCollections) collections.push(parseStructuredDocument(path, await readFile(path, "utf8")));
  const stripPathPrefix = args.get("strip-prefix")?.[0] ?? handed.stripPathPrefix;
  const scenarios: ImportedScenario[] = [];
  if (handed.scenarios) {
    scenarios.push(...handed.scenarios);
    collections = [];
  }
  const importWarnings: unknown[] = [];
  for (const collection of collections) {
    const imported = importPostmanCollection(collection, stripPathPrefix ? { stripPathPrefix } : {});
    scenarios.push(...imported.scenarios);
    importWarnings.push({ collection: imported.collectionName, skipped: imported.skipped, warnings: imported.warnings });
  }

  const runId = args.get("run-id")?.[0] ?? process.env["GITHUB_RUN_ID"] ?? `${Date.now()}`;
  const commands = new CommandRunner(new CommandPolicy(), systemClock);
  const counterpartSource = args.get("counterpart-source")?.[0];
  let evidence;
  if (counterpartSource) {
    const referenceDirectory = resolve(counterpartSource);
    const referenceFiles = await listFiles(referenceDirectory);
    const referenceRoot = args.get("counterpart-root")?.[0] ?? handed.counterpart?.root;
    const referencePlan = await planEnvironment(
      { paths: referenceFiles.map((file) => file.path), read: (path) => readFile(join(referenceDirectory, path), "utf8").catch(() => undefined) },
      referenceRoot === undefined ? {} : { root: referenceRoot },
    );
    evidence = await executeComparison({
      plan,
      referencePlan,
      referenceLabel: args.get("counterpart-label")?.[0] ?? handed.counterpart?.label ?? "reference",
      scenarios,
      ...(inventory ? { inventory } : {}),
      runtime: new DockerRuntime(commands, source, `${runId}-sub`),
      referenceRuntime: new DockerRuntime(commands, referenceDirectory, `${runId}-ref`),
      runId,
    });
  } else evidence = await executeEnvironment({ plan, scenarios, ...(inventory ? { inventory } : {}), runtime: new DockerRuntime(commands, source, runId), runId });
  await writeFile(out, JSON.stringify({ ...evidence, collectionImport: importWarnings }, null, 2));
  const summary = {
    verdict: evidence.outcome.verdict,
    failure: evidence.outcome.failure,
    stack: plan.stack,
    steps: evidence.steps.map((step) => `${step.phase}:${step.status}:${step.name}`),
    coverage: (evidence.collection as { coverage?: { coveredOperations?: number; totalOperations?: number } } | undefined)?.coverage,
    ...(evidence.parity ? { parity: { verdict: evidence.parity.verdict, compared: evidence.parity.comparedSteps, differences: evidence.parity.differences.slice(0, 20) } } : {}),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (evidence.outcome.failure || evidence.outcome.verdict !== "PROVEN") {
    // Surface the failing step's own output in the job log, so a red self-test is diagnosable.
    const failed = evidence.steps.find((step) => step.status === "FAILED");
    if (failed?.logTail) console.log(`--- ${failed.phase} ${failed.name} ---\n${failed.logTail.slice(-6000)}`);
    if (evidence.applicationLogTail) console.log(`--- application log ---\n${evidence.applicationLogTail.slice(-6000)}`);
  }
  const expected = args.get("expect")?.[0];
  if (expected && expected !== evidence.outcome.verdict) {
    console.error(`Expected ${expected}, got ${evidence.outcome.verdict}: ${evidence.outcome.reasons.join("; ")}`);
    process.exitCode = 1;
  }
  // A self-test that only checks "NOT_PROVEN" would pass for the wrong reason too.
  const expectedFailure = args.get("expect-failure")?.[0];
  if (expectedFailure && expectedFailure !== evidence.outcome.failure?.class) {
    console.error(`Expected failure ${expectedFailure}, got ${evidence.outcome.failure?.class ?? "none"}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
