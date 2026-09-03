import 'dotenv/config';
import { Client } from 'pg';
import {
  activeExecutionJobStatuses,
  assertSafeIdentifier,
  authBoundStatus,
  authBoundTables,
  closureCounts,
  compareKeyedData,
  compareMarkers,
  conflictBehaviorFor,
  controlPlaneMigrationPlan,
  countSql,
  emptyClosure,
  evaluateTargetReadiness,
  evaluateTransientTaskGate,
  excludedIdsForTable,
  insertRowsSql,
  markerConflictResolution,
  parseExcludedTaskIds,
  readOnlySnapshotStatement,
  RowHasher,
  sameDatabaseEndpoint,
  sample,
  selectPageSql,
  selectPageSqlExcluding,
  structuredTaskReferences,
  tablesRequiringEmptyTarget,
  targetAdvisoryLockKey,
  transientTaskStates,
  type ExclusionClosure,
  type TablePlan,
  type Tally,
  type TransientTask,
} from '../packages/control-plane-migration/src/index.js';

// Moves the durable control-plane state from the current PostgreSQL to the next one.
//
//   --mode inventory  reads both databases and reports what a copy would move. Changes nothing.
//   --mode copy       one-shot transfer into an empty target, refused while the source is busy.
//   --mode verify     re-reads both databases and compares counts, row hashes and seeded keys.
//
// SOURCE_DATABASE_URL is the existing AUTOPILOT_CONTROL_DATABASE_URL; TARGET_DATABASE_URL is
// AUTOPILOT_NEXT_DATABASE_URL. Neither value -- nor any row payload -- is ever printed: the report
// carries table names, counts, ids, hashes and statuses only.
//
// This script touches PostgreSQL and nothing else. It never calls the Supabase Management API, an
// Edge Function, R2, or object storage of either project, and it never moves a blob: artifacts keep
// their persisted `storage.provider`, so pre-cutover "supabase" references stay readable through the
// next runtime's legacy reader in RoutingArtifactBlobStore.
//
// `--exclude-task-id <uuid>` (repeatable, or AUTOPILOT_MIGRATION_EXCLUDE_TASK_IDS as a comma list)
// keeps a task and everything that exists only as its history out of the target. It is a filter on
// what is written, never a deletion: the source is opened READ ONLY and is not modified in any way.
// inventory reports the closure without touching the target, which is the dry run for a copy.

const modes = ['inventory', 'copy', 'verify'] as const;
type Mode = (typeof modes)[number];
const PAGE = 500;
/** How many blocking rows inventory names before it stops. Enforced in SQL and again on the result. */
const IDENTITY_LIMIT = 20;
/** A task title is a short human label, but it still originates outside this control plane, so it is capped rather than trusted to be short. */
const TITLE_LIMIT = 120;

/** Rows are returned directly, so a caller never holds a client and cannot bypass the read guard below. */
type Query = <Row>(text: string, values?: unknown[], rowMode?: 'array') => Promise<Row[]>;

class MigrationBlocked extends Error {
  constructor(message: string, readonly details: Record<string, unknown> = {}) { super(message); this.name = 'MigrationBlocked'; }
}

const mode = argument('--mode') as Mode | undefined;
if (!mode || !modes.includes(mode)) throw new Error(`--mode is required and must be one of: ${modes.join(', ')}`);
// The ids live here, in the migration entrypoint, not in the reusable library: this is one
// migration's decision, not a general rule. Every value is validated as a UUID before use.
const excludedTaskIds = parseExcludedTaskIds([...argumentAll('--exclude-task-id'), process.env['AUTOPILOT_MIGRATION_EXCLUDE_TASK_IDS'] ?? '']);
const sourceUrl = required('SOURCE_DATABASE_URL');
const targetUrl = required('TARGET_DATABASE_URL');
// The one check that must precede every connection: a "copy" whose target is its own source would
// insert a table into itself rather than migrate anything.
if (sameDatabaseEndpoint(sourceUrl, targetUrl)) throw new Error('SOURCE_DATABASE_URL and TARGET_DATABASE_URL address the same database; refusing to run');

