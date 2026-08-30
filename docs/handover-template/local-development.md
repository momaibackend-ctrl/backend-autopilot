# Local development

> **Template.** Replace every `<…>` with a fact about this project. Delete nothing structural.
>
> **This document must never require Backend Autopilot.** No MCP client, no `superadmin_*` tool, no
> Superadmin token. A developer with a laptop, a Git client and a JDK is the reader. The handover
> gate fails this file if it says otherwise.

## Prerequisites

| Tool | Version | How to check |
| --- | --- | --- |
| JDK | `<e.g. Temurin 21>` | `java -version` |
| Kotlin | `<version, or "supplied by the Gradle plugin">` | `./gradlew -q kotlinVersion` |
| Gradle | `<supplied by the wrapper — do not install separately>` | `./gradlew --version` |
| Docker | `<version>` — for local PostgreSQL/Redis/object storage | `docker --version` |
| Git | any recent | `git --version` |

## Clone

```bash
git clone git@github.com:<owner>/<repository>.git
cd <repository>
```

Use a repository-relative path from here on. Never paste a path from your own machine into shared
documentation — it is an instruction nobody else can follow, and the handover gate rejects it.

## Configure

```bash
cp .env.example .env
```

`.env` is git-ignored and holds **your** local values. `.env.example` lists the variable names with
placeholder values and is committed. Never commit a real credential to either.

| Variable | Purpose | Local value |
| --- | --- | --- |
| `<DATABASE_URL>` | `<primary datastore>` | `<from docker compose, below>` |
| `<REDIS_URL>` | `<cache/queue>` | `<from docker compose, below>` |
| `<S3_ENDPOINT>` / `<S3_BUCKET>` | `<object storage>` | `<from docker compose, below>` |

## Bring up the local services

```bash
docker compose up -d
docker compose ps
```

This starts throwaway PostgreSQL, Redis and object storage on localhost. They hold no real data and
can be destroyed and recreated at any time:

```bash
docker compose down -v
```

## Apply migrations

```bash
<./gradlew flywayMigrate>
```

See [database.md](./database.md) for what the migrations are and how to add one.

## Run

```bash
<./gradlew bootRun>
```

## Check it is alive

```bash
curl -sS http://localhost:<port>/<health path>
```

Expected: `<the exact response, e.g. {"status":"UP"}>`

## Build and test

```bash
<./gradlew build>
<./gradlew test>
```

See [testing.md](./testing.md) for which test layers a given change needs.

## Make a small change end to end

1. `git switch -c <your-initials>/<short-description>`
2. Make the change. [change-guide.md](./change-guide.md) says how to find the right module first.
3. Run the test layers the change calls for.
4. `git commit`, `git push -u origin <branch>`
5. Open a pull request against `<default branch>` the ordinary way.

That is the whole loop. Backend Autopilot contributes to this repository through the same loop; it
is not a step in yours.
