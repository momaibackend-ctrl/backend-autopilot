/**
 * The control-plane state migration, described as data rather than as code paths: which durable
 * tables move to the next PostgreSQL, in which order, under which write strategy, and which are
 * deliberately left behind.
 *
 * It lives apart from `scripts/migrate-control-plane-state-next.ts` so every rule is unit-testable
 * without a database, and -- more importantly -- so the SQL that script executes can only ever name
 * identifiers that appear in this allowlist. Nothing here interpolates a caller-supplied value into
 * SQL: table and column names come from these literals, every row value crosses as a bound
 * parameter, and `assertSafeIdentifier` re-checks each identifier at build time anyway.
 */

/**
 * INSERT       -- operational state. The target table must be empty first, so a conflict is a real
 *                 error and the statement carries no ON CONFLICT escape at all.
 * SEED_MERGE   -- `pnpm db:migrate` seeds these on the target with default rows. The source row is
 *                 the live configuration and must win, while target-only seed keys stay.
 * MARKER_MERGE -- per-key: the target's own `schema:*` provenance is authoritative (it records the
 *                 migrations actually applied to THIS database), everything else comes from source.
 */
export type CopyStrategy = 'INSERT' | 'SEED_MERGE' | 'MARKER_MERGE';

export interface TablePlan {
  readonly table: string;
  /** Explicit column allowlist -- the migration never issues `SELECT *`, so a column added by a later schema change is a deliberate edit here instead of a silent copy. */
  readonly columns: readonly string[];
  readonly primaryKey: readonly string[];
  readonly strategy: CopyStrategy;
}

/**
 * Foreign-key-safe copy order. Every table appears after all of the tables it references:
 * resources/contexts/tasks -> projects; runs -> tasks; artifacts -> runs; execution_jobs ->
 * resources and runs; canonical_development_repositories -> resources.
 */
export const controlPlaneMigrationPlan: readonly TablePlan[] = [
  { table: 'projects', columns: ['id', 'slug', 'data', 'created_at'], primaryKey: ['id'], strategy: 'INSERT' },
  { table: 'resources', columns: ['id', 'project_id', 'provider', 'external_reference', 'data', 'created_at'], primaryKey: ['id'], strategy: 'INSERT' },
  { table: 'project_contexts', columns: ['id', 'project_id', 'data', 'created_at'], primaryKey: ['id'], strategy: 'INSERT' },
  { table: 'tasks', columns: ['id', 'project_id', 'external_key', 'data', 'created_at'], primaryKey: ['id'], strategy: 'INSERT' },
  { table: 'runs', columns: ['id', 'project_id', 'task_id', 'operation_id', 'data', 'created_at'], primaryKey: ['id'], strategy: 'INSERT' },
  { table: 'artifacts', columns: ['id', 'project_id', 'task_id', 'run_id', 'kind', 'status', 'content_hash', 'storage_bucket', 'storage_path', 'byte_size', 'data', 'created_at'], primaryKey: ['id'], strategy: 'INSERT' },
  { table: 'execution_jobs', columns: ['id', 'project_id', 'task_id', 'resource_id', 'run_id', 'operation_id', 'kind', 'status', 'attempt', 'workflow_run_id', 'lease_owner', 'lease_expires_at', 'data', 'created_at', 'updated_at'], primaryKey: ['id'], strategy: 'INSERT' },
  { table: 'task_transitions', columns: ['id', 'task_id', 'data', 'created_at'], primaryKey: ['id'], strategy: 'INSERT' },
  { table: 'audit_events', columns: ['id', 'project_id', 'data', 'created_at'], primaryKey: ['id'], strategy: 'INSERT' },
  { table: 'admin_operations', columns: ['operation_id', 'actor', 'tool', 'project_id', 'data', 'created_at'], primaryKey: ['operation_id'], strategy: 'INSERT' },
  { table: 'canonical_development_repositories', columns: ['id', 'project_id', 'resource_id', 'status', 'version', 'operation_id', 'data', 'created_at', 'updated_at'], primaryKey: ['id'], strategy: 'INSERT' },
  { table: 'system_settings', columns: ['key', 'data', 'updated_at'], primaryKey: ['key'], strategy: 'SEED_MERGE' },
  { table: 'console_screens', columns: ['screen_id', 'data', 'updated_at'], primaryKey: ['screen_id'], strategy: 'SEED_MERGE' },
  { table: 'migration_markers', columns: ['key', 'checksum', 'data', 'created_at'], primaryKey: ['key'], strategy: 'MARKER_MERGE' },
];

