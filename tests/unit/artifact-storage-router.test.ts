import { afterEach, describe, expect, it, vi } from "vitest";
import { createArtifactBlobStore } from "../../packages/adapters/artifact-storage/src/wiring.js";
import { RoutingArtifactBlobStore } from "../../packages/adapters/artifact-storage/src/router.js";
import { readLegacySupabaseConfigFromEnv, SupabaseStorageArtifactBlobStore } from "../../packages/adapters/supabase/src/artifact-storage.js";
import { CredentialMissing, PolicyViolation } from "../../packages/core/src/errors.js";
import type { ArtifactBlobStore } from "../../packages/core/src/ports.js";

const R2_ACCOUNT_ID = "a".repeat(32);
const R2_BUCKET = "autopilot-artifacts";
const R2_ACCESS_KEY_ID = "AKIAEXAMPLE1234567890";
const R2_SECRET_ACCESS_KEY = "super-secret-r2-value";
const CURRENT_SUPABASE_URL = "https://aaaaaaaaaaaaaaaaaaaa.supabase.co";
const CURRENT_SUPABASE_KEY = "current-service-role-key";
const LEGACY_SUPABASE_URL = "https://bbbbbbbbbbbbbbbbbbbb.supabase.co";
const LEGACY_SUPABASE_KEY = "legacy-service-role-key";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";
const OBJECT_PATH = `${PROJECT_ID}/${ARTIFACT_ID}.json`;

function fullR2Env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    AUTOPILOT_R2_ACCOUNT_ID: R2_ACCOUNT_ID,
    AUTOPILOT_R2_BUCKET_NAME: R2_BUCKET,
    AUTOPILOT_R2_ACCESS_KEY_ID: R2_ACCESS_KEY_ID,
    AUTOPILOT_R2_SECRET_ACCESS_KEY: R2_SECRET_ACCESS_KEY,
    ...overrides,
  };
}

