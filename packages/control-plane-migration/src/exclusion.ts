import { assertSafeIdentifier, type TablePlan } from './plan.js';

/**
 * Migration-only exclusion: a caller-supplied denylist of task ids, and the closure of rows that
 * exist solely as those tasks' history, are never written to the target.
 *
 * Nothing here knows *which* tasks. The ids arrive as an explicit argument from the migration
 * entrypoint (`--exclude-task-id`, repeatable, or a typed env list), so this library stays a
 * general mechanism rather than a record of one incident. The source is never modified in any way:
 * exclusion is a filter on what gets copied, not a deletion.
 *
 * The closure is derived only from structured references -- real foreign-key columns, plus scalar
 * JSON paths that the schemas actually define. It is never derived from a title, an external key,
 * an age, a project, or a substring search, because none of those prove that a row belongs to an
 * excluded task.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accepts repeated flags and comma-separated lists, validates every entry as a UUID, dedupes and sorts so the closure is deterministic whatever order the caller used. */
export function parseExcludedTaskIds(values: readonly string[]): string[] {
  const candidates = values.flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean);
  for (const candidate of candidates) if (!UUID.test(candidate)) throw new Error(`Excluded task id is not a UUID: ${candidate}`);
  return [...new Set(candidates.map(value => value.toLowerCase()))].sort();
}

export interface ExclusionClosure {
  /** Every excluded task: the caller's denylist plus every task that recursively depends on one. */
  readonly tasks: readonly string[];
  /** The denylist as given, intersected with what actually exists. */
  readonly rootTasks: readonly string[];
  /** Tasks pulled in by `relationships[].targetTaskId`, at any depth. */
  readonly dependentTasks: readonly string[];
  /** `operation_id` of every excluded run and execution job -- the key that ties an admin operation or audit correlation to this work. */
  readonly operationIds: readonly string[];
  readonly runs: readonly string[];
  readonly executionJobs: readonly string[];
  readonly artifacts: readonly string[];
  readonly taskTransitions: readonly string[];
  readonly auditEvents: readonly string[];
  readonly adminOperations: readonly string[];
}

export const emptyClosure = (): ExclusionClosure => ({ tasks: [], rootTasks: [], dependentTasks: [], operationIds: [], runs: [], executionJobs: [], artifacts: [], taskTransitions: [], auditEvents: [], adminOperations: [] });

/**
 * The reference graph this closure is allowed to follow, as it exists in the real schema:
 *
 *   runs.task_id, artifacts.task_id, artifacts.run_id, execution_jobs.task_id,
 *   execution_jobs.run_id, task_transitions.task_id   -- declared foreign keys
 *   audit_events.data->>'taskId'                      -- auditEventSchema.taskId
 *
 * `admin_operations` has no such reference (operationId/actor/tool/projectId/result only), and no
 * other copied table references a task at all.
 */
export const structuredTaskReferences = [
  { table: 'runs', reference: 'runs.task_id', kind: 'FOREIGN_KEY' },
  { table: 'artifacts', reference: 'artifacts.task_id', kind: 'FOREIGN_KEY' },
  { table: 'artifacts', reference: 'artifacts.run_id', kind: 'FOREIGN_KEY' },
  { table: 'execution_jobs', reference: 'execution_jobs.task_id', kind: 'FOREIGN_KEY' },
  { table: 'execution_jobs', reference: 'execution_jobs.run_id', kind: 'FOREIGN_KEY' },
  { table: 'task_transitions', reference: 'task_transitions.task_id', kind: 'FOREIGN_KEY' },
  { table: 'audit_events', reference: "audit_events.data->>'taskId'", kind: 'CANONICAL_JSON_PATH' },
  { table: 'tasks', reference: "tasks.data->'relationships'[*]->>'targetTaskId'", kind: 'CANONICAL_JSON_PATH_RECURSIVE' },
  { table: 'runs', reference: 'runs.operation_id', kind: 'OPERATION_SOURCE' },
  { table: 'execution_jobs', reference: 'execution_jobs.operation_id', kind: 'OPERATION_SOURCE' },
  { table: 'admin_operations', reference: 'admin_operations.operation_id', kind: 'CANONICAL_OPERATION_KEY' },
  { table: 'audit_events', reference: "audit_events.data->>'correlationId'", kind: 'CANONICAL_OPERATION_KEY' },
] as const;

/**
 * Tables whose rows are pure history: they record what happened to work, they are not the work.
 * Only these may additionally be excluded by an exact scalar match anywhere in their structured
 * JSON -- and only against an excluded task id, run id or operation id.
 *
 * The operational tables are deliberately absent. A task leaves only by the denylist or by the
 * recursive relationship path; a run, job or transition leaves only by a declared foreign key.
 * Nothing about them is ever decided by looking inside a JSON document.
 */
export const historicalTables = ['artifacts', 'audit_events', 'admin_operations'] as const;
export const isHistoricalTable = (table: string): boolean => (historicalTables as readonly string[]).includes(table);

/** A relationship graph cannot need more rounds than it has tasks; this is the circuit breaker, not the expected path. */
export const MAX_CLOSURE_ITERATIONS = 100;

