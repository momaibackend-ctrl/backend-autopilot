import { afterEach, describe, expect, it, vi } from "vitest";
import { R2ArtifactBlobStore, readR2ConfigFromEnv } from "../../packages/adapters/r2/src/artifact-storage.js";
import { SupabaseStorageArtifactBlobStore } from "../../packages/adapters/supabase/src/artifact-storage.js";
import { ExecutionFailed, PolicyViolation } from "../../packages/core/src/errors.js";

const ACCOUNT_ID = "a".repeat(32);
const BUCKET = "autopilot-artifacts";
const ACCESS_KEY_ID = "AKIAEXAMPLE1234567890";
const SECRET_ACCESS_KEY = "super-secret-r2-value-must-never-be-logged";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";
const OBJECT_PATH = `${PROJECT_ID}/${ARTIFACT_ID}.json`;

function store() {
  return new R2ArtifactBlobStore(ACCOUNT_ID, BUCKET, ACCESS_KEY_ID, SECRET_ACCESS_KEY);
}

function mockFetch(status: number, body = "") {
  const fn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(body, { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("R2ArtifactBlobStore", () => {
  it("constructs the account-scoped R2 endpoint and PUTs to the projectId/artifactId.json path", async () => {
    const fetchMock = mockFetch(200);
    const result = await store().put({ projectId: PROJECT_ID, artifactId: ARTIFACT_ID, body: "hello world", contentType: "application/json" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://${ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}/${OBJECT_PATH}`);
    expect(init.method).toBe("PUT");
    expect(init.body).toBe("hello world");
    expect(result).toEqual({ provider: "r2", bucket: BUCKET, path: OBJECT_PATH, contentType: "application/json", size: new TextEncoder().encode("hello world").byteLength });
  });

  it("reports the UTF-8 byte length, not the JS string length, for multi-byte bodies", async () => {
    mockFetch(200);
    const body = "héllo wörld ☃"; // contains multi-byte characters, incl. a snowman
    const result = await store().put({ projectId: PROJECT_ID, artifactId: ARTIFACT_ID, body, contentType: "application/json" });
    const expectedSize = new TextEncoder().encode(body).byteLength;
    expect(expectedSize).not.toBe(body.length);
    expect(result.size).toBe(expectedSize);
  });

  it("performs a signed GET against the same path and returns the stored text", async () => {
    const fetchMock = mockFetch(200, "stored-content");
    const text = await store().get({ provider: "r2", bucket: BUCKET, path: OBJECT_PATH, contentType: "application/json", size: 0 });

    expect(text).toBe("stored-content");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://${ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}/${OBJECT_PATH}`);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("builds an AWS SigV4 Authorization header without ever including the raw secret access key", async () => {
    const fetchMock = mockFetch(200);
    await store().put({ projectId: PROJECT_ID, artifactId: ARTIFACT_ID, body: "{}", contentType: "application/json" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(
      new RegExp(`^AWS4-HMAC-SHA256 Credential=${ACCESS_KEY_ID}/\\d{8}/auto/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$`),
    );
    expect(headers.authorization).not.toContain(SECRET_ACCESS_KEY);
    expect(JSON.stringify(headers)).not.toContain(SECRET_ACCESS_KEY);
    expect(headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signs GET requests without a content-type header", async () => {
    const fetchMock = mockFetch(200, "x");
    await store().get({ provider: "r2", bucket: BUCKET, path: OBJECT_PATH, contentType: "application/json", size: 0 });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBeUndefined();
    expect(headers.authorization).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
  });

  it("rejects a get() reference whose provider is not r2", async () => {
    mockFetch(200);
    await expect(store().get({ provider: "supabase", bucket: BUCKET, path: OBJECT_PATH, contentType: "application/json", size: 0 })).rejects.toBeInstanceOf(PolicyViolation);
  });

  it("rejects a get() reference with an unexpected bucket", async () => {
    mockFetch(200);
    await expect(store().get({ provider: "r2", bucket: "someone-elses-bucket", path: OBJECT_PATH, contentType: "application/json", size: 0 })).rejects.toBeInstanceOf(PolicyViolation);
  });

  it.each([
    "../secrets/x.json",
    `${PROJECT_ID}/../../../etc/passwd`,
    `${PROJECT_ID}\\..\\..\\windows.json`,
    `..\\${ARTIFACT_ID}.json`,
    `/${OBJECT_PATH}`,
    `${OBJECT_PATH}/../x`,
    "not-a-uuid/also-not-a-uuid.json",
  ])("rejects a get() with a path-traversal or malformed path: %s", async (path) => {
    const fetchMock = mockFetch(200);
    await expect(store().get({ provider: "r2", bucket: BUCKET, path, contentType: "application/json", size: 0 })).rejects.toBeInstanceOf(PolicyViolation);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects put() identifiers that are not UUIDs, without making a network request", async () => {
    const fetchMock = mockFetch(200);
    await expect(store().put({ projectId: "../escape", artifactId: ARTIFACT_ID, body: "{}", contentType: "application/json" })).rejects.toBeInstanceOf(PolicyViolation);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a failed upload HTTP response to ExecutionFailed", async () => {
    mockFetch(500, "boom");
    await expect(store().put({ projectId: PROJECT_ID, artifactId: ARTIFACT_ID, body: "{}", contentType: "application/json" })).rejects.toBeInstanceOf(ExecutionFailed);
  });

  it("maps a failed download HTTP response to ExecutionFailed", async () => {
    mockFetch(404);
    await expect(store().get({ provider: "r2", bucket: BUCKET, path: OBJECT_PATH, contentType: "application/json", size: 0 })).rejects.toBeInstanceOf(ExecutionFailed);
  });

  it("validates the account id, bucket name and credentials at construction", () => {
    expect(() => new R2ArtifactBlobStore("not-hex-account-id", BUCKET, ACCESS_KEY_ID, SECRET_ACCESS_KEY)).toThrow(PolicyViolation);
    expect(() => new R2ArtifactBlobStore(ACCOUNT_ID, "A_Bad_Bucket!", ACCESS_KEY_ID, SECRET_ACCESS_KEY)).toThrow(PolicyViolation);
    expect(() => new R2ArtifactBlobStore(ACCOUNT_ID, BUCKET, "", SECRET_ACCESS_KEY)).toThrow(PolicyViolation);
    expect(() => new R2ArtifactBlobStore(ACCOUNT_ID, BUCKET, ACCESS_KEY_ID, "")).toThrow(PolicyViolation);
    expect(() => new R2ArtifactBlobStore(ACCOUNT_ID, BUCKET, ACCESS_KEY_ID, SECRET_ACCESS_KEY)).not.toThrow();
  });
});

describe("readR2ConfigFromEnv", () => {
  const full: Record<string, string> = {
    AUTOPILOT_R2_ACCOUNT_ID: ACCOUNT_ID,
    AUTOPILOT_R2_BUCKET_NAME: BUCKET,
    AUTOPILOT_R2_ACCESS_KEY_ID: ACCESS_KEY_ID,
    AUTOPILOT_R2_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
  };

  it("returns the R2 config when all four AUTOPILOT_R2_* variables are present", () => {
    expect(readR2ConfigFromEnv(name => full[name])).toEqual({ accountId: ACCOUNT_ID, bucketName: BUCKET, accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY });
  });

  it("returns undefined when none are present, preserving the Supabase Storage fallback", () => {
    expect(readR2ConfigFromEnv(() => undefined)).toBeUndefined();
  });

  it("fails closed with only the missing variable names -- never a value -- on a partial configuration", () => {
    const partial: Record<string, string | undefined> = { ...full, AUTOPILOT_R2_SECRET_ACCESS_KEY: undefined };
    expect(() => readR2ConfigFromEnv(name => partial[name])).toThrow(PolicyViolation);
    let captured: PolicyViolation | undefined;
    try {
      readR2ConfigFromEnv(name => partial[name]);
    } catch (error) {
      captured = error as PolicyViolation;
    }
    const details = JSON.stringify(captured?.details);
    expect(details).toContain("AUTOPILOT_R2_SECRET_ACCESS_KEY");
    expect(details).not.toContain(SECRET_ACCESS_KEY);
    for (const value of Object.values(full)) expect(details).not.toContain(value);
  });
});

describe("SupabaseStorageArtifactBlobStore fallback (unchanged when R2 is not configured)", () => {
  it("still rejects an invalid Supabase control-plane URL", () => {
    expect(() => new SupabaseStorageArtifactBlobStore("https://not-a-valid-host.example.com", "service-role-key")).toThrow(PolicyViolation);
  });

  it("still constructs successfully for a valid Supabase URL and service role key", () => {
    expect(() => new SupabaseStorageArtifactBlobStore("https://abcdefghijklmnopqrst.supabase.co", "service-role-key")).not.toThrow();
  });
});
