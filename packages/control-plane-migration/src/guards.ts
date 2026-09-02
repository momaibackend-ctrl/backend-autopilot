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

const endpointIdentity = (value: string): string | undefined => {
  try {
    const url = new URL(value.trim());
    return `${url.hostname.toLowerCase()}:${url.port || '5432'}${url.pathname}`;
  } catch { return undefined; }
};

/**
 * True when both connection strings address the same database. Compares the parsed host/port/path
 * as well as the raw strings, so a source and target that differ only in credentials or query
 * parameters are still recognised as one database -- which would turn a "copy" into a self-insert.
 */
export function sameDatabaseEndpoint(source: string, target: string): boolean {
  if (source.trim() === target.trim()) return true;
  const left = endpointIdentity(source);
  const right = endpointIdentity(target);
  return Boolean(left && right && left === right);
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
