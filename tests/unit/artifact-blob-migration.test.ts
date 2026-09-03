import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import {
  artifactObjectPath,
  bodyByteLength,
  classifyArtifactStorage,
  compareExistingObject,
  httpStatusOf,
  isObjectMissing,
  isUpstreamBackpressure,
  nextR2Storage,
  sha256Hex,
  verifyBlobIntegrity,
  verifyR2Reference,
} from "../../packages/control-plane-migration/src/index.js";

const PROJECT = "22222222-2222-4222-8222-222222222222";
const ARTIFACT_A = "aaaaaaaa-1111-4111-8111-000000000001";
const ARTIFACT_B = "aaaaaaaa-1111-4111-8111-000000000002";
const INLINE_ARTIFACT = "aaaaaaaa-1111-4111-8111-000000000003";
const MIGRATED_ARTIFACT = "aaaaaaaa-1111-4111-8111-000000000004";
const LEGACY_BUCKET = "autopilot-artifacts";
const R2_BUCKET = "autopilot-artifacts-next";
const LEGACY_URL = "https://abcdefghijklmnopqrst.supabase.co";
const R2_ACCOUNT = "a".repeat(32);

const bodyOf = (id: string) => JSON.stringify({ diff: `evidence for ${id}`, changedFiles: ["src/a.ts"] });