function mockFetch(status: number, body = "") {
  const fn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(body, { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RoutingArtifactBlobStore (pure routing, no adapters)", () => {
  function fakeStore(): ArtifactBlobStore {
    return { put: vi.fn(), get: vi.fn().mockResolvedValue("payload") };
  }

  it("always sends put() to the primary store, regardless of the readers map", async () => {
    const primary = fakeStore();
    const otherReader = fakeStore();
    const router = new RoutingArtifactBlobStore(primary, { r2: primary, supabase: otherReader });
    await router.put({ projectId: PROJECT_ID, artifactId: ARTIFACT_ID, body: "{}", contentType: "application/json" });
    expect(primary.put).toHaveBeenCalledTimes(1);
    expect(otherReader.put).not.toHaveBeenCalled();
  });

  it("routes get() to the reader matching reference.provider", async () => {
    const primary = fakeStore();
    const legacyReader = fakeStore();
    const router = new RoutingArtifactBlobStore(primary, { r2: primary, supabase: legacyReader });
    const reference = { provider: "supabase", bucket: "b", path: OBJECT_PATH, contentType: "application/json", size: 0 };
    await router.get(reference);
    expect(legacyReader.get).toHaveBeenCalledWith(reference);
    expect(primary.get).not.toHaveBeenCalled();
  });

  it("rejects a provider that isn't a recognized key in the readers map", async () => {
    const primary = fakeStore();
    const router = new RoutingArtifactBlobStore(primary, { r2: primary, supabase: undefined });
    await expect(router.get({ provider: "gcs", bucket: "b", path: OBJECT_PATH, contentType: "application/json", size: 0 })).rejects.toBeInstanceOf(PolicyViolation);
  });

  it("rejects a recognized-but-unconfigured provider with CredentialMissing, not PolicyViolation", async () => {
    const primary = fakeStore();
    const router = new RoutingArtifactBlobStore(primary, { r2: primary, supabase: undefined });
    await expect(router.get({ provider: "supabase", bucket: "b", path: OBJECT_PATH, contentType: "application/json", size: 0 })).rejects.toBeInstanceOf(CredentialMissing);
  });

  it.each(["__proto__", "constructor", "toString"])('rejects the Object.prototype-inherited provider name "%s" as unrecognized, not as a live reader', async provider => {
    const primary = fakeStore();
    const router = new RoutingArtifactBlobStore(primary, { r2: primary, supabase: undefined });
    await expect(router.get({ provider, bucket: "b", path: OBJECT_PATH, contentType: "application/json", size: 0 })).rejects.toBeInstanceOf(PolicyViolation);
    expect(primary.get).not.toHaveBeenCalled();
  });
});

describe("readLegacySupabaseConfigFromEnv", () => {
  it("returns undefined when neither legacy variable is set", () => {
    expect(readLegacySupabaseConfigFromEnv(() => undefined)).toBeUndefined();
  });

  it("returns the config when both legacy variables are set", () => {
    const env: Record<string, string> = { AUTOPILOT_LEGACY_SUPABASE_URL: LEGACY_SUPABASE_URL, AUTOPILOT_LEGACY_SUPABASE_SERVICE_ROLE_KEY: LEGACY_SUPABASE_KEY };
    expect(readLegacySupabaseConfigFromEnv(name => env[name])).toEqual({ url: LEGACY_SUPABASE_URL, serviceRoleKey: LEGACY_SUPABASE_KEY });
  });

  it("fails closed on a partial legacy configuration, naming only the missing variable", () => {
    const env: Record<string, string | undefined> = { AUTOPILOT_LEGACY_SUPABASE_URL: LEGACY_SUPABASE_URL, AUTOPILOT_LEGACY_SUPABASE_SERVICE_ROLE_KEY: undefined };
    let captured: PolicyViolation | undefined;
    expect(() => readLegacySupabaseConfigFromEnv(name => env[name])).toThrow(PolicyViolation);
    try {
      readLegacySupabaseConfigFromEnv(name => env[name]);
    } catch (error) {
      captured = error as PolicyViolation;
    }
    const details = JSON.stringify(captured?.details);
    expect(details).toContain("AUTOPILOT_LEGACY_SUPABASE_SERVICE_ROLE_KEY");
    expect(details).not.toContain(LEGACY_SUPABASE_KEY);
  });
});

describe("createArtifactBlobStore wiring", () => {
  it("without R2 configured, preserves the old Supabase-only behavior exactly (current SUPABASE_URL for both read and write)", async () => {
    const fetchMock = mockFetch(200, "stored");
    const requireCurrentSupabase = vi.fn(() => ({ url: CURRENT_SUPABASE_URL, serviceRoleKey: CURRENT_SUPABASE_KEY }));
    const store = createArtifactBlobStore({ get: () => undefined, requireCurrentSupabase });
    expect(store).toBeInstanceOf(SupabaseStorageArtifactBlobStore);
    expect(requireCurrentSupabase).toHaveBeenCalledTimes(1);

    await store.put({ projectId: PROJECT_ID, artifactId: ARTIFACT_ID, body: "{}", contentType: "application/json" });
    const putUrl = (fetchMock.mock.calls[0] as [string, RequestInit])[0];
    expect(putUrl).toBe(`${CURRENT_SUPABASE_URL}/storage/v1/object/autopilot-artifacts/${OBJECT_PATH}`);

    const text = await store.get({ provider: "supabase", bucket: "autopilot-artifacts", path: OBJECT_PATH, contentType: "application/json", size: 0 });
    expect(text).toBe("stored");
  });

  it("with R2 configured but no legacy credentials, R2 writes succeed without ever touching current-Supabase config", async () => {
    const fetchMock = mockFetch(200);
    const requireCurrentSupabase = vi.fn(() => {
      throw new Error("requireCurrentSupabase must not be called when R2 is fully configured");
    });
    const store = createArtifactBlobStore({ get: name => fullR2Env()[name], requireCurrentSupabase });

    const result = await store.put({ projectId: PROJECT_ID, artifactId: ARTIFACT_ID, body: "hello", contentType: "application/json" });
    expect(result.provider).toBe("r2");
    expect(requireCurrentSupabase).not.toHaveBeenCalled();
    const [putUrl, putInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(putUrl).toBe(`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${OBJECT_PATH}`);
    expect(putInit.method).toBe("PUT");
  });

  it("with R2 configured, get(provider: r2) reads from R2", async () => {
    const fetchMock = mockFetch(200, "r2-content");
    const store = createArtifactBlobStore({ get: name => fullR2Env()[name], requireCurrentSupabase: () => ({ url: CURRENT_SUPABASE_URL, serviceRoleKey: CURRENT_SUPABASE_KEY }) });

    const text = await store.get({ provider: "r2", bucket: R2_BUCKET, path: OBJECT_PATH, contentType: "application/json", size: 0 });
    expect(text).toBe("r2-content");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${OBJECT_PATH}`);
    expect(init.method).toBe("GET");
  });

  it("with R2 configured but no legacy credentials, get(provider: supabase) fails closed with CredentialMissing and never calls the current SUPABASE_URL", async () => {
    const fetchMock = mockFetch(200);
    const requireCurrentSupabase = vi.fn(() => ({ url: CURRENT_SUPABASE_URL, serviceRoleKey: CURRENT_SUPABASE_KEY }));
    const store = createArtifactBlobStore({ get: name => fullR2Env()[name], requireCurrentSupabase });

    await expect(store.get({ provider: "supabase", bucket: "autopilot-artifacts", path: OBJECT_PATH, contentType: "application/json", size: 0 })).rejects.toBeInstanceOf(CredentialMissing);
    expect(requireCurrentSupabase).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with R2 and legacy Supabase both configured, get(provider: supabase) reads through the SEPARATE legacy credential, not the current SUPABASE_URL", async () => {
    const fetchMock = mockFetch(200, "legacy-content");
    const requireCurrentSupabase = vi.fn(() => ({ url: CURRENT_SUPABASE_URL, serviceRoleKey: CURRENT_SUPABASE_KEY }));
    const env = fullR2Env({ AUTOPILOT_LEGACY_SUPABASE_URL: LEGACY_SUPABASE_URL, AUTOPILOT_LEGACY_SUPABASE_SERVICE_ROLE_KEY: LEGACY_SUPABASE_KEY });
    const store = createArtifactBlobStore({ get: name => env[name], requireCurrentSupabase });

    const text = await store.get({ provider: "supabase", bucket: "autopilot-artifacts", path: OBJECT_PATH, contentType: "application/json", size: 0 });
    expect(text).toBe("legacy-content");
    expect(requireCurrentSupabase).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${LEGACY_SUPABASE_URL}/storage/v1/object/autopilot-artifacts/${OBJECT_PATH}`);
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${LEGACY_SUPABASE_KEY}`);
  });

  it("rejects an unrecognized provider even when R2 and legacy Supabase are both configured", async () => {
    mockFetch(200);
    const env = fullR2Env({ AUTOPILOT_LEGACY_SUPABASE_URL: LEGACY_SUPABASE_URL, AUTOPILOT_LEGACY_SUPABASE_SERVICE_ROLE_KEY: LEGACY_SUPABASE_KEY });
    const store = createArtifactBlobStore({ get: name => env[name], requireCurrentSupabase: () => ({ url: CURRENT_SUPABASE_URL, serviceRoleKey: CURRENT_SUPABASE_KEY }) });

    await expect(store.get({ provider: "gcs", bucket: "autopilot-artifacts", path: OBJECT_PATH, contentType: "application/json", size: 0 })).rejects.toBeInstanceOf(PolicyViolation);
  });

  it("fails closed when the legacy Supabase configuration is only partially present, even with R2 fully configured", () => {
    mockFetch(200);
    const env = fullR2Env({ AUTOPILOT_LEGACY_SUPABASE_URL: LEGACY_SUPABASE_URL });
    expect(() => createArtifactBlobStore({ get: name => env[name], requireCurrentSupabase: () => ({ url: CURRENT_SUPABASE_URL, serviceRoleKey: CURRENT_SUPABASE_KEY }) })).toThrow(PolicyViolation);
  });
});
