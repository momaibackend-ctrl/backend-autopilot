import { createHash } from 'node:crypto';

/**
 * Pure decisions for moving an externalized artifact body from the legacy Supabase Storage bucket
 * into R2. No HTTP, no SQL, no adapter: the executable wires those, and every rule that decides
 * whether a blob crossed correctly lives here where it can be tested without a network.
 *
 * The integrity anchor is `Artifact.contentHash` (packages/schemas/src/index.ts). ArtifactStore
 * computes it as `sha256(JSON.stringify(redact(content)))` and stores that exact same string as the
 * blob body (packages/artifact-store/src/index.ts), so the hash recorded in the row is the hash of
 * the bytes -- it verifies a download end to end, with no separate checksum to trust.
 */

export type ArtifactStorageClass = 'INLINE' | 'LEGACY_SUPABASE' | 'R2' | 'UNKNOWN';

export interface StorageReference {
  readonly provider: string;
  readonly bucket: string;
  readonly path: string;
  readonly contentType: string;
  readonly size: number;
}

/** `INLINE` means the artifact never had a blob: its content lives in the row and nothing is moved. */
export function classifyArtifactStorage(storage: unknown): ArtifactStorageClass {
  if (storage === null || storage === undefined) return 'INLINE';
  if (typeof storage !== 'object') return 'UNKNOWN';
  const provider = (storage as Record<string, unknown>)['provider'];
  if (provider === 'supabase') return 'LEGACY_SUPABASE';
  if (provider === 'r2') return 'R2';
  return 'UNKNOWN';
}

/** The object path both stores agree on: `<projectId>/<artifactId>.json`. */
export const artifactObjectPath = (projectId: string, artifactId: string): string => `${projectId}/${artifactId}.json`;

export const sha256Hex = (body: string): string => createHash('sha256').update(body).digest('hex');
export const bodyByteLength = (body: string): number => new TextEncoder().encode(body).byteLength;

export interface IntegrityVerdict {
  readonly ok: boolean;
  /** Short, payload-free reasons -- safe to log verbatim. */
  readonly problems: readonly string[];
}

const verdict = (problems: string[]): IntegrityVerdict => ({ ok: problems.length === 0, problems });

/**
 * Does this body match what the row says it should be? Size and hash are checked independently:
 * a truncated download can keep a plausible length, and a substituted body can keep the length
 * exactly.
 */
export function verifyBlobIntegrity(input: { body: string; expectedSize: number; expectedHash?: string | undefined }): IntegrityVerdict {
  const problems: string[] = [];
  const actualSize = bodyByteLength(input.body);
  if (actualSize !== input.expectedSize) problems.push(`SIZE_MISMATCH (expected ${input.expectedSize}, got ${actualSize})`);
  if (input.expectedHash) {
    if (!/^[0-9a-f]{64}$/i.test(input.expectedHash)) problems.push('CONTENT_HASH_NOT_SHA256');
    else if (sha256Hex(input.body) !== input.expectedHash.toLowerCase()) problems.push('CONTENT_HASH_MISMATCH');
  } else {
    problems.push('CONTENT_HASH_MISSING');
  }
  return verdict(problems);
}

/** The reference that must be written back once the object is verified in R2. */
export function nextR2Storage(input: { bucket: string; projectId: string; artifactId: string; contentType: string; size: number }): StorageReference {
  return { provider: 'r2', bucket: input.bucket, path: artifactObjectPath(input.projectId, input.artifactId), contentType: input.contentType, size: input.size };
}

/** A reference is only acceptable if it names this migration's bucket and the canonical path for its own artifact. */
export function verifyR2Reference(input: { reference: StorageReference; expectedBucket: string; projectId: string; artifactId: string }): IntegrityVerdict {
  const problems: string[] = [];
  if (input.reference.provider !== 'r2') problems.push(`PROVIDER_NOT_R2 (${input.reference.provider})`);
  if (input.reference.bucket !== input.expectedBucket) problems.push('BUCKET_MISMATCH');
  if (input.reference.path !== artifactObjectPath(input.projectId, input.artifactId)) problems.push('PATH_MISMATCH');
  return verdict(problems);
}

export type ExistingObjectVerdict = 'IDENTICAL' | 'CONFLICT';

/**
 * What to do about an object already sitting at the target path. Identical content means a previous
 * run got this far and the upload can be skipped; anything else stops this artifact rather than
 * overwriting, because a destructive overwrite is never the normal path of a migration.
 */
export function compareExistingObject(existingBody: string, sourceBody: string): ExistingObjectVerdict {
  return sha256Hex(existingBody) === sha256Hex(sourceBody) ? 'IDENTICAL' : 'CONFLICT';
}

/**
 * Statuses that mean "the upstream is refusing, not that the object is wrong": payment/quota (402),
 * rate limiting (429) and any server-side failure. The migration stops on these rather than
 * hammering an already quota-restricted project, and leaves every row untouched.
 */
export const isUpstreamBackpressure = (status: number): boolean => status === 402 || status === 429 || status >= 500;
/** A missing object is a fact, not a failure: it means nothing has been uploaded to that path yet. */
export const isObjectMissing = (status: number): boolean => status === 404;

export const httpStatusOf = (error: unknown): number | undefined => {
  const details = (error as { details?: Record<string, unknown> } | undefined)?.details;
  const status = details?.['status'];
  return typeof status === 'number' ? status : undefined;
};