describe("artifact blob helpers", () => {
  it("classifies a storage reference by its provider, and an absent one as inline", () => {
    expect(classifyArtifactStorage(undefined)).toBe("INLINE");
    expect(classifyArtifactStorage(null)).toBe("INLINE");
    expect(classifyArtifactStorage({ provider: "supabase" })).toBe("LEGACY_SUPABASE");
    expect(classifyArtifactStorage({ provider: "r2" })).toBe("R2");
    expect(classifyArtifactStorage({ provider: "gcs" })).toBe("UNKNOWN");
    expect(classifyArtifactStorage("nonsense")).toBe("UNKNOWN");
  });

  it("uses the one object path both stores agree on", () => {
    expect(artifactObjectPath(PROJECT, ARTIFACT_A)).toBe(`${PROJECT}/${ARTIFACT_A}.json`);
    expect(nextR2Storage({ bucket: R2_BUCKET, projectId: PROJECT, artifactId: ARTIFACT_A, contentType: "application/json", size: 12 }))
      .toEqual({ provider: "r2", bucket: R2_BUCKET, path: `${PROJECT}/${ARTIFACT_A}.json`, contentType: "application/json", size: 12 });
  });

  it("verifies a body against the row's declared size and contentHash", () => {
    const body = bodyOf(ARTIFACT_A);
    const hash = createHash("sha256").update(body).digest("hex");
    expect(verifyBlobIntegrity({ body, expectedSize: bodyByteLength(body), expectedHash: hash })).toEqual({ ok: true, problems: [] });
    expect(verifyBlobIntegrity({ body, expectedSize: bodyByteLength(body) + 1, expectedHash: hash }).problems[0]).toMatch(/^SIZE_MISMATCH/);
    expect(verifyBlobIntegrity({ body, expectedSize: bodyByteLength(body), expectedHash: "0".repeat(64) }).problems).toEqual(["CONTENT_HASH_MISMATCH"]);
    expect(verifyBlobIntegrity({ body, expectedSize: bodyByteLength(body), expectedHash: undefined }).problems).toEqual(["CONTENT_HASH_MISSING"]);
    expect(verifyBlobIntegrity({ body, expectedSize: bodyByteLength(body), expectedHash: "not-a-hash" }).problems).toEqual(["CONTENT_HASH_NOT_SHA256"]);
  });

  it("catches a substituted body that happens to keep the same length", () => {
    const body = "0123456789";
    const other = "9876543210";
    expect(bodyByteLength(body)).toBe(bodyByteLength(other));
    expect(verifyBlobIntegrity({ body: other, expectedSize: 10, expectedHash: sha256Hex(body) }).problems).toEqual(["CONTENT_HASH_MISMATCH"]);
  });

  it("only accepts an R2 reference in this bucket at this artifact's canonical path", () => {
    const good = nextR2Storage({ bucket: R2_BUCKET, projectId: PROJECT, artifactId: ARTIFACT_A, contentType: "application/json", size: 1 });
    expect(verifyR2Reference({ reference: good, expectedBucket: R2_BUCKET, projectId: PROJECT, artifactId: ARTIFACT_A }).ok).toBe(true);
    expect(verifyR2Reference({ reference: good, expectedBucket: "other", projectId: PROJECT, artifactId: ARTIFACT_A }).problems).toEqual(["BUCKET_MISMATCH"]);
    expect(verifyR2Reference({ reference: good, expectedBucket: R2_BUCKET, projectId: PROJECT, artifactId: ARTIFACT_B }).problems).toEqual(["PATH_MISMATCH"]);
    expect(verifyR2Reference({ reference: { ...good, provider: "supabase" }, expectedBucket: R2_BUCKET, projectId: PROJECT, artifactId: ARTIFACT_A }).problems[0]).toMatch(/^PROVIDER_NOT_R2/);
  });

  it("adopts an identical existing object and refuses a differing one", () => {
    expect(compareExistingObject("same", "same")).toBe("IDENTICAL");
    expect(compareExistingObject("different", "same")).toBe("CONFLICT");
  });

  it("separates upstream backpressure from a missing object", () => {
    for (const status of [402, 429, 500, 502, 503]) expect(isUpstreamBackpressure(status)).toBe(true);
    for (const status of [400, 403, 404, 409]) expect(isUpstreamBackpressure(status)).toBe(false);
    expect(isObjectMissing(404)).toBe(true);
    expect(isObjectMissing(403)).toBe(false);
    expect(httpStatusOf({ details: { status: 429 } })).toBe(429);
    expect(httpStatusOf(new Error("no details"))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Runtime: the real entrypoint against an in-memory database and object stores
// ---------------------------------------------------------------------------

const { FakeClient, store } = vi.hoisted(() => {
  interface Row { id: string; project_id: string; task_id: string | null; data: Record<string, unknown>; storage_bucket: string | null; storage_path: string | null; byte_size: string | null }
  const store = {
    artifacts: [] as Row[],
    legacyObjects: new Map<string, string>(),
    r2Objects: new Map<string, string>(),
    requests: [] as Array<{ method: string; url: string }>,
    connections: [] as string[],
    statements: [] as string[],
    /** Responses the fake HTTP layer should force, keyed by "<host-kind>:<method>". */
    forced: {} as Record<string, number>,
    reset(artifacts: Row[]) {
      this.artifacts = artifacts; this.legacyObjects = new Map(); this.r2Objects = new Map();
      this.requests = []; this.connections = []; this.statements = []; this.forced = {};
    },
    row(id: string): Row | undefined { return this.artifacts.find(row => row.id === id); },
    storageOf(id: string): Record<string, unknown> | undefined { return this.row(id)?.data["storage"] as Record<string, unknown> | undefined; },
  };

  class FakeClient {
    private readonly connection: string;
    constructor(config: { connectionString: string }) { this.connection = config.connectionString; store.connections.push(config.connectionString); }
    async connect(): Promise<void> { /* no socket */ }
    async end(): Promise<void> { /* nothing to close */ }
    async query(config: string | { text: string; values?: unknown[] }, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
      const text = (typeof config === "string" ? config : config.text).replace(/\s+/g, " ").trim();
      const bound = ((typeof config === "string" ? values : config.values) ?? []) as unknown[];
      store.statements.push(text);
      const provider = (row: Row) => (row.data["storage"] as Record<string, unknown> | undefined)?.["provider"];

      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [], rowCount: 0 };
      if (/^SELECT count\(\*\)::bigint AS value FROM artifacts$/.test(text)) return { rows: [{ value: String(store.artifacts.length) }], rowCount: 1 };
      if (/data->'storage' IS NULL/.test(text)) return { rows: [{ value: String(store.artifacts.filter(row => row.data["storage"] === undefined).length) }], rowCount: 1 };
      if (/AS provider, count\(\*\)/.test(text)) {
        const tally = new Map<string, number>();
        for (const row of store.artifacts) { const value = provider(row); if (typeof value === "string") tally.set(value, (tally.get(value) ?? 0) + 1); }
        return { rows: [...tally.entries()].sort().map(([key, count]) => ({ provider: key, count: String(count) })), rowCount: tally.size };
      }
      if (/COALESCE\(sum/.test(text)) {
        const total = store.artifacts.filter(row => provider(row) === bound[0]).reduce((sum, row) => sum + Number((row.data["storage"] as Record<string, unknown>)["size"]), 0);
        return { rows: [{ value: String(total) }], rowCount: 1 };
      }
      if (/FROM artifacts WHERE task_id = ANY/.test(text)) {
        const ids = (bound[0] ?? []) as string[];
        return { rows: [{ value: String(store.artifacts.filter(row => row.task_id && ids.includes(row.task_id)).length) }], rowCount: 1 };
      }
      if (/^SELECT id, project_id, data->>'contentHash'/.test(text)) {
        const matching = store.artifacts.filter(row => provider(row) === bound[2]).sort((a, b) => a.id.localeCompare(b.id)).slice(Number(bound[1]), Number(bound[1]) + Number(bound[0]));
        return {
          rows: matching.map(row => {
            const storage = row.data["storage"] as Record<string, unknown>;
            return { id: row.id, project_id: row.project_id, content_hash: row.data["contentHash"] ?? null, provider: storage["provider"], bucket: storage["bucket"], path: storage["path"], content_type: storage["contentType"], size: String(storage["size"]) };
          }),
          rowCount: matching.length,
        };
      }
      if (/^UPDATE artifacts SET data = jsonb_set/.test(text)) {
        const row = store.row(String(bound[0]));
        if (!row || provider(row) !== bound[5]) return { rows: [], rowCount: 0 };
        row.data = { ...row.data, storage: JSON.parse(String(bound[1])) as Record<string, unknown> };
        row.storage_bucket = String(bound[2]); row.storage_path = String(bound[3]); row.byte_size = String(bound[4]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unhandled statement: ${text}`);
    }
  }
  return { FakeClient, store };
});

vi.mock("pg", () => ({ Client: FakeClient }));

const TARGET_DB = "postgresql://blob-test:fake@target.invalid:5432/autopilot";

function legacyStorage(artifactId: string) {
  const body = bodyOf(artifactId);
  return { provider: "supabase", bucket: LEGACY_BUCKET, path: `${PROJECT}/${artifactId}.json`, contentType: "application/json", size: bodyByteLength(body) };
}

function artifactRow(artifactId: string, overrides: Record<string, unknown> = {}) {
  const body = bodyOf(artifactId);
  return {
    id: artifactId, project_id: PROJECT, task_id: null,
    storage_bucket: LEGACY_BUCKET, storage_path: `${PROJECT}/${artifactId}.json`, byte_size: String(bodyByteLength(body)),
    data: {
      id: artifactId, projectId: PROJECT, kind: "CODE_DIFF", schemaVersion: "1", status: "AVAILABLE",
      content: { externalized: true }, contentHash: sha256Hex(body), createdAt: "2026-02-01T00:00:00.000Z",
      storage: legacyStorage(artifactId), ...overrides,
    },
  };
}

interface RunResult { logs: string[]; errors: string[]; failure: unknown; exitCode: number }

async function run(mode: "inventory" | "copy" | "verify"): Promise<RunResult> {
  process.argv = ["node", "migrate-artifact-blobs-r2.ts", "--mode", mode];
  process.env["TARGET_DATABASE_URL"] = TARGET_DB;
  process.env["AUTOPILOT_LEGACY_SUPABASE_URL"] = LEGACY_URL;
  process.env["AUTOPILOT_LEGACY_SUPABASE_SERVICE_ROLE_KEY"] = "legacy-service-role-key";
  process.env["AUTOPILOT_R2_ACCOUNT_ID"] = R2_ACCOUNT;
  process.env["AUTOPILOT_R2_BUCKET_NAME"] = R2_BUCKET;
  process.env["AUTOPILOT_R2_ACCESS_KEY_ID"] = "AKIAEXAMPLE1234567890";
  process.env["AUTOPILOT_R2_SECRET_ACCESS_KEY"] = "super-secret-r2-value";
  process.exitCode = 0;
  const logs: string[] = [];
  const errors: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation(message => { logs.push(String(message)); });
  const error = vi.spyOn(console, "error").mockImplementation(message => { errors.push(String(message)); });
  let failure: unknown;
  vi.resetModules();
  try {
    await import("../../scripts/migrate-artifact-blobs-r2.js");
  } catch (thrown) {
    failure = thrown;
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return { logs, errors, failure, exitCode: process.exitCode ?? 0 };
}

/**
 * Fails loudly when the script threw instead of reporting: a missing report used to make several of
 * these tests pass while covering nothing at all.
 */
const reportOf = (result: RunResult, event: string): Record<string, unknown> => {
  if (result.failure) throw new Error(`the migration script threw instead of reporting: ${String((result.failure as Error).message ?? result.failure)}`);
  const report = result.logs.map(line => JSON.parse(line) as Record<string, unknown>).find(entry => entry["event"] === event);
  if (!report) throw new Error(`no ${event} report was emitted; stdout was: ${result.logs.join(" | ")} / stderr: ${result.errors.join(" | ")}`);
  return report;
};

const originalArgv = process.argv;

beforeEach(() => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    store.requests.push({ method, url });
    const legacy = new RegExp(`^${LEGACY_URL}/storage/v1/object/([^/]+)/(.+)$`).exec(url);
    const r2 = new RegExp(`^https://${R2_ACCOUNT}\\.r2\\.cloudflarestorage\\.com/([^/]+)/(.+)$`).exec(url);
    const forced = store.forced[`${legacy ? "legacy" : "r2"}:${method}`];
    if (forced) return new Response("forced", { status: forced });
    if (legacy && method === "GET") {
      const body = store.legacyObjects.get(legacy[2] as string);
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { status: 200 });
    }
    if (r2 && method === "PUT") { store.r2Objects.set(r2[2] as string, String(init?.body ?? "")); return new Response("", { status: 200 }); }
    if (r2 && method === "GET") {
      const body = store.r2Objects.get(r2[2] as string);
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { status: 200 });
    }
    return new Response("unexpected", { status: 400 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.argv = originalArgv;
  for (const key of ["TARGET_DATABASE_URL", "AUTOPILOT_LEGACY_SUPABASE_URL", "AUTOPILOT_LEGACY_SUPABASE_SERVICE_ROLE_KEY", "AUTOPILOT_R2_ACCOUNT_ID", "AUTOPILOT_R2_BUCKET_NAME", "AUTOPILOT_R2_ACCESS_KEY_ID", "AUTOPILOT_R2_SECRET_ACCESS_KEY"]) delete process.env[key];
  process.exitCode = 0;
});

/** Two legacy artifacts, one inline artifact and one already migrated. */
function seed() {
  store.reset([
    artifactRow(ARTIFACT_A),
    artifactRow(ARTIFACT_B),
    { ...artifactRow(INLINE_ARTIFACT), data: { id: INLINE_ARTIFACT, projectId: PROJECT, contentHash: sha256Hex("inline"), content: { inline: true } } },
    { ...artifactRow(MIGRATED_ARTIFACT), data: { ...artifactRow(MIGRATED_ARTIFACT).data, storage: { provider: "r2", bucket: R2_BUCKET, path: `${PROJECT}/${MIGRATED_ARTIFACT}.json`, contentType: "application/json", size: bodyByteLength(bodyOf(MIGRATED_ARTIFACT)) } } },
  ]);
  store.legacyObjects.set(`${PROJECT}/${ARTIFACT_A}.json`, bodyOf(ARTIFACT_A));
  store.legacyObjects.set(`${PROJECT}/${ARTIFACT_B}.json`, bodyOf(ARTIFACT_B));
  store.r2Objects.set(`${PROJECT}/${MIGRATED_ARTIFACT}.json`, bodyOf(MIGRATED_ARTIFACT));
}

describe("inventory", () => {
  it("counts only the legacy references in the new database", async () => {
    seed();
    const report = reportOf(await run("inventory"), "artifact_blob_migration.inventory");
    expect(report["totalArtifacts"]).toBe(4);
    expect(report["blobsToMove"]).toBe(2);
    expect(report["alreadyMigrated"]).toBe(1);
    expect(report["inlineArtifacts"]).toBe(1);
    expect(report["declaredBytesToMove"]).toBe(bodyByteLength(bodyOf(ARTIFACT_A)) + bodyByteLength(bodyOf(ARTIFACT_B)));
    expect((report["sampleToMove"] as Array<Record<string, unknown>>).map(entry => entry["artifactId"])).toEqual([ARTIFACT_A, ARTIFACT_B]);
  });

  it("changes nothing and never reads an object", async () => {
    seed();
    const result = await run("inventory");
    expect(result.failure).toBeUndefined();
    expect(store.requests).toEqual([]);
    expect(store.statements.some(statement => /^UPDATE/i.test(statement))).toBe(false);
  });
});

describe("copy", () => {
  it("moves each legacy body into R2 and repoints only that row", async () => {
    seed();
    const result = await run("copy");
    expect(result.errors).toEqual([]);
    const report = reportOf(result, "artifact_blob_migration.copy");
    expect(report["movedCount"]).toBe(2);
    for (const id of [ARTIFACT_A, ARTIFACT_B]) {
      expect(store.r2Objects.get(`${PROJECT}/${id}.json`)).toBe(bodyOf(id));
      expect(store.storageOf(id)).toEqual({ provider: "r2", bucket: R2_BUCKET, path: `${PROJECT}/${id}.json`, contentType: "application/json", size: bodyByteLength(bodyOf(id)) });
      expect(store.row(id)?.storage_bucket).toBe(R2_BUCKET);
    }
  });

  it("leaves every other field of the artifact untouched", async () => {
    seed();
    const before = JSON.parse(JSON.stringify(store.row(ARTIFACT_A)?.data)) as Record<string, unknown>;
    reportOf(await run("copy"), "artifact_blob_migration.copy");
    expect(store.storageOf(ARTIFACT_A)?.["provider"]).toBe("r2");
    const after = store.row(ARTIFACT_A)?.data as Record<string, unknown>;
    for (const key of Object.keys(before)) {
      if (key === "storage") continue;
      expect(after[key], `${key} must be untouched`).toEqual(before[key]);
    }
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  });

  it("skips an artifact already pointing at R2 without re-uploading it", async () => {
    seed();
    await run("copy");
    const puts = store.requests.filter(request => request.method === "PUT" && request.url.includes(MIGRATED_ARTIFACT));
    expect(puts).toEqual([]);
    expect(store.storageOf(MIGRATED_ARTIFACT)?.["provider"]).toBe("r2");
  });

  it("never touches an inline artifact", async () => {
    seed();
    await run("copy");
    expect(store.storageOf(INLINE_ARTIFACT)).toBeUndefined();
    expect(store.requests.some(request => request.url.includes(INLINE_ARTIFACT))).toBe(false);
  });

  it("writes the row only after the body has been read back from R2", async () => {
    seed();
    await run("copy");
    const forA = store.requests.filter(request => request.url.includes(ARTIFACT_A)).map(request => request.method);
    // GET legacy, GET r2 (absent), PUT r2, GET r2 (read back) -- the update follows all of them.
    expect(forA).toEqual(["GET", "GET", "PUT", "GET"]);
    const updateIndex = store.statements.findIndex(statement => /^UPDATE artifacts/.test(statement));
    expect(updateIndex).toBeGreaterThan(-1);
  });

  it("leaves the row on supabase when the legacy read fails", async () => {
    seed();
    store.forced["legacy:GET"] = 403;
    await run("copy");
    expect(store.storageOf(ARTIFACT_A)?.["provider"]).toBe("supabase");
    expect(store.statements.some(statement => /^UPDATE/i.test(statement))).toBe(false);
  });

  it("leaves the row on supabase when the R2 write fails", async () => {
    seed();
    store.forced["r2:PUT"] = 403;
    await run("copy");
    expect(store.storageOf(ARTIFACT_A)?.["provider"]).toBe("supabase");
    expect(store.statements.some(statement => /^UPDATE/i.test(statement))).toBe(false);
  });

  it("leaves the row on supabase when the legacy body fails its own contentHash", async () => {
    seed();
    store.legacyObjects.set(`${PROJECT}/${ARTIFACT_A}.json`, bodyOf("a different artifact entirely"));
    const report = reportOf(await run("copy"), "artifact_blob_migration.copy");
    expect(store.storageOf(ARTIFACT_A)?.["provider"]).toBe("supabase");
    expect(store.r2Objects.has(`${PROJECT}/${ARTIFACT_A}.json`)).toBe(false);
    expect((report["skipped"] as Array<Record<string, unknown>>).some(entry => entry["reason"] === "LEGACY_BODY_FAILED_VERIFICATION")).toBe(true);
  });

  it("adopts an identical object already in R2 without overwriting it", async () => {
    seed();
    store.r2Objects.set(`${PROJECT}/${ARTIFACT_A}.json`, bodyOf(ARTIFACT_A));
    await run("copy");
    expect(store.requests.filter(request => request.method === "PUT" && request.url.includes(ARTIFACT_A))).toEqual([]);
    expect(store.storageOf(ARTIFACT_A)?.["provider"]).toBe("r2");
  });

  it("refuses to overwrite a conflicting object already in R2", async () => {
    seed();
    store.r2Objects.set(`${PROJECT}/${ARTIFACT_A}.json`, "someone else's bytes");
    const report = reportOf(await run("copy"), "artifact_blob_migration.copy");
    expect(store.r2Objects.get(`${PROJECT}/${ARTIFACT_A}.json`)).toBe("someone else's bytes");
    expect(store.storageOf(ARTIFACT_A)?.["provider"]).toBe("supabase");
    expect((report["skipped"] as Array<Record<string, unknown>>).some(entry => entry["reason"] === "R2_OBJECT_CONFLICT")).toBe(true);
    // The other artifact still migrates: one conflict does not stop unrelated work.
    expect(store.storageOf(ARTIFACT_B)?.["provider"]).toBe("r2");
  });

  it("stops the whole run on upstream backpressure without changing a row", async () => {
    seed();
    store.forced["legacy:GET"] = 429;
    const result = await run("copy");
    expect(result.exitCode).toBe(1);
    const blocked = result.errors.map(line => JSON.parse(line) as Record<string, unknown>).find(entry => entry["event"] === "artifact_blob_migration.blocked");
    expect(blocked?.["status"]).toBe(429);
    expect(store.storageOf(ARTIFACT_A)?.["provider"]).toBe("supabase");
    expect(store.storageOf(ARTIFACT_B)?.["provider"]).toBe("supabase");
    expect(store.statements.some(statement => /^UPDATE/i.test(statement))).toBe(false);
  });

  it("resumes after a partial run and finishes the rest", async () => {
    seed();
    store.r2Objects.set(`${PROJECT}/${ARTIFACT_A}.json`, "someone else's bytes"); // A blocks
    await run("copy");
    expect(store.storageOf(ARTIFACT_A)?.["provider"]).toBe("supabase");
    expect(store.storageOf(ARTIFACT_B)?.["provider"]).toBe("r2");
    // The operator resolves the conflict; a re-run picks up only what is left.
    store.r2Objects.delete(`${PROJECT}/${ARTIFACT_A}.json`);
    const second = reportOf(await run("copy"), "artifact_blob_migration.copy");
    expect(second["movedCount"]).toBe(1);
    expect(store.storageOf(ARTIFACT_A)?.["provider"]).toBe("r2");
  });

  it("never deletes anything and never opens the old database", async () => {
    seed();
    await run("copy");
    expect(store.requests.some(request => request.method === "DELETE")).toBe(false);
    expect(store.legacyObjects.get(`${PROJECT}/${ARTIFACT_A}.json`)).toBe(bodyOf(ARTIFACT_A));
    expect(store.connections).toEqual([TARGET_DB]);
    expect(store.statements.some(statement => /^(DELETE|DROP|TRUNCATE|ALTER)/i.test(statement))).toBe(false);
  });
});

describe("verify", () => {
  it("reports MATCH when no legacy reference is left and every R2 object resolves", async () => {
    seed();
    await run("copy");
    const report = reportOf(await run("verify"), "artifact_blob_migration.verify");
    expect(report["result"]).toBe("MATCH");
    expect(report["legacyReferencesRemaining"]).toBe(0);
    expect(report["problemCount"]).toBe(0);
  });

  it("reports MISMATCH while a legacy reference remains", async () => {
    seed();
    const result = await run("verify");
    expect(reportOf(result, "artifact_blob_migration.verify")["result"]).toBe("MISMATCH");
    expect(result.exitCode).toBe(1);
  });

  it("reports MISMATCH when an R2 object is missing", async () => {
    seed();
    await run("copy");
    store.r2Objects.delete(`${PROJECT}/${ARTIFACT_A}.json`);
    const report = reportOf(await run("verify"), "artifact_blob_migration.verify");
    expect(report["result"]).toBe("MISMATCH");
    expect((report["verifiedProblems"] as Array<Record<string, unknown>>)[0]?.["problems"]).toEqual(["OBJECT_MISSING_IN_R2"]);
  });

  it("reports MISMATCH when an R2 body no longer matches its contentHash", async () => {
    seed();
    await run("copy");
    store.r2Objects.set(`${PROJECT}/${ARTIFACT_A}.json`, bodyOf("tampered"));
    const report = reportOf(await run("verify"), "artifact_blob_migration.verify");
    expect(report["result"]).toBe("MISMATCH");
    expect((report["verifiedProblems"] as Array<Record<string, unknown>>)[0]?.["problems"]).toContain("CONTENT_HASH_MISMATCH");
  });

  it("writes nothing", async () => {
    seed();
    await run("copy");
    const before = store.statements.length;
    await run("verify");
    expect(store.statements.slice(before).some(statement => /^(UPDATE|INSERT|DELETE)/i.test(statement))).toBe(false);
    expect(store.requests.filter(request => request.method !== "GET").every(request => request.url.includes("PUT") === false)).toBe(true);
  });
});

describe("the script itself", () => {
  it("declares nothing below the top-level await as a const, let or var", () => {
    // Everything after the module's top-level await is evaluated *during* that await, so any
    // top-level binding there is in its temporal dead zone when a mode calls it. This exact trap
    // has now bitten twice; it is cheaper to assert than to rediscover in a real run.
    const script = readFileSync(resolve(__dirname, "../../scripts/migrate-artifact-blobs-r2.ts"), "utf8").split(/\r?\n/);
    const topLevelAwait = script.findIndex(line => /^await target\.connect\(\)/.test(line));
    expect(topLevelAwait).toBeGreaterThan(-1);
    const deadZone = script
      .map((line, index) => ({ line: index + 1, text: line }))
      .filter(entry => entry.line > topLevelAwait + 1 && /^(const|let|var)\s+\w+/.test(entry.text));
    expect(deadZone.map(entry => `${entry.line}: ${entry.text.trim()}`)).toEqual([]);
  });

  it("reuses the existing adapters instead of re-implementing storage HTTP or signing", () => {
    const script = readFileSync(resolve(__dirname, "../../scripts/migrate-artifact-blobs-r2.ts"), "utf8");
    expect(script).toContain("import { R2ArtifactBlobStore }");
    expect(script).toContain("import { SupabaseStorageArtifactBlobStore }");
    expect(script).not.toMatch(/AWS4-HMAC-SHA256|crypto\.subtle|storage\/v1\/object/);
    // The legacy adapter exposes put and get; only get is ever called on it.
    expect(script).not.toMatch(/legacyStore\([^)]*\)\.put/);
    expect(script).not.toMatch(/\b(DELETE|delete)\s+FROM\b/);
  });

  it("never opens the old control-plane database", () => {
    // Comments may discuss it; the code may not read it.
    const code = readFileSync(resolve(__dirname, "../../scripts/migrate-artifact-blobs-r2.ts"), "utf8")
      .split(/\r?\n/).filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
    expect(code).not.toMatch(/SOURCE_DATABASE_URL/);
    expect(code).not.toMatch(/AUTOPILOT_CONTROL_DATABASE_URL/);
    // Exactly one connection, and it is the target.
    expect(code.match(/new Client\(/g) ?? []).toHaveLength(1);
    expect(code).toContain("new Client({ connectionString: targetUrl })");
  });
});

describe("workflow", () => {
  const parsed = () => {
    const text = readFileSync(resolve(__dirname, "../../.github/workflows/next-artifact-r2-migration.yml"), "utf8");
    const doc = parse(text) as Record<string, unknown>;
    const job = (doc["jobs"] as Record<string, Record<string, unknown>>)["blobs"] as Record<string, unknown>;
    const steps = job["steps"] as Array<Record<string, unknown>>;
    return { text, doc, job, steps, runs: steps.filter(step => step["run"]).map(step => String(step["run"])).join("\n") };
  };

  it("is manual-only with a per-mode confirmation", () => {
    const { doc, runs } = parsed();
    const on = (doc["on"] ?? doc[true as unknown as string]) as Record<string, unknown>;
    expect(Object.keys(on)).toEqual(["workflow_dispatch"]);
    expect(runs).toContain("inventory) expected=INSPECT_R2_MIGRATION");
    expect(runs).toContain("copy)      expected=MIGRATE_ARTIFACTS_TO_R2");
    expect(runs).toContain("verify)    expected=VERIFY_R2_MIGRATION");
    expect(doc["permissions"]).toEqual({ contents: "read" });
  });

  it("opens the next database only, and reads the legacy project through storage credentials", () => {
    const { job, steps } = parsed();
    const env = job["env"] as Record<string, string>;
    expect(env["TARGET_DATABASE_URL"]).toBe("${{ secrets.AUTOPILOT_NEXT_DATABASE_URL }}");
    expect(env["AUTOPILOT_LEGACY_SUPABASE_URL"]).toBe("${{ secrets.AUTOPILOT_SUPABASE_URL }}");
    expect(env["AUTOPILOT_LEGACY_SUPABASE_SERVICE_ROLE_KEY"]).toBe("${{ secrets.AUTOPILOT_SUPABASE_SERVICE_ROLE_KEY }}");
    // No env anywhere in the job names the old control-plane database, and there is no bare
    // DATABASE_URL for a schema migration to pick up.
    const envKeys = [...Object.keys(env), ...steps.flatMap(step => Object.keys((step["env"] ?? {}) as Record<string, string>))];
    const envValues = JSON.stringify([env, ...steps.map(step => step["env"] ?? {})]);
    expect(envKeys).not.toContain("SOURCE_DATABASE_URL");
    expect(envKeys).not.toContain("DATABASE_URL");
    expect(envValues).not.toContain("AUTOPILOT_CONTROL_DATABASE_URL");
    const checkout = steps.find(step => String(step["uses"] ?? "").startsWith("actions/checkout"));
    expect((checkout?.["with"] as Record<string, unknown> | undefined)?.["persist-credentials"]).toBe(false);
  });

  it("runs no state migration, schema migration, Supabase CLI or deploy", () => {
    const { runs, steps } = parsed();
    for (const forbidden of ["db:migrate", "state:migrate:next", "supabase secrets", "supabase functions", "git push"]) {
      expect(runs, `${forbidden} must not be executed`).not.toContain(forbidden);
    }
    expect(steps.filter(step => step["uses"]).map(step => step["uses"])).toEqual(["actions/checkout@v4", "pnpm/action-setup@v4", "actions/setup-node@v4"]);
    expect(runs).toContain("pnpm blobs:migrate:r2 -- --mode inventory");
    expect(runs).toContain("pnpm blobs:migrate:r2 -- --mode copy");
    expect(runs).toContain("pnpm blobs:migrate:r2 -- --mode verify");
  });
});
