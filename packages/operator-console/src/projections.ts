import { redact } from "../../audit/src/index.js";
import type {
  Artifact,
  AuditEvent,
  Resource,
  Run,
  Task,
  Transition,
} from "../../schemas/src/index.js";

// Pure read-model projections shared by BOTH console backends: the node OperatorConsoleService and
// the Supabase Edge control-api.
//
// They live here rather than on OperatorConsoleService because that class cannot be constructed on
// the edge -- its DI surface needs a TestExecutor, a CommandRunner, a SecretProvider and a
// capabilities probe, none of which exist in an edge isolate. (Node builtins are NOT the blocker:
// node:path and node:crypto already ship in the deployed control-api.) Everything here is a pure
// function over data the caller already fetched, which is what stops the two backends drifting
// apart again -- the drift that left API Explorer, Database and Capabilities blank.

export const lifecycleStates = [
  "INGESTED",
  "ANALYZING",
  "PLANNED",
  "IMPLEMENTING",
  "TESTING",
  "REVIEWING",
  "READY",
] as const;

export function latestContent(artifacts: Artifact[], kind: Artifact["kind"]) {
  return artifacts.filter((value) => value.kind === kind).at(-1)?.content;
}

export function validationHistoryView(artifacts: Artifact[]) {
  return artifacts
    .filter((value) =>
      ["VALIDATION_REPORT", "API_REQUEST_RESULT", "VALIDATION_SCENARIO"].includes(value.kind),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function safeResource(resource: Resource) {
  return { ...resource, secretRefs: resource.secretRefs.map(() => "[SERVER_SIDE_SECRET]") };
}

export function shortSha(value?: string) {
  return value?.slice(0, 8) ?? "not committed";
}

export function transitionTitle(state: string) {
  return state === "READY"
    ? "Задача готова"
    : state === "BLOCKED"
      ? "Задача заблокирована"
      : state === "FAILED"
        ? "Выполнение завершилось ошибкой"
        : `Переход в ${state}`;
}

export function publicSchemaView(schema: unknown) {
  if (!schema || typeof schema !== "object") return undefined;
  const value = schema as Record<string, unknown>;
  const publicRows = (name: string) =>
    Array.isArray(value[name])
      ? (value[name] as Array<Record<string, unknown>>).filter((row) =>
          [row.table_schema, row.schemaname, row.routine_schema].some(
            (schemaName) => schemaName === "public",
          ),
        )
      : [];
  return {
    tables: publicRows("tables"),
    columns: publicRows("columns"),
    indexes: publicRows("indexes"),
    policies: publicRows("policies"),
    functions: publicRows("functions"),
  };
}

export function summarizeSchema(schema: unknown) {
  if (!schema || typeof schema !== "object") return [];
  const value = schema as {
    tables?: Array<{ table_schema: string; table_name: string }>;
    columns?: Array<{ table_schema: string; table_name: string; column_name: string }>;
    indexes?: Array<{ schemaname: string; tablename: string; indexname: string }>;
    policies?: Array<{ schemaname: string; tablename: string; policyname: string }>;
  };
  return [
    ...(value.tables ?? []).map((row) => `+ table ${row.table_schema}.${row.table_name}`),
    ...(value.columns ?? []).map(
      (row) => `+ column ${row.table_schema}.${row.table_name}.${row.column_name}`,
    ),
    ...(value.indexes ?? []).map(
      (row) => `+ index ${row.schemaname}.${row.tablename}.${row.indexname}`,
    ),
    ...(value.policies ?? []).map(
      (row) => `+ RLS policy ${row.schemaname}.${row.tablename}.${row.policyname}`,
    ),
  ];
}

export function databaseView(resources: Resource[], artifacts: Artifact[]) {
  const database = resources.find((value) => value.type === "DATABASE");
  const bootstrap = latestContent(artifacts, "BOOTSTRAP_REPORT") as
    | { database?: { schema?: unknown } }
    | undefined;
  const validation = artifacts
    .filter((value) => value.kind === "VALIDATION_REPORT")
    .map((value) => value.content as { schema?: unknown; schemaDiff?: unknown })
    .filter((value) => value.schema)
    .at(-1);
  const schema = publicSchemaView(validation?.schema ?? bootstrap?.database?.schema);
  return {
    provider: database?.provider,
    status: database?.status,
    migrations: artifacts.filter((value) => value.kind === "MIGRATION_MANIFEST"),
    schema,
    schemaDiff: validation?.schemaDiff ?? summarizeSchema(schema),
  };
}

export function apiView(artifacts: Artifact[]) {
  return {
    contracts: artifacts.filter((value) => value.kind === "API_CONTRACT"),
    requests: artifacts.filter((value) => value.kind === "API_REQUEST_RESULT"),
  };
}

/**
 * The seven-rung progress rail.
 *
 * BLOCKED and FAILED are real task states but deliberately not rungs -- they are conditions that
 * interrupt the walk rather than positions along it. A naive `indexOf(state)` returns -1 for them,
 * marking every rung incomplete and rendering an empty rail for exactly the tasks an operator most
 * needs to look at. Instead the rail keeps showing the progress the task genuinely made and reports
 * the interruption separately.
 */
export function lifecycleRail(state: string) {
  const interrupted = !lifecycleStates.includes(state as (typeof lifecycleStates)[number]);
  // A task can only be BLOCKED/FAILED from somewhere, and IMPLEMENTING is where the workflow engine
  // returns it, so that is the furthest rung its history proves it reached.
  const reached = interrupted
    ? lifecycleStates.indexOf("IMPLEMENTING")
    : lifecycleStates.indexOf(state as (typeof lifecycleStates)[number]);
  return {
    interrupted,
    ...(interrupted ? { interruptedBy: state } : {}),
    rungs: lifecycleStates.map((rung, index) => ({
      state: rung,
      complete: index <= reached,
      current: !interrupted && rung === state,
    })),
  };
}

export interface TimelineEvent {
  timestamp: string;
  title: string;
  kind: "STATE" | "RUN";
  status: string;
  summary: string;
  details: unknown;
}

/**
 * Merges lifecycle transitions and execution runs into one ordered story.
 *
 * `status` is required on every event because the console renders `tone(event.status)`, which calls
 * `.toUpperCase()`. Handing it a raw Transition -- which carries `from`/`to` but no `status` -- is
 * what made the whole task page throw on the deployed console.
 */
export function taskTimeline(transitions: Transition[], runs: Run[]): TimelineEvent[] {
  return [
    ...transitions.map((value) => ({
      timestamp: value.timestamp,
      title: transitionTitle(value.to),
      kind: "STATE" as const,
      status: value.to,
      summary: value.reason,
      details: redact(value),
    })),
    ...runs.map((value) => ({
      timestamp: value.startedAt,
      title: `Run ${value.status.toLowerCase()}`,
      kind: "RUN" as const,
      status: value.status,
      summary: `${value.branch ?? "branch pending"} · ${shortSha(value.commitSha)}`,
      details: redact(value),
    })),
  ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * Enriches one task from slices the caller already holds.
 *
 * Takes data rather than ids on purpose: the obvious (projectId, taskId) signature forces a
 * taskStatus call per task, which on the edge means three PostgREST round-trips per task on every
 * five-second poll -- on top of the project snapshot that already fetched all of it.
 */
export function taskSummaryFrom(input: { task: Task; artifacts: Artifact[]; runs: Run[] }) {
  const artifacts = input.artifacts.filter((value) => value.taskId === input.task.id);
  const runs = input.runs.filter((value) => value.taskId === input.task.id);
  const run = runs.at(-1);
  return {
    ...input.task,
    ...(run ? { currentRun: run } : {}),
    ...(run?.branch ? { branch: run.branch } : {}),
    ...(run?.commitSha ? { commitSha: run.commitSha } : {}),
    ci: latestContent(artifacts, "CI_REPORT"),
    review: latestContent(artifacts, "REVIEW_REPORT"),
    artifactCount: artifacts.length,
    warnings: artifacts
      .filter((value) => value.kind === "REVIEW_REPORT")
      .flatMap((value) => (value.content as { warnings?: unknown[] }).warnings ?? []),
  };
}

const evidenceActions = {
  remoteWrite: ["bootstrap.github.repository_created", "bootstrap.github.repository_initialized"],
  ci: ["bootstrap.github.ci_verified"],
  migrations: ["bootstrap.database.migration_verified"],
} as const;

function succeeded(result: unknown) {
  return Boolean(result && typeof result === "object" && (result as { success?: unknown }).success);
}

/**
 * Capabilities the control plane can honestly answer for.
 *
 * The real probe (packages/bootstrap/src/capabilities.ts) shells out to git/gh/supabase and opens a
 * pg pool, none of which exist in an edge isolate -- so it cannot run there and must not be faked.
 * Three honest layers instead: what the durable audit trail proves happened, the bootstrap snapshot
 * as dated evidence-of-record, and the live runtime composition. Anything not measurable from the
 * control plane says so, rather than reporting an interface as live.
 */
export function capabilitiesView(input: {
  audit: AuditEvent[];
  artifacts: Artifact[];
  runtime?: unknown;
}) {
  const evidence = Object.fromEntries(
    Object.entries(evidenceActions).map(([name, actions]) => {
      const event = input.audit.find(
        (value) => (actions as readonly string[]).includes(value.action) && succeeded(value.result),
      );
      return [
        name,
        event
          ? {
              status: "LIVE_TESTED",
              detail: `Proven by ${event.action}`,
              lastTestedAt: event.timestamp,
            }
          : { status: "NOT_VERIFIED", detail: "No successful audit evidence recorded yet" },
      ];
    }),
  );
  const snapshotArtifact = input.artifacts
    .filter((value) => value.kind === "CAPABILITY_SNAPSHOT" && value.status === "AVAILABLE")
    .at(-1);
  const snapshot = snapshotArtifact?.content as Record<string, unknown> | undefined;
  return {
    evidence,
    ...(input.runtime ? { runtime: input.runtime } : {}),
    ...(snapshot ? { snapshot } : {}),
    snapshotCapturedAt:
      (snapshot?.["capturedAt"] as string | undefined) ?? snapshotArtifact?.createdAt,
    note: snapshot
      ? "Snapshot is evidence-of-record captured at bootstrap, not a live probe."
      : "Binary probes (git/gh/supabase CLI) are not measurable from the control plane.",
  };
}
