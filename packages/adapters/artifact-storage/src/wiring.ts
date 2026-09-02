import { R2ArtifactBlobStore, readR2ConfigFromEnv } from '../../r2/src/artifact-storage.js';
import { readLegacySupabaseConfigFromEnv, SupabaseStorageArtifactBlobStore } from '../../supabase/src/artifact-storage.js';
import type { ArtifactBlobStore } from '../../../core/src/ports.js';
import { RoutingArtifactBlobStore } from './router.js';

/**
 * The single ArtifactBlobStore selection shared by the Edge Runtime and the GitHub Actions
 * execution runner, so the R2/legacy-Supabase gating logic exists in exactly one place.
 *
 * - No AUTOPILOT_R2_* configured: unchanged legacy behavior -- a plain SupabaseStorageArtifactBlobStore
 *   against the runtime's own current SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (only resolved in
 *   this branch, via `requireCurrentSupabase`, so a fully configured R2 never needs them).
 * - R2 configured: new put()s always go to R2. get() routes by the persisted reference.provider --
 *   "r2" reads from R2; "supabase" reads pre-cutover externalized artifacts through a SEPARATE,
 *   explicitly-configured AUTOPILOT_LEGACY_SUPABASE_* credential, never through the runtime's own
 *   (possibly already-migrated) SUPABASE_URL. Missing legacy credentials fail closed with a typed
 *   CredentialMissing on read, rather than silently falling back to the current SUPABASE_URL.
 */
export function createArtifactBlobStore(input: { get: (name: string) => string | undefined; requireCurrentSupabase: () => { url: string; serviceRoleKey: string } }): ArtifactBlobStore {
  const r2Config = readR2ConfigFromEnv(input.get);
  if (!r2Config) {
    const current = input.requireCurrentSupabase();
    return new SupabaseStorageArtifactBlobStore(current.url, current.serviceRoleKey);
  }
  const r2Store = new R2ArtifactBlobStore(r2Config.accountId, r2Config.bucketName, r2Config.accessKeyId, r2Config.secretAccessKey);
  const legacyConfig = readLegacySupabaseConfigFromEnv(input.get);
  const legacyStore = legacyConfig ? new SupabaseStorageArtifactBlobStore(legacyConfig.url, legacyConfig.serviceRoleKey) : undefined;
  return new RoutingArtifactBlobStore(r2Store, { r2: r2Store, supabase: legacyStore });
}
