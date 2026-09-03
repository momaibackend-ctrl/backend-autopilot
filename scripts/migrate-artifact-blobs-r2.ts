import 'dotenv/config';
import { Client } from 'pg';
import { R2ArtifactBlobStore } from '../packages/adapters/r2/src/artifact-storage.js';
import { SupabaseStorageArtifactBlobStore } from '../packages/adapters/supabase/src/artifact-storage.js';
import {
  artifactObjectPath,
  bodyByteLength,
  classifyArtifactStorage,
  compareExistingObject,
  httpStatusOf,
  isObjectMissing,
  isUpstreamBackpressure,
  nextR2Storage,
  parseExcludedTaskIds,
  sample,
  sha256Hex,
  verifyBlobIntegrity,
  verifyR2Reference,
  type StorageReference,
} from '../packages/control-plane-migration/src/index.js';

// Moves the historical artifact bodies out of the legacy Supabase Storage bucket and into R2, and
// repoints the reference in the NEW control-plane database only.
//
//   --mode inventory  reads the new database and reports what would move. Touches nothing else.
//   --mode copy       per artifact: read legacy -> verify -> write R2 -> verify -> update the row.
//   --mode verify     re-reads the new database and R2 and proves every reference resolves.
//
// The old control plane is not part of this migration at all. Its database is never opened -- there
// is no SOURCE_DATABASE_URL here -- and its Storage is only ever read: the legacy adapter this
// script uses exposes `put` and `get`, and only `get` is called. Nothing is deleted anywhere.
//
// Artifacts excluded by the state migration are simply absent from the new database, so they are
// never seen, never fetched and never uploaded.

const modes = ['inventory', 'copy', 'verify'] as const;
type Mode = (typeof modes)[number];
const PAGE = 200;
const IDENTITY_LIMIT = 20;
const LEGACY_PROVIDER = 'supabase';

/** One artifact's row, projected to the scalars this migration needs. Bodies never live in here. */
interface ArtifactRow {
  readonly id: string;
  readonly projectId: string;
  readonly contentHash: string | null;
  readonly storage: StorageReference;
}

class BlobMigrationBlocked extends Error {
  constructor(message: string, readonly details: Record<string, unknown> = {}) { super(message); this.name = 'BlobMigrationBlocked'; }
}

const mode = argument('--mode') as Mode | undefined;
if (!mode || !modes.includes(mode)) throw new Error(`--mode is required and must be one of: ${modes.join(', ')}`);
/** Optional cap so a long migration can be run in reviewable batches; it is restartable either way. */
const limit = Number(argument('--limit') ?? '0');
if (!Number.isInteger(limit) || limit < 0) throw new Error('--limit must be a non-negative integer');
// Only used by verify, and only to assert the excluded work did not reappear.
const excludedTaskIds = parseExcludedTaskIds([process.env['AUTOPILOT_MIGRATION_EXCLUDE_TASK_IDS'] ?? '']);

const targetUrl = required('TARGET_DATABASE_URL');
const legacyUrl = required('AUTOPILOT_LEGACY_SUPABASE_URL');
const legacyKey = required('AUTOPILOT_LEGACY_SUPABASE_SERVICE_ROLE_KEY');
const r2Bucket = required('AUTOPILOT_R2_BUCKET_NAME');
const r2 = new R2ArtifactBlobStore(required('AUTOPILOT_R2_ACCOUNT_ID'), r2Bucket, required('AUTOPILOT_R2_ACCESS_KEY_ID'), required('AUTOPILOT_R2_SECRET_ACCESS_KEY'));
/** One legacy reader per bucket a row actually names, so an unexpected bucket fails loudly instead of being silently read from the default one. */
const legacyStores = new Map<string, SupabaseStorageArtifactBlobStore>();
const legacyStore = (bucket: string): SupabaseStorageArtifactBlobStore => {
  const existing = legacyStores.get(bucket);
  if (existing) return existing;
  const created = new SupabaseStorageArtifactBlobStore(legacyUrl, legacyKey, bucket);
  legacyStores.set(bucket, created);
  return created;
};

