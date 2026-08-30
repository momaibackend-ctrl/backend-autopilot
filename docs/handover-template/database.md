# Database

> **Template.** Replace every `<…>` with a fact about this project.

## Engine and schema

| Fact | Value |
| --- | --- |
| Engine | `<e.g. PostgreSQL 16>` |
| Schema | `<schema name>` |
| Migration tool | `<e.g. Flyway>` |
| Migration location | `<path in this repository>` |

## Apply migrations locally

```bash
docker compose up -d postgres
<./gradlew flywayMigrate>
```

Verify what is applied:

```bash
<./gradlew flywayInfo>
```

## Add a migration

1. Create `<path>/V<next>__<short_description>.sql`. Never renumber or edit an applied migration —
   its checksum is recorded, and changing it breaks every environment that already ran it.
2. Write it **backward compatible**: the currently deployed application must keep working against
   the new schema. Expand, deploy, then contract in a later change.
3. Adding a `NOT NULL` column needs a default or a backfill; dropping a column needs the reading
   code gone first.
4. Add or update the repository tests that cover the change — see [testing.md](./testing.md).
5. Say in the pull request whether the migration is reversible, and how.

## Destructive changes

`<The project's rule.>` A dropped column or table is not recoverable by rolling back the
application; treat it as a separate, deliberate change with its own review.

## Seed and test data

`<Where seed data lives, and how integration tests get a clean database.>` Tests create and destroy
their own state; never depend on a row someone left behind.

## Backups

| Environment | Backup | Restore procedure | Status |
| --- | --- | --- | --- |
| Local | None needed — throwaway containers | `docker compose down -v`, then re-migrate | `NOT_APPLICABLE` |
| `<staging>` | `<policy>` | `<procedure>` | `REQUIRES_OPERATOR_SETUP` |
| `<production>` | `<policy>` | `<procedure>` | `<status>` |

## Connecting

Local connection details come from `.env`, which you copied from `.env.example`. No shared
credential is needed to develop against this project.
