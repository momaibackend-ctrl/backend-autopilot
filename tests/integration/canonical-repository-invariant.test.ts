import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresStateStore } from "../../packages/project-registry/src/postgres-store.js";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";
import type { StateStore } from "../../packages/core/src/ports.js";
import type { CanonicalDevelopmentRepository, Project, Resource } from "../../packages/schemas/src/index.js";

// Same disposable-database rule the other PostgreSQL test uses: throwaway rows never go anywhere
// but a local database.
const candidate = process.env["TEST_DATABASE_URL"] ?? (process.env["CI"] ? process.env["DATABASE_URL"] : undefined);
const disposable = candidate !== undefined && /(localhost|127\.0\.0\.1|::1)/.test(candidate);
const url = disposable ? candidate : undefined;

const now = () => new Date().toISOString();
const sha = (seed: string) => seed.padEnd(40, "0").slice(0, 40).replace(/[^0-9a-f]/g, "a");

async function seed(store: StateStore) {
  const timestamp = now();
  const project: Project = { id: crypto.randomUUID(), name: "Invariant", slug: `inv-${crypto.randomUUID()}`, sourceType: "LOCAL", environment: "SANDBOX", autonomyMode: "GUARDED", status: "ACTIVE", workspacePath: "", createdAt: timestamp, updatedAt: timestamp };
  await store.createProject(project);
  const resources: Resource[] = [];
  for (const reference of ["momai/one", "momai/two"]) {
    const resource: Resource = { resourceId: crypto.randomUUID(), type: "GITHUB_REPOSITORY", provider: "github", externalReference: `${reference}-${project.slug}`, projectId: project.id, environment: "SANDBOX", permissions: ["READ", "WRITE"], status: "ACTIVE", secretRefs: [], createdAt: timestamp };
    await store.createResource(resource);
    resources.push(resource);
  }
  return { project, resources };
}

