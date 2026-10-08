# Ephemeral verification environments

The autopilot builds the commit under test, starts its dependencies and the application in a throwaway environment, verifies it over real HTTP, and destroys the environment afterwards. No test server has to exist, and nobody has to supply an address. Design: [ADR 018](adr/018-ephemeral-verification-environments.md).

This page covers the **environment plan**: how the autopilot decides to build and start a project. The harness that executes the plan, and the job that records its evidence, follow in the next parts.

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
| Node | `package.json` | `npm ci` / `pnpm install --frozen-lockfile` / `yarn install --frozen-lockfile`; `run build`; `run start` or `node <main>` | 3000 |
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