const source = new Client({ connectionString: sourceUrl });
const target = new Client({ connectionString: targetUrl });
await source.connect();
await target.connect();
try {
  if (mode === 'inventory') emit('control_plane_state.inventory', await inventory());
  else if (mode === 'copy') emit('control_plane_state.copy', await copy());
  else emit('control_plane_state.verify', await verify());
} catch (error) {
  if (!(error instanceof MigrationBlocked)) throw error;
  console.error(JSON.stringify({ level: 'error', event: 'control_plane_state.blocked', mode, reason: error.message, ...error.details }));
  process.exitCode = 1;
} finally {
  await source.end().catch(() => undefined);
  await target.end().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function inventory() {
  await sourceQuery(readOnlySnapshotStatement);
  await targetQuery(readOnlySnapshotStatement);
  try {
    // Resolving the closure here makes inventory the dry run for a copy: it reads the source only,
    // writes nothing anywhere, and prints exactly what a copy would leave behind.
    const resolved = await resolveExclusion(sourceQuery, excludedTaskIds);
    return {
      mode,
      source: await describe(sourceQuery, 'SOURCE'),
      target: await describe(targetQuery, 'TARGET'),
      ...(excludedTaskIds.length ? { exclusionPlan: exclusionReport(resolved) } : {}),
      authBoundNote: `${authBoundTables.join(', ')} are ${authBoundStatus}: their user ids belong to the current project's Supabase Auth namespace`,
    };
  } finally {
    await sourceQuery('ROLLBACK');
    await targetQuery('ROLLBACK');
  }
}

async function copy() {
  // Read the source only inside the read-only repeatable-read snapshot, and settle every "may this
  // run at all" question before the target transaction is even opened.
  await sourceQuery(readOnlySnapshotStatement);
  const activeExecutionJobs = await activeJobTally(sourceQuery);
  const resolved = await resolveExclusion(sourceQuery, excludedTaskIds);
  // An in-flight job always stops a copy, whatever the denylist says. Transient tasks are judged
  // one by one: a task that is being excluded is not going to the target at all, so its state
  // cannot arrive half-written -- but any transient task NOT on the denylist is unknown work and
  // still stops everything, including a seventh one that appears after the list was fixed.
  const gate = evaluateTransientTaskGate({ transient: await transientTasks(sourceQuery), excludedTaskIds });
  const ambiguous = resolved.ambiguous.filter(entry => entry.count > 0);
  if (activeExecutionJobs.length || gate.blocked || resolved.dependentTasks.length || ambiguous.length) {
    // Collect the diagnostic ids inside the SAME snapshot that decided to block, before the
    // rollback: read afterwards they could describe a different moment than the gate reacted to.
    const activeExecutionJobIds = activeExecutionJobs.length ? await blockingJobIds() : [];
    await sourceQuery('ROLLBACK');
    throw new MigrationBlocked('Copy is refused: the source is not in a state this migration can reproduce exactly', {
      activeExecutionJobs,
      activeExecutionJobIds,
      blockingTransientTasks: gate.blocking,
      excludedTransientTasks: gate.excluded,
      // Copying these would leave a relationship pointing at a task the target never receives, and
      // rewriting their data would change persisted content. A human decides which it is.
      tasksDependingOnExcludedTasks: sample(resolved.dependentTasks),
      ambiguousReferences: ambiguous,
      ...(excludedTaskIds.length ? { exclusionPlan: exclusionReport(resolved) } : {}),
    });
  }

  // The dry-run report is emitted before the first write, so the run's own log always records what
  // it was about to leave out.
  if (excludedTaskIds.length) emit('control_plane_state.exclusion_plan', { mode, ...exclusionReport(resolved) });

  await target.query('BEGIN');
  try {
    const locked = await targetQuery<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock($1::bigint) AS locked', [targetAdvisoryLockKey]);
    if (!locked[0]?.locked) throw new MigrationBlocked('Another control-plane state migration holds the target advisory lock');
    const readiness = evaluateTargetReadiness(await tallies(targetQuery, tablesRequiringEmptyTarget()));
    if (!readiness.ready) throw new MigrationBlocked('Target already holds operational state; refusing to overwrite it', { occupied: readiness.occupied });

    const copied: Array<{ table: string; strategy: string; rows: number; excluded: number }> = [];
    for (const entry of controlPlaneMigrationPlan) {
      const excluded = excludedIdsForTable(resolved.closure, entry.table);
      copied.push({ table: entry.table, strategy: entry.strategy, rows: await copyTable(entry, excluded), excluded: excluded.length });
    }
    await target.query('COMMIT');
    return { mode, copied, excluded: closureCounts(resolved.closure), skipped: authBoundTables.map(table => ({ table, status: authBoundStatus })), blobsMoved: 0 };
  } catch (error) {
    // Any failure at all -- a constraint, a lost lock, a blocked precondition -- leaves the target
    // exactly as it was. There is no partially migrated state to clean up by hand.
    await target.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await sourceQuery('ROLLBACK').catch(() => undefined);
  }
}

async function verify() {
  await sourceQuery(readOnlySnapshotStatement);
  await targetQuery(readOnlySnapshotStatement);
  try {
    // The target is never expected to equal the source: it is expected to equal the source MINUS
    // the exclusion closure. The same closure the copy used is re-derived from the same structured
    // references, and the source side of every comparison is filtered by it.
    const resolved = await resolveExclusion(sourceQuery, excludedTaskIds);
    const tables: Array<Record<string, unknown>> = [];
    let mismatched = 0;
    for (const entry of controlPlaneMigrationPlan) {
      const excluded = excludedIdsForTable(resolved.closure, entry.table);
      if (entry.strategy === 'INSERT') {
        // Row counts and hashes together answer both directions at once: a missing row and an extra
        // target-only row both change them.
        const left = await hashTable(sourceQuery, entry, excluded);
        const right = await hashTable(targetQuery, entry);
        const absent = excluded.length ? await presentIds(targetQuery, entry, excluded) : [];
        const match = left.rows === right.rows && left.hash === right.hash && absent.length === 0;
        if (!match) mismatched += 1;
        tables.push({
          table: entry.table, strategy: entry.strategy, excludedFromSource: excluded.length,
          sourceRows: left.rows, targetRows: right.rows, sourceHash: left.hash, targetHash: right.hash,
          ...(absent.length ? { excludedRowsFoundInTarget: sample(absent) } : {}),
          status: match ? 'MATCH' : 'MISMATCH',
        });
        continue;
      }
      const left = await keyedData(sourceQuery, entry);
      const right = await keyedData(targetQuery, entry);
      const comparison = entry.strategy === 'MARKER_MERGE' ? compareMarkers(left, right) : compareKeyedData(left, right);
      const match = comparison.missing.length === 0 && comparison.different.length === 0;
      if (!match) mismatched += 1;
      tables.push({
        table: entry.table, strategy: entry.strategy, sourceKeys: left.size, targetKeys: right.size, matchedKeys: comparison.matched,
        missingKeys: comparison.missing, differingKeys: comparison.different,
        ...('schemaKeptByTarget' in comparison ? { schemaMarkersKeptByTarget: comparison.schemaKeptByTarget } : {}),
        status: match ? 'MATCH' : 'MISMATCH',
      });
    }
    // Reported for completeness, never counted as a discrepancy: these rows are bound to the
    // current project's Auth user ids and are re-created by createEdgeRuntime from the operator
    // allowlists against the next project's own Auth.
    const authBound = [];
    for (const table of authBoundTables) authBound.push({ table, status: authBoundStatus, sourceRows: await count(sourceQuery, table), targetRows: await count(targetQuery, table) });
    // Excluding a task removes its runs and artifacts too, so nothing in the target may point at a
    // parent that never arrived. The declared foreign keys already make that impossible at insert
    // time; this re-reads it as evidence rather than trusting the constraint silently.
    const dangling = await danglingReferences(targetQuery);
    if (dangling.length) mismatched += 1;
    if (mismatched > 0) process.exitCode = 1;
    return {
      mode, tables, authBound, dangling,
      ...(excludedTaskIds.length ? { exclusionPlan: exclusionReport(resolved) } : {}),
      result: mismatched === 0 ? 'MATCH' : 'MISMATCH',
    };
  } finally {
    await sourceQuery('ROLLBACK').catch(() => undefined);
    await targetQuery('ROLLBACK').catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Reads -- every one of them takes a Query, so the source can only ever be read through sourceQuery
// ---------------------------------------------------------------------------

async function describe(query: Query, role: 'SOURCE' | 'TARGET') {
  const planned = controlPlaneMigrationPlan.map(entry => entry.table);
  const present = await presentTables(query, [...planned, ...authBoundTables]);
  const tables = planned.map(table => ({ table, present: present.has(table), rows: null as number | null }));
  for (const entry of tables) if (entry.present) entry.rows = await count(query, entry.table);
  const activeExecutionJobs = present.has('execution_jobs') ? await activeJobTally(query) : [];
  const transientTasks = present.has('tasks') ? await transientTaskTally(query) : [];
  return {
    role,
    tables,
    activeExecutionJobs,
    // Identities are read only when the tally already found something, so a quiet control plane
    // costs no extra query. They name what is blocking a copy; they never describe its work.
    activeExecutionJobIdentities: activeExecutionJobs.length ? await activeJobIdentities(query) : [],
    transientTasks,
    transientTaskIdentities: transientTasks.length ? await transientTaskIdentities(query) : [],
    artifactsByStorageProvider: present.has('artifacts') ? await providerTally(query) : [],
    authBound: authBoundTables.map(table => ({ table, present: present.has(table), status: 'AUTH_BOUND_NOT_PORTABLE' })),
  };
}

// ---------------------------------------------------------------------------
// Exclusion closure -- derived from structured references only, never from text
// ---------------------------------------------------------------------------

interface ResolvedExclusion {
  readonly requested: readonly string[];
  readonly found: readonly string[];
  /** Requested ids that do not exist in the source. Reported, not an error: the denylist stays exact. */
  readonly notFound: readonly string[];
  readonly closure: ExclusionClosure;
  /** Surviving tasks whose `relationships[].targetTaskId` names an excluded task -- copying them would leave a reference to a task the target never receives. */
  readonly dependentTasks: readonly string[];
  /** Rows that are NOT provably part of the closure but whose JSON mentions an excluded id. Never deleted on that basis; they stop the copy so a human decides. */
  readonly ambiguous: ReadonlyArray<{ table: string; count: number; sample: readonly string[] }>;
}

async function resolveExclusion(query: Query, taskIds: readonly string[]): Promise<ResolvedExclusion> {
  if (!taskIds.length) return { requested: [], found: [], notFound: [], closure: emptyClosure(), dependentTasks: [], ambiguous: [] };
  const ids = [...taskIds];
  const idColumn = async (text: string, values: unknown[]): Promise<string[]> => (await query<{ id: string }>(text, values)).map(row => row.id);

  const found = await idColumn('SELECT id FROM tasks WHERE id = ANY($1::uuid[]) ORDER BY id', [ids]);
  const runs = await idColumn('SELECT id FROM runs WHERE task_id = ANY($1::uuid[]) ORDER BY id', [ids]);
  const executionJobs = await idColumn('SELECT id FROM execution_jobs WHERE task_id = ANY($1::uuid[]) OR run_id = ANY($2::uuid[]) ORDER BY id', [ids, runs]);
  const artifacts = await idColumn('SELECT id FROM artifacts WHERE task_id = ANY($1::uuid[]) OR run_id = ANY($2::uuid[]) ORDER BY id', [ids, runs]);
  const taskTransitions = await idColumn('SELECT id FROM task_transitions WHERE task_id = ANY($1::uuid[]) ORDER BY id', [ids]);
  // auditEventSchema.taskId is the one canonical task reference an audit row carries.
  const auditEvents = await idColumn("SELECT id FROM audit_events WHERE data->>'taskId' = ANY($1::text[]) ORDER BY id", [ids]);
  // adminOperationSchema defines no task reference at all, so no admin row can be proved to belong
  // to an excluded task; they are all copied, and the ambiguity scan below still watches them.
  const closure: ExclusionClosure = { tasks: found, runs, executionJobs, artifacts, taskTransitions, auditEvents, adminOperations: [] };

  const dependentTasks = await idColumn(
    `SELECT id FROM tasks WHERE id <> ALL($1::uuid[])
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(data->'relationships','[]'::jsonb)) AS relationship
                   WHERE relationship->>'targetTaskId' = ANY($2::text[]))
     ORDER BY id LIMIT $3`,
    [ids, ids, IDENTITY_LIMIT],
  );

  const excludedEverything = [...found, ...runs, ...executionJobs, ...artifacts, ...taskTransitions, ...auditEvents];
  const ambiguous: Array<{ table: string; count: number; sample: readonly string[] }> = [];
  for (const entry of controlPlaneMigrationPlan) {
    if (!entry.columns.includes('data')) continue;
    const key = assertSafeIdentifier(entry.primaryKey[0] as string);
    const table = assertSafeIdentifier(entry.table);
    // A surviving row that merely *mentions* an excluded id proves nothing on its own -- that is
    // free text, not a reference -- so it is never dropped for it. It is surfaced instead, because
    // silently copying a row we cannot classify is the other way to get this wrong.
    const rows = await query<{ id: string }>(
      `SELECT "${key}" AS id FROM "${table}"
        WHERE "${key}"::text <> ALL($1::text[])
          AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS needle WHERE data::text LIKE '%' || needle || '%')
        ORDER BY "${key}" LIMIT $3`,
      [excludedIdsForTable(closure, entry.table), excludedEverything, IDENTITY_LIMIT],
    );
    if (rows.length) ambiguous.push({ table: entry.table, count: rows.length, sample: sample(rows.map(row => row.id)) });
  }

  return { requested: taskIds, found, notFound: taskIds.filter(id => !found.includes(id)), closure, dependentTasks, ambiguous };
}

/** The dry-run view: what a copy would leave behind, in counts and bounded id samples only. */
function exclusionReport(resolved: ResolvedExclusion) {
  return {
    requestedTaskIds: resolved.requested,
    foundTaskIds: resolved.found,
    notFoundTaskIds: resolved.notFound,
    excluded: closureCounts(resolved.closure),
    excludedIds: {
      tasks: sample(resolved.closure.tasks),
      runs: sample(resolved.closure.runs),
      artifacts: sample(resolved.closure.artifacts),
      executionJobs: sample(resolved.closure.executionJobs),
      taskTransitions: sample(resolved.closure.taskTransitions),
      auditEvents: sample(resolved.closure.auditEvents),
      adminOperations: sample(resolved.closure.adminOperations),
    },
    dependentTaskIds: sample(resolved.dependentTasks),
    ambiguousReferences: resolved.ambiguous,
    structuredReferencesFollowed: structuredTaskReferences,
  };
}

async function presentTables(query: Query, tables: readonly string[]) {
  const rows = await query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname = ANY($1::text[])`,
    [[...tables]],
  );
  return new Set(rows.map(row => row.relname));
}

async function count(query: Query, table: string): Promise<number> {
  return Number((await query<{ count: string }>(countSql(table)))[0]?.count ?? 0);
}

async function tallies(query: Query, tables: readonly string[]): Promise<Tally[]> {
  const result: Tally[] = [];
  for (const table of tables) result.push({ key: table, count: await count(query, table) });
  return result;
}

async function activeJobTally(query: Query): Promise<Tally[]> {
  const rows = await query<{ status: string; count: string }>('SELECT status, count(*)::bigint AS count FROM execution_jobs WHERE status = ANY($1::text[]) GROUP BY status ORDER BY status', [[...activeExecutionJobStatuses]]);
  return rows.map(row => ({ key: row.status, count: Number(row.count) }));
}

async function transientTaskTally(query: Query): Promise<Tally[]> {
  const rows = await query<{ state: string; count: string }>("SELECT data->>'state' AS state, count(*)::bigint AS count FROM tasks WHERE data->>'state' = ANY($1::text[]) GROUP BY 1 ORDER BY 1", [[...transientTaskStates]]);
  return rows.map(row => ({ key: row.state, count: Number(row.count) }));
}

/**
 * Names the tasks that are blocking a copy, and nothing more.
 *
 * The projection is an explicit allowlist of identifying scalars: three real columns plus three
 * named scalar paths out of the task envelope. `data` is never selected whole, and `description`,
 * `requirements` and `relationships` -- the fields that actually carry task content -- are not
 * selected at all, so no payload, prompt or context can reach the log through here. The title is
 * a short human label, and it is truncated because it comes from outside this control plane.
 */
async function transientTaskIdentities(query: Query): Promise<Array<Record<string, unknown>>> {
  const rows = await query<{ id: string; project_id: string; external_key: string | null; state: string | null; title: string | null; created_at: Date | string | null; updated_at: string | null }>(
    `SELECT id, project_id, external_key, data->>'state' AS state, data->>'title' AS title, created_at, data->>'updatedAt' AS updated_at
     FROM tasks WHERE data->>'state' = ANY($1::text[]) ORDER BY created_at, id LIMIT $2`,
    [[...transientTaskStates], IDENTITY_LIMIT],
  );
  return rows.slice(0, IDENTITY_LIMIT).map(row => ({
    taskId: row.id,
    projectId: row.project_id,
    externalKey: row.external_key,
    state: row.state,
    title: truncate(row.title),
    createdAt: timestamp(row.created_at),
    updatedAt: row.updated_at,
  }));
}

/** The same shape for in-flight jobs. Every field here is a real column; the job's `data` envelope is never read. */
async function activeJobIdentities(query: Query): Promise<Array<Record<string, unknown>>> {
  const rows = await query<{ id: string; project_id: string; task_id: string; status: string; created_at: Date | string | null; updated_at: Date | string | null }>(
    `SELECT id, project_id, task_id, status, created_at, updated_at
     FROM execution_jobs WHERE status = ANY($1::text[]) ORDER BY created_at, id LIMIT $2`,
    [[...activeExecutionJobStatuses], IDENTITY_LIMIT],
  );
  return rows.slice(0, IDENTITY_LIMIT).map(row => ({
    executionJobId: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    status: row.status,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  }));
}

// Function declarations, not const arrows: everything below the module's top-level await runs
// during it, so a const here would be in the temporal dead zone when inventory calls it.
function truncate(value: string | null): string | null {
  if (value === null || value === undefined) return null;
  return value.length > TITLE_LIMIT ? `${value.slice(0, TITLE_LIMIT)}...` : value;
}
function timestamp(value: Date | string | null): string | null {
  return value instanceof Date ? value.toISOString() : value ?? null;
}

async function providerTally(query: Query): Promise<Tally[]> {
  const rows = await query<{ provider: string; count: string }>("SELECT data->'storage'->>'provider' AS provider, count(*)::bigint AS count FROM artifacts WHERE data->'storage'->>'provider' IS NOT NULL GROUP BY 1 ORDER BY 1");
  return rows.map(row => ({ key: row.provider, count: Number(row.count) }));
}

/** Every transient task with its id and state -- the gate needs the whole set, not a capped sample, to decide. */
async function transientTasks(query: Query): Promise<TransientTask[]> {
  const rows = await query<{ id: string; state: string }>("SELECT id, data->>'state' AS state FROM tasks WHERE data->>'state' = ANY($1::text[]) ORDER BY id", [[...transientTaskStates]]);
  return rows.map(row => ({ taskId: row.id, state: row.state }));
}

/** Identifiers only -- enough for an operator to go and settle the work that is blocking the copy. */
async function blockingJobIds(): Promise<string[]> {
  const rows = await sourceQuery<{ id: string }>('SELECT id FROM execution_jobs WHERE status = ANY($1::text[]) ORDER BY id LIMIT 20', [[...activeExecutionJobStatuses]]);
  return rows.map(row => row.id);
}

async function hashTable(query: Query, entry: TablePlan, excluded: readonly string[] = []) {
  const hasher = new RowHasher();
  for (let offset = 0; ; offset += PAGE) {
    const page = excluded.length
      ? await query<unknown[]>(selectPageSqlExcluding(entry), [PAGE, offset, [...excluded]], 'array')
      : await query<unknown[]>(selectPageSql(entry), [PAGE, offset], 'array');
    for (const row of page) hasher.add(row);
    if (page.length < PAGE) break;
  }
  return { rows: hasher.count, hash: hasher.digest() };
}

/** Which of these ids actually exist in a database -- used to prove the excluded rows never reached the target. */
async function presentIds(query: Query, entry: TablePlan, ids: readonly string[]): Promise<string[]> {
  const key = assertSafeIdentifier(entry.primaryKey[0] as string);
  const table = assertSafeIdentifier(entry.table);
  const rows = await query<{ id: string }>(`SELECT "${key}" AS id FROM "${table}" WHERE "${key}"::text = ANY($1::text[]) ORDER BY "${key}"`, [[...ids]]);
  return rows.map(row => row.id);
}

/** Every declared child -> parent edge among the copied operational tables, checked for orphans. */
const referenceEdges = [
  { child: 'runs', column: 'task_id', parent: 'tasks' },
  { child: 'artifacts', column: 'task_id', parent: 'tasks' },
  { child: 'artifacts', column: 'run_id', parent: 'runs' },
  { child: 'execution_jobs', column: 'task_id', parent: 'tasks' },
  { child: 'execution_jobs', column: 'run_id', parent: 'runs' },
  { child: 'task_transitions', column: 'task_id', parent: 'tasks' },
] as const;

async function danglingReferences(query: Query): Promise<Array<{ reference: string; orphans: number }>> {
  const found: Array<{ reference: string; orphans: number }> = [];
  for (const edge of referenceEdges) {
    const child = assertSafeIdentifier(edge.child), column = assertSafeIdentifier(edge.column), parent = assertSafeIdentifier(edge.parent);
    const rows = await query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM "${child}" c LEFT JOIN "${parent}" p ON p.id = c."${column}" WHERE c."${column}" IS NOT NULL AND p.id IS NULL`,
    );
    const orphans = Number(rows[0]?.count ?? 0);
    if (orphans > 0) found.push({ reference: `${edge.child}.${edge.column} -> ${edge.parent}.id`, orphans });
  }
  return found;
}

/** Seed-merged and marker tables are small and compared key-by-key, so they are read whole. */
async function keyedData(query: Query, entry: TablePlan) {
  const keyIndex = entry.columns.indexOf(entry.primaryKey[0] as string);
  const dataIndex = entry.columns.indexOf('data');
  const values = new Map<string, unknown>();
  for (let offset = 0; ; offset += PAGE) {
    const page = await query<unknown[]>(selectPageSql(entry), [PAGE, offset], 'array');
    for (const row of page) values.set(String(row[keyIndex]), row[dataIndex]);
    if (page.length < PAGE) break;
  }
  return values;
}

// ---------------------------------------------------------------------------
// Writes (target only)
// ---------------------------------------------------------------------------

async function copyTable(entry: TablePlan, excluded: readonly string[] = []): Promise<number> {
  const keyIndex = entry.columns.indexOf(entry.primaryKey[0] as string);
  let copied = 0;
  for (let offset = 0; ; offset += PAGE) {
    // The excluded rows are filtered out of the READ, so they are never even fetched, let alone
    // written. Every other row crosses byte for byte, untransformed.
    const rows = excluded.length
      ? await sourceQuery<unknown[]>(selectPageSqlExcluding(entry), [PAGE, offset, [...excluded]], 'array')
      : await sourceQuery<unknown[]>(selectPageSql(entry), [PAGE, offset], 'array');
    if (entry.strategy === 'MARKER_MERGE') {
      // Split by key: the target's own schema:* provenance is kept, everything else is refreshed
      // from source. Two statements rather than one clever clause, so each behaviour is explicit.
      const keep = rows.filter(row => markerConflictResolution(String(row[keyIndex])) === 'KEEP_TARGET');
      const prefer = rows.filter(row => markerConflictResolution(String(row[keyIndex])) === 'PREFER_SOURCE');
      if (keep.length) await insertPage(entry, keep, 'DO_NOTHING');
      if (prefer.length) await insertPage(entry, prefer, 'DO_UPDATE');
    } else if (rows.length) {
      await insertPage(entry, rows, conflictBehaviorFor(entry));
    }
    copied += rows.length;
    if (rows.length < PAGE) break;
  }
  return copied;
}

/** Every value crosses as a bound parameter; the statement text comes only from the allowlisted plan. */
async function insertPage(entry: TablePlan, rows: unknown[][], conflict: ReturnType<typeof conflictBehaviorFor>): Promise<void> {
  await target.query(insertRowsSql(entry, rows.length, conflict), rows.flat());
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/**
 * The only door to the source connection, and it opens for reads alone -- every source read in this
 * script, paged copy reads included, goes through here. The READ ONLY transaction already makes a
 * write impossible server-side; this is the second, independent lock on the same door, so a future
 * edit cannot quietly introduce one either.
 */
async function sourceQuery<Row>(text: string, values: unknown[] = [], rowMode?: 'array'): Promise<Row[]> {
  if (text !== readOnlySnapshotStatement && text !== 'ROLLBACK' && !/^SELECT\s/i.test(text)) throw new Error('Refusing to run a non-read statement against the migration source');
  const result = await source.query({ text, values, ...(rowMode ? { rowMode } : {}) });
  return result.rows as Row[];
}

/** The target is the only connection this script may write to; reads go through the same shape as the source's. */
async function targetQuery<Row>(text: string, values: unknown[] = [], rowMode?: 'array'): Promise<Row[]> {
  const result = await target.query({ text, values, ...(rowMode ? { rowMode } : {}) });
  return result.rows as Row[];
}

function emit(event: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', event, ...payload }));
}
function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
/** Every occurrence of a repeatable flag, so `--exclude-task-id a --exclude-task-id b` collects both. */
function argumentAll(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (value !== undefined && !value.startsWith('--')) values.push(value);
  }
  return values;
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
