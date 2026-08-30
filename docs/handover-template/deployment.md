# Deployment

> **Template.** Replace every `<…>` with a fact about this project.
>
> Where something is not set up, write `REQUIRES_OPERATOR_SETUP`. Do not describe a pipeline that
> does not exist.

## Pipeline

```text
push to <branch>  ──►  <CI: build + test>  ──►  <artifact>  ──►  <deploy to env>
```

| Stage | Where it runs | Status |
| --- | --- | --- |
| Build | `<CI system>` | `<status>` |
| Test | `<CI system>` | `<status>` |
| Publish artifact | `<registry>` | `<status>` |
| Deploy `<staging>` | `<platform>` | `REQUIRES_OPERATOR_SETUP` |
| Deploy `<production>` | `<platform>` | `<status>` |

## What triggers a deploy

`<e.g. a merge to the default branch deploys staging; production is a manual approval.>`

## Configuration per environment

Configuration reaches the application as `<mechanism>`. Secret **values** live in `<secret store>`
and are never committed. The names are inventoried in [infrastructure.md](./infrastructure.md).

## Migrations during deploy

`<When migrations run relative to the new version starting.>` Because migrations are written
backward compatible (see [database.md](./database.md)), the old and new versions can both be running
during a rollout.

## Verifying a deploy

```bash
curl -sS <health endpoint>
```

Expected: `<exact response>`. Then check `<dashboard/log query>` for `<what a healthy start looks
like>`.

## Rolling back

```bash
<rollback command>
```

Not reversible by a rollback: an applied migration, a published event, a sent notification. Know
which of those your change contains before you deploy it.

## On-call

| Question | Answer |
| --- | --- |
| Who is paged | `<rota, or REQUIRES_OPERATOR_SETUP>` |
| Where alerts go | `<channel>` |
| Runbook | `<link, or REQUIRES_OPERATOR_SETUP>` |
