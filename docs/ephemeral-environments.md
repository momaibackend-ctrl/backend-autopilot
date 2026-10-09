# Ephemeral verification environments

The autopilot builds the commit under test, starts its dependencies and the application in a throwaway environment, verifies it over real HTTP, and destroys the environment afterwards. No test server has to exist, and nobody has to supply an address. Design: [ADR 018](adr/018-ephemeral-verification-environments.md).

This page covers the **environment plan** (how the autopilot decides to build and start a project) and the **executor** (how it runs that plan). The durable job that ties them to a task and records the evidence follows in the next part.

## Preview a plan

```jsonc
superadmin_environment_plan({
  "projectId": "…",
  "resourceId": "…",       // a registered GITHUB_REPOSITORY resource
  "ref": "java-port",      // branch, tag or exact SHA; default branch when omitted
  "root": "services/api"   // only for a repository holding several applications
})
// -> { commitSha, executable, plan: { stack, image, install, build, prepare, run, port,
//      health, startupTimeoutSeconds, env, dependencies, source, evidence, notes, unresolved } }
```

`executable: false` means the plan has `unresolved` entries. Each entry says what is missing and how to supply it. Such a plan is never run.

## What is inferred

| Stack | Detected by | Build / run | Default port, health |
|---|---|---|---|
| Kotlin/Java + Gradle | `build.gradle(.kts)`, `settings.gradle(.kts)` | `./gradlew assemble -x test`; `bootRun` (Spring Boot), `quarkusRun`, `run` (application plugin) | 8080; `/actuator/health` for Spring |
| Kotlin/Java + Maven | `pom.xml` | `mvn -B -DskipTests package`; `spring-boot:run`, `quarkus:run`, `mn:run` | 8080 |
| Node | `package.json` | `npm ci` / `corepack pnpm install --frozen-lockfile` / `corepack yarn install --frozen-lockfile`; `run build`; `run start` or `node <main>` | 3000 |
| Python | `pyproject.toml`, `requirements.txt`, `manage.py` | `pip install`; Django `runserver`, FastAPI via `uvicorn module:app`, Flask via `flask --app` | 8000 |
| Go | `go.mod` | `go build` of `.` or the single `cmd/*`; run the binary | 8080 |

Runtime versions are read from the project itself: the Java toolchain or compiler settings, `engines.node` or `.nvmrc`, `requires-python`, `go.mod`. A Gradle or Maven wrapper is used when it is committed.

Migrations are applied the way the project applies them:
- Flyway and Liquibase run at application start;
- Prisma: `prisma migrate deploy`;
- Django: `migrate`;
- Alembic: `upgrade head`.

**Dependencies.** PostgreSQL, MySQL, Redis and MongoDB are detected from the build and configuration files. They are started as containers, using the image version from the project's `docker-compose` file when there is one. The application receives the conventional variables for its framework:
- `SPRING_DATASOURCE_*`, `SPRING_DATA_REDIS_*`;
- `DATABASE_URL`, `JDBC_DATABASE_URL`;
- `PG*`, `DB_*`, `REDIS_URL`, `MONGODB_URI`.

Credentials appear only as templates (`{{postgres.password}}`), filled per run with throwaway values. Kafka, RabbitMQ and Elasticsearch are detected and noted, but not yet provisioned.

## `.autopilot/environment.yml`

Every field is optional, and every field overrides inference:

```yaml
version: 1
root: services/api                  # application directory inside the repository
image: eclipse-temurin:21-jdk
install: [["./gradlew", "--no-daemon", "dependencies"]]
build:   [["./gradlew", "--no-daemon", ":api:assemble", "-x", "test"]]
prepare: [["./gradlew", "--no-daemon", ":api:flywayMigrate"]]
run: ["./gradlew", "--no-daemon", ":api:bootRun"]
port: 8080
health: ["/actuator/health"]
startupTimeoutSeconds: 300
env:
  SPRING_PROFILES_ACTIVE: test
dependencies:
  - kind: POSTGRES
    image: postgres:16-alpine
    env:
      APP_DB_URL: "jdbc:postgresql://{{postgres.host}}:{{postgres.port}}/{{postgres.database}}"
      APP_DB_PASSWORD: "{{postgres.password}}"
```

The manifest is validated strictly:
- commands are argv lists, never shell strings;
- unknown fields are rejected;
- `root` cannot leave the repository;
- a secret-like variable must reference a generated credential such as `{{postgres.password}}`, never a literal value.

An invalid manifest is reported in `unresolved` and none of it is applied.

## Executing a plan

`packages/ephemeral-environment/src/executor.ts` runs one plan from start to finish and always
tears the environment down:

1. **Dependencies.** Each dependency container starts on a private network with a password
   generated for this run, and must pass its readiness probe (`pg_isready`, `mysqladmin ping`,
   `redis-cli ping`, `mongosh ping`).
2. **Install, build and prepare.** These run in containers that share only the mounted workspace
   and a package-cache volume, so later steps reuse earlier downloads.
3. **Start.** The application starts with the resolved environment and is published on loopback
   only (`127.0.0.1:18080`).
4. **Health.** The health probes are polled until one answers below 500. A 401 or 404 means the
   server is up.
5. **Collection.** The collection runs through the same runner, policy and redaction as in the
   control plane. Coverage is measured against the project's inventory.

Containers are driven through the Docker CLI under the `ENVIRONMENT` command category.
CommandPolicy refuses anything that reaches the host: `--privileged`, host namespaces,
`--network host`, added capabilities, devices, the Docker socket, and binds of `/` or host system
directories. Environment variables are passed as `-e NAME`, so a generated password never appears
in argv. Every log tail that leaves the environment is bounded and scrubbed of those passwords.

Every failure is classified, so the next step is a diagnosis of a named cause:

| Class | Meaning |
|---|---|
| `PLAN_UNRESOLVED` | the plan has `unresolved` entries, or the environment references a dependency that is not provisioned |
| `INFRASTRUCTURE_UNAVAILABLE` | no container runtime |
| `DEPENDENCY_UNAVAILABLE` | a dependency container did not start or never became ready |
| `BUILD_FAILED` | an install or build step exited non-zero (its output is attached) |
| `ENVIRONMENT_BOOT_FAILED` | a prepare step (migration, seed) failed, or the application exited before answering HTTP |
| `HEALTH_CHECK_FAILED` | the application kept running but no probe answered below 500 in time |
| `NO_SCENARIOS` | nothing to send; the application is not even built |
| `SCENARIO_FAILED` | a scenario did not pass |
| `COVERAGE_INCOMPLETE` | every request passed, but documented operations have no passing request |
| `CONTRACT_GAP` | the inventory itself is incomplete |

Each of them produces `NOT_PROVEN`.

`scripts/run-ephemeral-environment.ts` is the environment job's entry point. It plans a
checked-out project, discovers its contracts and Postman collections (or takes explicit
`--openapi`/`--collection` files), runs the executor and writes the evidence JSON.

The **self-test** workflow (`autopilot-environment-selftest.yml`) runs this on real Docker for
every change to the environment code, with no secrets:

* a Node service that needs PostgreSQL must be `PROVEN`;
* the Kotlin/Ktor sandbox must be `PROVEN`;
* the same Node service with a smoke-only collection must be `NOT_PROVEN`.

It also asserts that no container is left behind.
