# Troubleshooting

> **Template.** Replace every `<…>` with a fact about this project, and add the problems this team
> actually hits. Entries earn their place by having cost someone an afternoon.

## The build fails immediately after cloning

**Symptom:** `<exact error>`

**Cause:** Usually a JDK version mismatch.

**Fix:**
```bash
java -version          # must be <required version>
./gradlew --version    # uses the wrapper; do not install Gradle separately
```

## The application cannot reach the database

**Symptom:** `<exact error>`

**Cause:** The local containers are not running, or `.env` was never created.

**Fix:**
```bash
docker compose ps          # is postgres up and healthy?
docker compose up -d
cat .env                   # created from .env.example?
```

## Migrations fail with a checksum mismatch

**Symptom:** `<exact error>`

**Cause:** An already-applied migration file was edited. Its checksum is recorded, so every
environment that ran it now disagrees with the file.

**Fix:** Restore the original file and add a **new** migration for the change. Locally you can reset
instead:
```bash
docker compose down -v && docker compose up -d
<./gradlew flywayMigrate>
```

## Integration tests pass alone and fail together

**Cause:** A test depends on state another test left behind.

**Fix:** Make each test create and destroy its own data. See [testing.md](./testing.md).

## A test is flaky around midnight or across a DST boundary

**Cause:** Local-time arithmetic where an instant was meant.

**Fix:** Store instants in UTC and convert at the edge — see the localization and time section of
[architecture.md](./architecture.md). Add the failing date as a worked example.

## `<Add the next real one here>`

**Symptom:** `<…>`

**Cause:** `<…>`

**Fix:** `<…>`

## Getting unstuck

1. `<where the logs are>`
2. `<where the dashboards are>`
3. `<who to ask, or REQUIRES_OPERATOR_SETUP>`