export type JsonReferenceClass = 'EXACT_SCALAR' | 'MENTION_ONLY' | 'NONE';

/**
 * How a JSON document refers to an excluded id, if at all.
 *
 * `EXACT_SCALAR` means some leaf value *is* the id -- `{"taskId":"<uuid>"}`, an element of an id
 * array, a nested `operationId`. That is a reference, and for a historical row it is proof enough.
 *
 * `MENTION_ONLY` means the id appears inside a longer string -- a log line, a diff, a commit
 * message, a reason. That is text about the id, not a reference to it, and it is never grounds to
 * drop a row. It stays ambiguous so the copy stops and a human decides.
 */
export function classifyJsonReference(value: unknown, needles: ReadonlySet<string>): JsonReferenceClass {
  if (needles.size === 0) return 'NONE';
  let mention = false;
  const visit = (node: unknown): boolean => {
    if (typeof node === 'string') {
      if (needles.has(node)) return true;
      if (!mention) for (const needle of needles) if (node.includes(needle)) { mention = true; break; }
      return false;
    }
    if (Array.isArray(node)) {
      for (const item of node) if (visit(item)) return true;
      return false;
    }
    if (node !== null && typeof node === 'object') {
      for (const item of Object.values(node as Record<string, unknown>)) if (visit(item)) return true;
      return false;
    }
    return false;
  };
  if (visit(value)) return 'EXACT_SCALAR';
  return mention ? 'MENTION_ONLY' : 'NONE';
}

const CLOSURE_KEY_BY_TABLE: Readonly<Record<string, keyof ExclusionClosure>> = {
  tasks: 'tasks',
  runs: 'runs',
  execution_jobs: 'executionJobs',
  artifacts: 'artifacts',
  task_transitions: 'taskTransitions',
  audit_events: 'auditEvents',
  admin_operations: 'adminOperations',
};

/** Which primary keys of `table` the closure excludes. A table with no mapping is copied whole. */
export function excludedIdsForTable(closure: ExclusionClosure, table: string): readonly string[] {
  const key = CLOSURE_KEY_BY_TABLE[table];
  return key ? closure[key] : [];
}

export const closureCounts = (closure: ExclusionClosure): Record<string, number> => ({
  tasks: closure.tasks.length,
  runs: closure.runs.length,
  artifacts: closure.artifacts.length,
  executionJobs: closure.executionJobs.length,
  taskTransitions: closure.taskTransitions.length,
  auditEvents: closure.auditEvents.length,
  adminOperations: closure.adminOperations.length,
});

/** Every id an excluded row can be referred to by: the needles the historical scan matches against. */
export const closureNeedles = (closure: ExclusionClosure): Set<string> => new Set([...closure.tasks, ...closure.runs, ...closure.operationIds]);

export const closureTotal = (closure: ExclusionClosure): number => Object.values(closureCounts(closure)).reduce((total, value) => total + value, 0);

/**
 * The same paged read as `selectPageSql`, with the excluded primary keys bound as `$3`. The key is
 * compared as text so one predicate shape serves both the uuid-keyed tables and text-keyed
 * `admin_operations`; the ids are a bound parameter, never interpolated.
 */
export function selectPageSqlExcluding(entry: TablePlan): string {
  const quoted = (value: string): string => `"${assertSafeIdentifier(value)}"`;
  const key = entry.primaryKey.map(quoted).join(',');
  return `SELECT ${entry.columns.map(quoted).join(',')} FROM ${quoted(entry.table)} WHERE ${quoted(entry.primaryKey[0] as string)}::text <> ALL($3::text[]) ORDER BY ${key} LIMIT $1 OFFSET $2`;
}

export interface TransientTask { readonly taskId: string; readonly state: string }
export interface TransientTaskGate {
  readonly blocked: boolean;
  /** Transient tasks that are NOT on the denylist: unknown work in flight, which always stops a copy. */
  readonly blocking: readonly TransientTask[];
  /** Transient tasks that are on the denylist: known stale remnants, not copied and not blocking. */
  readonly excluded: readonly TransientTask[];
}

/**
 * A transient task normally blocks a copy, because the row is mid-write. A task on the exclusion
 * denylist is different: it is not being copied at all, so its state cannot reach the target and
 * cannot be half-written there. Anything else transient -- a seventh task, a new one, one whose id
 * was not named -- still stops the copy.
 */
export function evaluateTransientTaskGate(input: { transient: readonly TransientTask[]; excludedTaskIds: readonly string[] }): TransientTaskGate {
  const denylist = new Set(input.excludedTaskIds.map(id => id.toLowerCase()));
  const excluded = input.transient.filter(task => denylist.has(task.taskId.toLowerCase()));
  const blocking = input.transient.filter(task => !denylist.has(task.taskId.toLowerCase()));
  return { blocked: blocking.length > 0, blocking, excluded };
}

/** Report at most this many ids per category, so a report stays a report. */
export const SAMPLE_LIMIT = 20;
export const sample = (ids: readonly string[]): readonly string[] => ids.slice(0, SAMPLE_LIMIT);
