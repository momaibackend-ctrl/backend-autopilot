# Testing

> **Template.** Replace every `<…>` with a fact about this project.

## Commands

```bash
<./gradlew test>               # unit
<./gradlew integrationTest>    # integration, needs docker compose up -d
<./gradlew check>              # everything the pipeline runs
```

## Which layers a change needs

This is the accumulated verification philosophy of this codebase, stated so a human can apply it
without asking anyone.

| What you changed | Layers required |
| --- | --- |
| A domain rule | `UNIT` + `REGRESSION` |
| A state machine | `UNIT` + `INVARIANT`, and `PROPERTY` where an algorithmic invariant exists |
| Timezone / time handling | Worked examples, and `PROPERTY` where an invariant exists |
| A database adapter | `INTEGRATION` |
| A migration | `MIGRATION` + repository tests |
| A contract | `CONTRACT` |
| Authorization | `SECURITY` |
| Idempotency / replay | Replay, property, or concurrency tests |
| A cross-module change | `CONTRACT` + `INTEGRATION` |

**Property testing is not required for every task.** It is required where an *algorithmic
invariant* genuinely exists — state machines, time and DST arithmetic, numeric logic, deterministic
hashing or bucketing, idempotency, parsers, ordering, bounds, complex transformations. Where none
exists, say so in the pull request rather than adding a generative test that asserts nothing.

## What a green build does and does not prove

A passing suite proves the assertions that ran, passed. It does not prove that any assertion
covered the change. When a layer above is required, the pull request should be able to point at the
test that covers it.

## Test data

`<Where fixtures live, and the rule for adding one.>` Never use production data, and never commit a
real credential to a fixture.

## Integration environment

Integration tests run against the throwaway PostgreSQL/Redis/object storage from
[local-development.md](./local-development.md). They must be able to create and destroy their own
state — a test that depends on a row someone left behind is a flaky test.

```bash
docker compose up -d
<./gradlew integrationTest>
docker compose down -v
```

## Before opening a pull request

```bash
<./gradlew check>
```

`<State what the CI pipeline runs, so a developer can reproduce it locally in one command.>`
