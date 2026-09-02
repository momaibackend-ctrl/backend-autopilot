import { createHash } from 'node:crypto';

/**
 * Deterministic row hashing, so "did every byte arrive" is answered by comparing two 64-character
 * digests instead of by shipping rows back through the log.
 *
 * The canonical form is what makes the two sides comparable: object keys are sorted (jsonb key
 * order is a storage detail, not data), timestamps become ISO strings rather than driver `Date`
 * objects, byte arrays become hex, and bigint/`numeric` values that the driver hands back as
 * strings stay strings. Row order is fixed by the caller's primary-key ORDER BY.
 */
export function canonicalValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `hex:${Buffer.from(value).toString('hex')}`;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map(key => [key, canonicalValue(source[key])]));
  }
  return value;
}

export const canonicalRowText = (row: readonly unknown[]): string => JSON.stringify(row.map(canonicalValue));

export class RowHasher {
  private readonly hash = createHash('sha256');
  private rows = 0;
  add(row: readonly unknown[]): void { this.hash.update(canonicalRowText(row)); this.hash.update('\n'); this.rows += 1; }
  get count(): number { return this.rows; }
  digest(): string { return this.hash.digest('hex'); }
}

export function hashRows(rows: Iterable<readonly unknown[]>): string {
  const hasher = new RowHasher();
  for (const row of rows) hasher.add(row);
  return hasher.digest();
}

export interface KeyedComparison {
  readonly matched: number;
  /** Source keys with no target row at all. */
  readonly missing: readonly string[];
  /** Source keys whose target row holds different data. */
  readonly different: readonly string[];
}

/**
 * Seed-merged tables are not compared by equality: the target legitimately keeps migration-seeded
 * keys the source never had. What must hold is that every SOURCE key reached the target unchanged.
 */
export function compareKeyedData(source: ReadonlyMap<string, unknown>, target: ReadonlyMap<string, unknown>): KeyedComparison {
  const missing: string[] = [];
  const different: string[] = [];
  let matched = 0;
  for (const [key, value] of source) {
    if (!target.has(key)) { missing.push(key); continue; }
    if (JSON.stringify(canonicalValue(value)) !== JSON.stringify(canonicalValue(target.get(key)))) different.push(key);
    else matched += 1;
  }
  return { matched, missing: missing.sort(), different: different.sort() };
}

export interface MarkerComparison extends KeyedComparison {
  /** `schema:*` keys where the target deliberately kept its own provenance -- expected, never a mismatch. */
  readonly schemaKeptByTarget: readonly string[];
}

/**
 * Markers follow the copy rule: `schema:*` records which migrations ran against THIS database, so a
 * differing target value is correct rather than a discrepancy. Every other marker must have crossed.
 */
export function compareMarkers(source: ReadonlyMap<string, unknown>, target: ReadonlyMap<string, unknown>): MarkerComparison {
  const schemaKeptByTarget: string[] = [];
  const portable = new Map<string, unknown>();
  for (const [key, value] of source) {
    if (key.startsWith('schema:')) { if (target.has(key)) schemaKeptByTarget.push(key); else portable.set(key, value); }
    else portable.set(key, value);
  }
  return { ...compareKeyedData(portable, target), schemaKeptByTarget: schemaKeptByTarget.sort() };
}