function binding(project: Project, resource: Resource, version: number, operationId: string): CanonicalDevelopmentRepository {
  const timestamp = now();
  const [owner = "", name = ""] = resource.externalReference.split("/");
  return {
    id: crypto.randomUUID(),
    projectId: project.id,
    resourceId: resource.resourceId,
    repositoryIdentity: { provider: "github", owner, name, externalReference: resource.externalReference },
    defaultBranch: "main",
    canonicalSinceSha: sha(`c${version}`),
    canonicalSinceAt: timestamp,
    status: "ACTIVE",
    version,
    createdBy: "invariant-test",
    operationId,
    reason: "Durable invariant test",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * The uniqueness guarantee is asserted against BOTH stores with the same assertions. The in-memory
 * store is the reference semantics the unit tests run on; PostgreSQL is where the guarantee has to
 * hold under real concurrency, and a partial unique index -- not an application read/check/write --
 * is what makes that true. Keeping one test body over both is what stops them drifting apart.
 */
function assertsUniqueness(name: string, create: () => Promise<StateStore>, cleanup?: (store: StateStore) => Promise<void>) {
  describe(`one ACTIVE canonical repository per project (${name})`, () => {
    it("rejects a second ACTIVE binding created without an optimistic lock", async () => {
      const store = await create();
      const { project, resources } = await seed(store);
      await store.promoteCanonicalRepository({ projectId: project.id, record: binding(project, resources[0]!, 1, `op-first-${project.slug}`), displacedStatus: "SUPERSEDED", displacedAt: now() });
      await expect(
        store.promoteCanonicalRepository({ projectId: project.id, record: binding(project, resources[1]!, 2, `op-second-${project.slug}`), displacedStatus: "SUPERSEDED", displacedAt: now() }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect((await store.listCanonicalRepositories(project.id)).filter((value) => value.status === "ACTIVE")).toHaveLength(1);
      await cleanup?.(store);
    });

    it("rejects a replacement that names a stale expected version", async () => {
      const store = await create();
      const { project, resources } = await seed(store);
      const first = binding(project, resources[0]!, 1, `op-stale-first-${project.slug}`);
      await store.promoteCanonicalRepository({ projectId: project.id, record: first, displacedStatus: "SUPERSEDED", displacedAt: now() });
      await expect(
        store.promoteCanonicalRepository({ projectId: project.id, record: binding(project, resources[1]!, 2, `op-stale-second-${project.slug}`), expectedCurrent: { id: first.id, version: 99 }, displacedStatus: "SUPERSEDED", displacedAt: now() }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await cleanup?.(store);
    });

    it("supersedes the previous binding in the same atomic step as it activates the new one", async () => {
      const store = await create();
      const { project, resources } = await seed(store);
      const first = binding(project, resources[0]!, 1, `op-swap-first-${project.slug}`);
      await store.promoteCanonicalRepository({ projectId: project.id, record: first, displacedStatus: "SUPERSEDED", displacedAt: now() });
      const second = binding(project, resources[1]!, 2, `op-swap-second-${project.slug}`);
      const result = await store.promoteCanonicalRepository({ projectId: project.id, record: second, expectedCurrent: { id: first.id, version: 1 }, displacedStatus: "SUPERSEDED", displacedAt: now() });

      expect(result.displaced?.status).toBe("SUPERSEDED");
      expect(result.displaced?.supersededBy).toBe(second.id);
      expect((await store.getActiveCanonicalRepository(project.id))?.id).toBe(second.id);
      // History survives the replacement; nothing is deleted.
      expect(await store.listCanonicalRepositories(project.id)).toHaveLength(2);
      await cleanup?.(store);
    });

    it("lets exactly one of several concurrent first promotions win", async () => {
      const store = await create();
      const { project, resources } = await seed(store);
      const attempts = [0, 1, 0, 1].map((index, attempt) =>
        store.promoteCanonicalRepository({ projectId: project.id, record: binding(project, resources[index]!, 1, `op-race-${attempt}-${project.slug}`), displacedStatus: "SUPERSEDED", displacedAt: now() }),
      );
      const results = await Promise.allSettled(attempts);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect((await store.listCanonicalRepositories(project.id)).filter((value) => value.status === "ACTIVE")).toHaveLength(1);
      await cleanup?.(store);
    });
  });
}

assertsUniqueness("in-memory", async () => new MemoryStateStore());

describe.skipIf(!url)("PostgreSQL durable canonical invariant", () => {
  assertsUniqueness(
    "postgresql",
    async () => {
      const pool = new Pool({ connectionString: url as string });
      for (const migration of ["0001_initial.sql", "0006_canonical_repository.sql"])
        await pool.query(await readFile(`packages/project-registry/migrations/${migration}`, "utf8"));
      await pool.end();
      return new PostgresStateStore(url as string);
    },
    async (store) => { await (store as PostgresStateStore).close(); },
  );

  it("holds the invariant at the database level, not only in application code", async () => {
    const pool = new Pool({ connectionString: url as string });
    try {
      for (const migration of ["0001_initial.sql", "0006_canonical_repository.sql"])
        await pool.query(await readFile(`packages/project-registry/migrations/${migration}`, "utf8"));
      const store = new PostgresStateStore(url as string);
      const { project, resources } = await seed(store);
      const first = binding(project, resources[0]!, 1, `op-raw-${project.slug}`);
      await store.promoteCanonicalRepository({ projectId: project.id, record: first, displacedStatus: "SUPERSEDED", displacedAt: now() });
      // A raw INSERT bypassing every line of application code must still be refused.
      const second = binding(project, resources[1]!, 2, `op-raw-second-${project.slug}`);
      await expect(
        pool.query(
          "insert into canonical_development_repositories(id,project_id,resource_id,status,version,operation_id,data,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [second.id, second.projectId, second.resourceId, "ACTIVE", second.version, second.operationId, second, second.createdAt, second.updatedAt],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await store.close();
    } finally {
      await pool.end();
    }
  });
});
