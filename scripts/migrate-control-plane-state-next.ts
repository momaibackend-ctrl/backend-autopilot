import 'dotenv/config';
import { Client } from 'pg';
import {
  activeExecutionJobStatuses,
  authBoundStatus,
  authBoundTables,
  compareKeyedData,
  compareMarkers,
  conflictBehaviorFor,
  controlPlaneMigrationPlan,
  countSql,
  evaluateSourceActivity,
  evaluateTargetReadiness,
  insertRowsSql,
  markerConflictResolution,
  readOnlySnapshotStatement,
  RowHasher,
  sameDatabaseEndpoint,
  selectPageSql,
  tablesRequiringEmptyTarget,
  targetAdvisoryLockKey,
  transientTaskStates,
  type TablePlan,
  type Tally,
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

const modes = ['inventory', 'copy', 'verify'] as const;
type Mode = (typeof modes)[number];
const PAGE = 500;

/** Rows are returned directly, so a caller never holds a client and cannot bypass the read guard below. */
type Query = <Row>(text: string, values?: unknown[], rowMode?: 'array') => Promise<Row[]>;

class MigrationBlocked extends Error {
  constructor(message: string, readonly details: Record<string, unknown> = {}) { super(message); this.name = 'MigrationBlocked'; }
}

const mode = argument('--mode') as Mode | undefined;
if (!mode || !modes.includes(mode)) throw new Error(`--mode is required and must be one of: ${modes.join(', ')}`);
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
    return { mode, source: await describe(sourceQuery, 'SOURCE'), target: await describe(targetQuery, 'TARGET'), authBoundNote: `${authBoundTables.join(', ')} are ${authBoundStatus}: their user ids belong to the current project's Supabase Auth namespace` };
  } finally {
    await sourceQuery('ROLLBACK');
    await targetQuery('ROLLBACK');
  }
}

async function copy() {
  // Read the source only inside the read-only repeatable-read snapshot, and settle every "may this
  // run at all" question before the target transaction is even opened.
  await sourceQuery(readOnlySnapshotStatement);
  const activity = evaluateSourceActivity({ activeExecutionJobs: await activeJobTally(sourceQuery), transientTasks: await transientTaskTally(sourceQuery) });
  if (activity.blocked) {
    // Collect the diagnostic ids inside the SAME snapshot that decided to block, before the
    // rollback: read afterwards they could describe a different moment than the gate reacted to.
    const activeExecutionJobIds = await blockingJobIds();
    const transientTaskIds = await blockingTaskIds();
    await sourceQuery('ROLLBACK');
    throw new MigrationBlocked('Source control plane still has work in flight; copy is refused until it is quiet', {
      activeExecutionJobs: activity.activeExecutionJobs,
      activeExecutionJobIds,
      transientTasks: activity.transientTasks,
      transientTaskIds,
    });
  }

  await target.query('BEGIN');
  try {
    const locked = await targetQuery<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock($1::bigint) AS locked', [targetAdvisoryLockKey]);
    if (!locked[0]?.locked) throw new MigrationBlocked('Another control-plane state migration holds the target advisory lock');
    const readiness = evaluateTargetReadiness(await tallies(targetQuery, tablesRequiringEmptyTarget()));
    if (!readiness.ready) throw new MigrationBlocked('Target already holds operational state; refusing to overwrite it', { occupied: readiness.occupied });

    const copied: Array<{ table: string; strategy: string; rows: number }> = [];
    for (const entry of controlPlaneMigrationPlan) copied.push({ table: entry.table, strategy: entry.strategy, rows: await copyTable(entry) });
    await target.query('COMMIT');
    return { mode, copied, skipped: authBoundTables.map(table => ({ table, status: authBoundStatus })), blobsMoved: 0 };
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
    const tables: Array<Record<string, unknown>> = [];
    let mismatched = 0;
    for (const entry of controlPlaneMigrationPlan) {
      if (entry.strategy === 'INSERT') {
        const left = await hashTable(sourceQuery, entry);
        const right = await hashTable(targetQuery, entry);
        const match = left.rows === right.rows && left.hash === right.hash;
        if (!match) mismatched += 1;
        tables.push({ table: entry.table, strategy: entry.strategy, sourceRows: left.rows, targetRows: right.rows, sourceHash: left.hash, targetHash: right.hash, status: match ? 'MATCH' : 'MISMATCH' });
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
    if (mismatched > 0) process.exitCode = 1;
    return { mode, tables, authBound, result: mismatched === 0 ? 'MATCH' : 'MISMATCH' };
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
  return {
    role,
    tables,
    activeExecutionJobs: present.has('execution_jobs') ? await activeJobTally(query) : [],
    transientTasks: present.has('tasks') ? await transientTaskTally(query) : [],
    artifactsByStorageProvider: present.has('artifacts') ? await providerTally(query) : [],
    authBound: authBoundTables.map(table => ({ table, present: present.has(table), status: 'AUTH_BOUND_NOT_PORTABLE' })),
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

async function providerTally(query: Query): Promise<Tally[]> {
  const rows = await query<{ provider: string; count: string }>("SELECT data->'storage'->>'provider' AS provider, count(*)::bigint AS count FROM artifacts WHERE data->'storage'->>'provider' IS NOT NULL GROUP BY 1 ORDER BY 1");
  return rows.map(row => ({ key: row.provider, count: Number(row.count) }));
}

/** Identifiers only -- enough for an operator to go and settle the work that is blocking the copy. */
async function blockingJobIds(): Promise<string[]> {
  const rows = await sourceQuery<{ id: string }>('SELECT id FROM execution_jobs WHERE status = ANY($1::text[]) ORDER BY id LIMIT 20', [[...activeExecutionJobStatuses]]);
  return rows.map(row => row.id);
}
async function blockingTaskIds(): Promise<string[]> {
  const rows = await sourceQuery<{ id: string }>("SELECT id FROM tasks WHERE data->>'state' = ANY($1::text[]) ORDER BY id LIMIT 20", [[...transientTaskStates]]);
  return rows.map(row => row.id);
}

async function hashTable(query: Query, entry: TablePlan) {
  const hasher = new RowHasher();
  for (let offset = 0; ; offset += PAGE) {
    const page = await query<unknown[]>(selectPageSql(entry), [PAGE, offset], 'array');
    for (const row of page) hasher.add(row);
    if (page.length < PAGE) break;
  }
  return { rows: hasher.count, hash: hasher.digest() };
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

async function copyTable(entry: TablePlan): Promise<number> {
  const keyIndex = entry.columns.indexOf(entry.primaryKey[0] as string);
  let copied = 0;
  for (let offset = 0; ; offset += PAGE) {
    const rows = await sourceQuery<unknown[]>(selectPageSql(entry), [PAGE, offset], 'array');
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
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
