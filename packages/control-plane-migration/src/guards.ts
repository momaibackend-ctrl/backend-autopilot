/**
 * Pure fail-closed decisions for the control-plane state migration. Each one answers a single
 * question with counts and names only -- never a connection string, a URL, a credential or a row
 * payload -- so the caller can print the whole result straight into a workflow log.
 */

/**
 * The exact next-project URL shape. Anchored end-to-end on purpose: matching only the first label
 * would accept `https://<20-char>.evil.com`, and matching only a prefix would accept
 * `https://<20-char>.supabase.co.evil.com` or a URL carrying a path, query or fragment. The one
 * concession is a single optional trailing slash.
 *
 * The literal is shared with `.github/workflows/supabase-next.yml`, which feeds it to `grep -E`;
 * the pattern uses only syntax that POSIX ERE and JavaScript agree on, and a unit test asserts the
 * workflow still carries this exact string.
 */
export const nextSupabaseUrlPattern = '^https://[a-z0-9]{20}\\.supabase\\.co/?$';

/** Returns the 20-character project ref, or undefined if the URL is not exactly a Supabase project URL. The value itself is never included in any thrown error. */
export function resolveNextSupabaseProjectRef(url: string): string | undefined {
  const match = new RegExp(nextSupabaseUrlPattern).exec(url.trim());
  if (!match) return undefined;
  return url.trim().slice('https://'.length).split('.')[0];
}

interface Endpoint {
  /** host:port/database -- enough to identify an ordinary PostgreSQL endpoint. */
  readonly identity: string;
  readonly database: string;
  /** Supabase project ref, when the URL identifies one. */
  readonly projectRef?: string;
}

const decoded = (value: string): string => { try { return decodeURIComponent(value); } catch { return value; } };

/**
 * Which Supabase project a connection string addresses, when it says so.
 *
 * Two shapes carry it. A direct connection names it in the host (`db.<ref>.supabase.co`). A pooled
 * connection does NOT: every project shares one regional pooler host, port and `postgres` database,
 * and the tenant is carried in the username as `<role>.<ref>`. Ignoring the username there made two
 * different projects behind the same pooler look like one database.
 */
function supabaseProjectRef(url: URL): string | undefined {
  const host = url.hostname.toLowerCase();
  if (host.endsWith('.pooler.supabase.com')) return /^[^.]+\.([a-z0-9]+)$/.exec(decoded(url.username))?.[1];
  return /^db\.([a-z0-9]+)\.supabase\.co$/.exec(host)?.[1];
}

const parseEndpoint = (value: string): Endpoint | undefined => {
  try {
    const url = new URL(value.trim());
    const projectRef = supabaseProjectRef(url);
    return { identity: `${url.hostname.toLowerCase()}:${url.port || '5432'}${url.pathname}`, database: url.pathname, ...(projectRef ? { projectRef } : {}) };
  } catch { return undefined; }
};

/**
 * True when both connection strings address the same database -- the one thing that would turn a
 * "copy" into an insert of a table into itself.
 *
 * Ordinary endpoints are compared by host/port/database, so a source and target differing only in
 * credentials or query parameters are still one database. When BOTH sides name a Supabase project,
 * that project decides instead: it separates two tenants sharing a pooler host, and it also joins
 * the same project reached two ways (session port 5432 vs transaction port 6543, or pooled vs
 * direct). Anything unparseable stays fail-safe on the existing behaviour and is not claimed to
 * match. No connection string, username or ref is ever surfaced by this function.
 */
export function sameDatabaseEndpoint(source: string, target: string): boolean {
  if (source.trim() === target.trim()) return true;
  const left = parseEndpoint(source);
  const right = parseEndpoint(target);
  if (!left || !right) return false;
  if (left.projectRef && right.projectRef) return left.projectRef === right.projectRef && left.database === right.database;
  return left.identity === right.identity;
}

export interface Tally { readonly key: string; readonly count: number }

export interface SourceActivity {
  readonly blocked: boolean;
  readonly activeExecutionJobs: readonly Tally[];
  readonly transientTasks: readonly Tally[];
}

/** A copy may only run against a quiet source: in-flight jobs and transient task states are both mid-write, and the runner behind them still targets the old database. */
export function evaluateSourceActivity(input: { activeExecutionJobs: readonly Tally[]; transientTasks: readonly Tally[] }): SourceActivity {
  const activeExecutionJobs = input.activeExecutionJobs.filter(entry => entry.count > 0);
  const transientTasks = input.transientTasks.filter(entry => entry.count > 0);
  return { blocked: activeExecutionJobs.length > 0 || transientTasks.length > 0, activeExecutionJobs, transientTasks };
}

export interface TargetReadiness {
  readonly ready: boolean;
  readonly occupied: readonly Tally[];
}

/** After `pnpm db:migrate` the target may only hold migration-seeded rows. Any operational row means a target that already carries state, and this migration never overwrites one. */
export function evaluateTargetReadiness(counts: readonly Tally[]): TargetReadiness {
  const occupied = counts.filter(entry => entry.count > 0);
  return { ready: occupied.length === 0, occupied };
}