const target = new Client({ connectionString: targetUrl });
await target.connect();
try {
  if (mode === 'inventory') emit('artifact_blob_migration.inventory', await inventory());
  else if (mode === 'copy') emit('artifact_blob_migration.copy', await copy());
  else emit('artifact_blob_migration.verify', await verify());
} catch (error) {
  if (!(error instanceof BlobMigrationBlocked)) throw error;
  console.error(JSON.stringify({ level: 'error', event: 'artifact_blob_migration.blocked', mode, reason: error.message, ...error.details }));
  process.exitCode = 1;
} finally {
  await target.end().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function inventory() {
  const tallies = await providerTally();
  const legacy = await legacyArtifacts(IDENTITY_LIMIT);
  const declaredBytes = await legacyDeclaredBytes();
  return {
    mode,
    totalArtifacts: await scalar('SELECT count(*)::bigint AS value FROM artifacts'),
    externalizedByProvider: tallies,
    inlineArtifacts: await scalar("SELECT count(*)::bigint AS value FROM artifacts WHERE data->'storage' IS NULL"),
    blobsToMove: tallies.find(entry => entry.provider === LEGACY_PROVIDER)?.count ?? 0,
    alreadyMigrated: tallies.find(entry => entry.provider === 'r2')?.count ?? 0,
    declaredBytesToMove: declaredBytes,
    // Identities only -- an artifact id, its project, and where its body currently sits.
    sampleToMove: legacy.map(row => ({ artifactId: row.id, projectId: row.projectId, bucket: row.storage.bucket, path: row.storage.path, size: row.storage.size })),
  };
}

/**
 * One artifact at a time, sequentially: the legacy project is quota-restricted, and a migration that
 * is restartable is worth more than one that is fast. Each artifact is independent -- its row is
 * only repointed after its body is proven readable from R2 -- so an interrupted run leaves every
 * unfinished artifact exactly as it was and a re-run continues with what is left.
 */
async function copy() {
  const moved: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  let scanned = 0;
  for (;;) {
    // Rows are re-read from the top rather than paged: every artifact that succeeds leaves the
    // legacy set, so the next read returns only what still has to move. A skipped one stays, which
    // is why a batch that makes no progress ends the run instead of looping on it forever.
    const batch = await legacyArtifacts(PAGE);
    if (!batch.length) break;
    let progressed = false;
    for (const row of batch) {
      if (limit && scanned >= limit) return summary(moved, skipped, scanned, 'LIMIT_REACHED');
      scanned += 1;
      const outcome = await migrateOne(row);
      if (outcome.status === 'MOVED' || outcome.status === 'ADOPTED') { moved.push(outcome.report); progressed = true; }
      else skipped.push(outcome.report);
    }
    if (!progressed) break;
  }
  return summary(moved, skipped, scanned, 'COMPLETE');
}

function summary(moved: Array<Record<string, unknown>>, skipped: Array<Record<string, unknown>>, scanned: number, status: string) {
  return {
    mode, status, scanned,
    movedCount: moved.length, skippedCount: skipped.length,
    moved: sample(moved.map(entry => String(entry['artifactId']))),
    skipped: skipped.slice(0, IDENTITY_LIMIT),
    // Stated rather than implied: this migration copies and repoints, it never removes.
    blobsDeleted: 0, artifactsDeleted: 0, sourceDatabaseTouched: false,
  };
}

async function verify() {
  const tallies = await providerTally();
  const legacyRemaining = tallies.find(entry => entry.provider === LEGACY_PROVIDER)?.count ?? 0;
  const problems: Array<Record<string, unknown>> = [];

  for (let offset = 0; ; offset += PAGE) {
    const rows = await artifactRows('r2', PAGE, offset);
    for (const row of rows) {
      const reference = verifyR2Reference({ reference: row.storage, expectedBucket: r2Bucket, projectId: row.projectId, artifactId: row.id });
      if (!reference.ok) { problems.push({ artifactId: row.id, problems: reference.problems }); continue; }
      let body: string;
      try {
        body = await r2.get(row.storage);
      } catch (error) {
        problems.push({ artifactId: row.id, problems: [isObjectMissing(httpStatusOf(error) ?? 0) ? 'OBJECT_MISSING_IN_R2' : `R2_READ_FAILED (status ${httpStatusOf(error) ?? 'unknown'})`] });
        continue;
      }
      const integrity = verifyBlobIntegrity({ body, expectedSize: row.storage.size, expectedHash: row.contentHash ?? undefined });
      if (!integrity.ok) problems.push({ artifactId: row.id, problems: integrity.problems });
    }
    if (rows.length < PAGE) break;
  }

  // The state migration left the excluded work out of this database; confirm nothing brought it back.
  const excludedArtifacts = excludedTaskIds.length ? await scalar('SELECT count(*)::bigint AS value FROM artifacts WHERE task_id = ANY($1::uuid[])', [[...excludedTaskIds]]) : 0;
  const match = legacyRemaining === 0 && problems.length === 0 && excludedArtifacts === 0;
  if (!match) process.exitCode = 1;
  return {
    mode,
    externalizedByProvider: tallies,
    legacyReferencesRemaining: legacyRemaining,
    excludedArtifactsPresent: excludedArtifacts,
    verifiedProblems: problems.slice(0, IDENTITY_LIMIT),
    problemCount: problems.length,
    result: match ? 'MATCH' : 'MISMATCH',
  };
}

// ---------------------------------------------------------------------------
// One artifact
// ---------------------------------------------------------------------------

async function migrateOne(row: ArtifactRow): Promise<{ status: string; report: Record<string, unknown> }> {
  const path = artifactObjectPath(row.projectId, row.id);
  const skip = (reason: string, problems: readonly string[] = []) => ({ status: 'SKIPPED', report: { artifactId: row.id, projectId: row.projectId, reason, ...(problems.length ? { problems } : {}) } });
  // Second, independent check that this really is a legacy reference: the SQL predicate selected it,
  // and the classifier agrees. An inline or already-migrated artifact is never touched.
  if (classifyArtifactStorage(row.storage) !== 'LEGACY_SUPABASE') return skip('NOT_A_LEGACY_REFERENCE');

  // a) + b) the body as the legacy bucket still holds it. Read only; nothing there is ever written.
  let body: string;
  try {
    body = await legacyStore(row.storage.bucket).get(row.storage);
  } catch (error) {
    const status = httpStatusOf(error);
    // Quota, throttling or an upstream fault: stop the whole run rather than keep pulling on a
    // restricted project. Nothing has been written for this artifact, so a re-run resumes here.
    if (status !== undefined && isUpstreamBackpressure(status)) {
      throw new BlobMigrationBlocked('Legacy Supabase Storage is refusing reads; the migration stopped without changing any row', { artifactId: row.id, status });
    }
    return skip('LEGACY_READ_FAILED', [`status ${status ?? 'unknown'}`]);
  }

  // c) + d) the row's own contract: declared size, and contentHash, which ArtifactStore computed
  // over exactly these bytes.
  const source = verifyBlobIntegrity({ body, expectedSize: row.storage.size, expectedHash: row.contentHash ?? undefined });
  if (!source.ok) return skip('LEGACY_BODY_FAILED_VERIFICATION', source.problems);

  // e) upload -- unless an identical object is already there from an interrupted run.
  let adopted = false;
  const candidate = nextR2Storage({ bucket: r2Bucket, projectId: row.projectId, artifactId: row.id, contentType: row.storage.contentType, size: bodyByteLength(body) });
  const existing = await readFromR2(candidate);
  if (existing.status === 'BACKPRESSURE') throw new BlobMigrationBlocked('R2 is refusing reads; the migration stopped without changing any row', { artifactId: row.id, status: existing.httpStatus });
  if (existing.status === 'FOUND') {
    if (compareExistingObject(existing.body, body) === 'CONFLICT') {
      // Never overwrite: a different object at this exact path is a fact someone has to explain.
      return skip('R2_OBJECT_CONFLICT', ['an object already exists at this path with different content']);
    }
    adopted = true;
  } else if (existing.status === 'MISSING') {
    try {
      await r2.put({ projectId: row.projectId, artifactId: row.id, body, contentType: row.storage.contentType });
    } catch (error) {
      const status = httpStatusOf(error);
      if (status !== undefined && isUpstreamBackpressure(status)) throw new BlobMigrationBlocked('R2 is refusing writes; the migration stopped without changing any row', { artifactId: row.id, status });
      return skip('R2_WRITE_FAILED', [`status ${status ?? 'unknown'}`]);
    }
  }

  // f) + g) read back what R2 now holds and prove it before touching the database.
  const readBack = await readFromR2(candidate);
  if (readBack.status !== 'FOUND') return skip('R2_READ_BACK_FAILED', [`status ${readBack.httpStatus ?? 'unknown'}`]);
  const verified = verifyBlobIntegrity({ body: readBack.body, expectedSize: candidate.size, expectedHash: row.contentHash ?? undefined });
  if (!verified.ok) return skip('R2_BODY_FAILED_VERIFICATION', verified.problems);
  if (sha256Hex(readBack.body) !== sha256Hex(body)) return skip('R2_BODY_DIFFERS_FROM_SOURCE');
  const placement = verifyR2Reference({ reference: candidate, expectedBucket: r2Bucket, projectId: row.projectId, artifactId: row.id });
  if (!placement.ok) return skip('R2_REFERENCE_INVALID', placement.problems);

  // h) only now, and only this one row, in its own short transaction.
  const updated = await repointArtifact(row.id, candidate);
  if (!updated) return skip('ROW_CHANGED_CONCURRENTLY');
  return { status: adopted ? 'ADOPTED' : 'MOVED', report: { artifactId: row.id, projectId: row.projectId, path, size: candidate.size, adoptedExistingObject: adopted } };
}

/** The only write this script performs, against the new database and one row at a time. */
async function repointArtifact(artifactId: string, storage: StorageReference): Promise<boolean> {
  await target.query('BEGIN');
  try {
    // `jsonb_set` replaces the storage sub-document and leaves every other key of `data` untouched.
    // The provider predicate makes the update idempotent and safe against a concurrent change.
    const result = await target.query(
      `UPDATE artifacts
          SET data = jsonb_set(data, '{storage}', $2::jsonb, true),
              storage_bucket = $3, storage_path = $4, byte_size = $5
        WHERE id = $1 AND data->'storage'->>'provider' = $6`,
      [artifactId, JSON.stringify(storage), storage.bucket, storage.path, storage.size, LEGACY_PROVIDER],
    );
    await target.query('COMMIT');
    return result.rowCount === 1;
  } catch (error) {
    await target.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

type R2Read = { status: 'FOUND'; body: string; httpStatus?: undefined } | { status: 'MISSING' | 'BACKPRESSURE' | 'FAILED'; body?: undefined; httpStatus: number | undefined };

async function readFromR2(reference: StorageReference): Promise<R2Read> {
  try {
    return { status: 'FOUND', body: await r2.get(reference) };
  } catch (error) {
    const status = httpStatusOf(error);
    if (status !== undefined && isObjectMissing(status)) return { status: 'MISSING', httpStatus: status };
    if (status !== undefined && isUpstreamBackpressure(status)) return { status: 'BACKPRESSURE', httpStatus: status };
    return { status: 'FAILED', httpStatus: status };
  }
}

// ---------------------------------------------------------------------------
// Reads against the new database
// ---------------------------------------------------------------------------

async function providerTally(): Promise<Array<{ provider: string; count: number }>> {
  const rows = await target.query<{ provider: string; count: string }>("SELECT data->'storage'->>'provider' AS provider, count(*)::bigint AS count FROM artifacts WHERE data->'storage'->>'provider' IS NOT NULL GROUP BY 1 ORDER BY 1");
  return rows.rows.map(row => ({ provider: row.provider, count: Number(row.count) }));
}

// Function declarations, not const arrows: everything below this module's top-level await is
// evaluated during it, so a const here would be in its temporal dead zone when a mode calls it.
async function legacyDeclaredBytes(): Promise<number> {
  return scalar("SELECT COALESCE(sum((data->'storage'->>'size')::bigint), 0)::bigint AS value FROM artifacts WHERE data->'storage'->>'provider' = $1", [LEGACY_PROVIDER]);
}

function legacyArtifacts(count: number): Promise<ArtifactRow[]> {
  return artifactRows(LEGACY_PROVIDER, count, 0);
}

/** Projects only the scalars the migration needs; an artifact body is never selected into memory here. */
async function artifactRows(provider: string, count: number, offset: number): Promise<ArtifactRow[]> {
  const rows = await target.query<{ id: string; project_id: string; content_hash: string | null; provider: string; bucket: string; path: string; content_type: string; size: string }>(
    `SELECT id, project_id, data->>'contentHash' AS content_hash,
            data->'storage'->>'provider' AS provider, data->'storage'->>'bucket' AS bucket,
            data->'storage'->>'path' AS path, data->'storage'->>'contentType' AS content_type,
            data->'storage'->>'size' AS size
       FROM artifacts WHERE data->'storage'->>'provider' = $3 ORDER BY id LIMIT $1 OFFSET $2`,
    [count, offset, provider],
  );
  return rows.rows.map(row => ({
    id: row.id,
    projectId: row.project_id,
    contentHash: row.content_hash,
    storage: { provider: row.provider, bucket: row.bucket, path: row.path, contentType: row.content_type, size: Number(row.size) },
  }));
}

async function scalar(text: string, values: unknown[] = []): Promise<number> {
  return Number((await target.query<{ value: string }>(text, values)).rows[0]?.value ?? 0);
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

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