/**
 * Deliberately NOT copied. In hosted Supabase `autopilot_operators.user_id` carries a foreign key
 * to `auth.users(id)`, and the next project has its own Auth namespace with its own user ids, so
 * these rows are not portable: copying them would either violate that constraint or bind
 * control-plane authority to identities that do not exist in the new project.
 *
 * Nothing is lost. `createEdgeRuntime` re-creates an operator row on first authenticated request
 * from the existing `AUTOPILOT_OPERATOR_EMAILS` / `AUTOPILOT_SUPERADMIN_EMAILS` /
 * `AUTOPILOT_OPERATOR_PROJECT_IDS` allowlists, against the NEW project's Auth user id.
 */
export const authBoundTables = ['autopilot_operators', 'autopilot_project_memberships'] as const;
export const authBoundStatus = 'NOT_MIGRATED_AUTH_BOUND' as const;

/** A source with work in flight cannot be snapshotted coherently: the job would keep mutating rows the copy has already read, and the runner behind it still points at the old database. */
export const activeExecutionJobStatuses = ['QUEUED', 'DISPATCHING', 'DISPATCHED', 'CLAIMED', 'RUNNING'] as const;
/** The same argument at task level: these three states only exist *while* taskTest/taskReview is running and must never be observed at rest. */
export const transientTaskStates = ['IMPLEMENTING', 'TESTING', 'REVIEWING'] as const;

/**
 * The snapshot every read runs inside -- always on the source, and on the target too while
 * verifying. READ ONLY is the enforcement rather than a convention: PostgreSQL itself rejects any
 * INSERT/UPDATE/DELETE/DDL issued inside it, so the source cannot be written even by a bug.
 * REPEATABLE READ makes the whole inventory/copy/verify read one consistent snapshot.
 */
export const readOnlySnapshotStatement = 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY';
/** One fixed key, so two concurrent copies cannot interleave on the same target. */
export const targetAdvisoryLockKey = 731_140_517_294_884;

export const tablesCopiedByInsert = (): string[] => controlPlaneMigrationPlan.filter(entry => entry.strategy === 'INSERT').map(entry => entry.table);
/** Post-`db:migrate`, only the three seeded tables may hold rows; anything in these must mean a target that already carries operational state. */
export const tablesRequiringEmptyTarget = tablesCopiedByInsert;
export const tablePlan = (table: string): TablePlan => {
  const found = controlPlaneMigrationPlan.find(entry => entry.table === table);
  if (!found) throw new Error(`Table is not in the control-plane migration allowlist: ${table}`);
  return found;
};

export function markerConflictResolution(key: string): 'KEEP_TARGET' | 'PREFER_SOURCE' {
  return key.startsWith('schema:') ? 'KEEP_TARGET' : 'PREFER_SOURCE';
}

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
export function assertSafeIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error('Refusing to build SQL from an identifier outside the allowlist shape');
  return value;
}
const quoted = (value: string): string => `"${assertSafeIdentifier(value)}"`;

/** Deterministic, paged read of one table. The ORDER BY is the primary key, which is what makes the verification hash comparable across two databases. */
export function selectPageSql(entry: TablePlan): string {
  return `SELECT ${entry.columns.map(quoted).join(',')} FROM ${quoted(entry.table)} ORDER BY ${entry.primaryKey.map(quoted).join(',')} LIMIT $1 OFFSET $2`;
}

export type ConflictBehavior = 'STRICT' | 'DO_NOTHING' | 'DO_UPDATE';

export function conflictBehaviorFor(entry: TablePlan, markerKey?: string): ConflictBehavior {
  if (entry.strategy === 'INSERT') return 'STRICT';
  if (entry.strategy === 'SEED_MERGE') return 'DO_UPDATE';
  return markerConflictResolution(markerKey ?? '') === 'KEEP_TARGET' ? 'DO_NOTHING' : 'DO_UPDATE';
}

/** Multi-row parameterised INSERT. Values never appear in the statement text -- only `$n` placeholders do. */
export function insertRowsSql(entry: TablePlan, rows: number, conflict: ConflictBehavior): string {
  if (!Number.isInteger(rows) || rows < 1) throw new Error('Refusing to build an INSERT for a non-positive row count');
  const width = entry.columns.length;
  const tuples = Array.from({ length: rows }, (_, row) => `(${Array.from({ length: width }, (__, column) => `$${row * width + column + 1}`).join(',')})`).join(',');
  const statement = `INSERT INTO ${quoted(entry.table)} (${entry.columns.map(quoted).join(',')}) VALUES ${tuples}`;
  if (conflict === 'STRICT') return statement;
  const target = entry.primaryKey.map(quoted).join(',');
  if (conflict === 'DO_NOTHING') return `${statement} ON CONFLICT (${target}) DO NOTHING`;
  const updated = entry.columns.filter(column => !entry.primaryKey.includes(column));
  return `${statement} ON CONFLICT (${target}) DO UPDATE SET ${updated.map(column => `${quoted(column)}=EXCLUDED.${quoted(column)}`).join(',')}`;
}

export const countSql = (table: string): string => `SELECT count(*)::bigint AS count FROM ${quoted(table)}`;
