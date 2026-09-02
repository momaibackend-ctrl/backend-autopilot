import { CredentialMissing, PolicyViolation } from '../../../core/src/errors.js';
import type { ArtifactBlobStore } from '../../../core/src/ports.js';

/**
 * Provider-neutral ArtifactBlobStore composition: every new put() goes to a single `primary`
 * store, while get() is routed by the persisted reference's own `provider` field to whichever
 * concrete adapter actually wrote it. This is what keeps historical externalized artifacts
 * readable across a storage-provider cutover -- old references keep resolving through the adapter
 * that originally wrote them, even after `primary` has moved on to a different provider.
 *
 * This class knows nothing about R2, Supabase, or any other concrete provider: `readers` is
 * supplied fully constructed by the caller, so it never weakens a concrete adapter's own
 * bucket/path validation -- get() always delegates to that adapter's real get() implementation.
 */
export class RoutingArtifactBlobStore implements ArtifactBlobStore {
  constructor(private readonly primary: ArtifactBlobStore, private readonly readers: Record<string, ArtifactBlobStore | undefined>) {}

  put(input: { projectId: string; artifactId: string; body: string; contentType: string }) {
    return this.primary.put(input);
  }

  async get(reference: { provider: string; bucket: string; path: string; contentType: string; size: number }) {
    // Object.hasOwn (not `in`) deliberately excludes the prototype chain: `in` treats
    // "__proto__", "constructor", "toString" etc. as present on any plain object because they
    // resolve through Object.prototype, which would let those provider strings slip past this
    // guard as if they were a real, recognized provider instead of being rejected outright.
    if (!Object.hasOwn(this.readers, reference.provider)) throw new PolicyViolation(`Unrecognized artifact storage provider "${reference.provider}"`, { provider: reference.provider });
    const reader = this.readers[reference.provider];
    if (!reader) throw new CredentialMissing(`No artifact storage reader is configured for provider "${reference.provider}"`, { provider: reference.provider });
    return reader.get(reference);
  }
}
