# Contracts

> **Template.** Replace every `<…>` with a fact about this project.

A contract is the only supported way one part of this system talks to another, or to the outside
world. Everything else is an implementation detail that may change without notice.

## Where they live

| Contract kind | Location | Format |
| --- | --- | --- |
| HTTP API | `<path>` | `<e.g. OpenAPI>` |
| Events | `<path>` | `<e.g. JSON Schema>` |
| Cross-module interfaces | `<path>` | `<language types>` |

## Inbound HTTP API

`<Base path, authentication scheme, error envelope, pagination convention.>`

Regenerate or validate the published contract with:

```bash
<./gradlew openApiGenerate>
```

## Events

| Event | Producer | Consumers | Delivery guarantee |
| --- | --- | --- | --- |
| `<event>` | `<module>` | `<modules/services>` | `<at-least-once / exactly-once>` |

Consumers must be idempotent wherever delivery is at-least-once. See the idempotency row in
[testing.md](./testing.md) for what that costs in tests.

## Cross-module interfaces

Modules call each other only through these. A direct call into another module's internals, or a
write to another module's tables, is a bypass path — [architecture.md](./architecture.md) lists the
forbidden ones.

## Changing a contract

1. Decide whether the change is **additive** (a new optional field, a new event) or **breaking**
   (removing or renaming a field, tightening a type, changing a status code).
2. Additive changes ship normally, with `CONTRACT` tests.
3. Breaking changes need a rollout plan: expand, migrate consumers, then contract. `<State the
   project's deprecation window.>`
4. Every contract change needs `CONTRACT` tests, and a cross-module change needs `INTEGRATION` tests
   as well.

## Who consumes this

| Consumer | Owner | Contact | Notified how |
| --- | --- | --- | --- |
| `<consumer>` | `<team>` | `<channel>` | `<how a breaking change reaches them>` |

If this table is empty because nobody has checked, write `UNVERIFIED` rather than leaving it
looking complete.
