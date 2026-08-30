# Architecture

> **Template.** Replace every `<…>` with a fact about this project.

## Module map

```text
<module>            <one line: what it is responsible for>
  ├── <submodule>   <…>
  └── <submodule>   <…>
```

## Ownership

Ownership is the rule that keeps this codebase from growing a second answer to the same question.

| Module | Owns (source of truth for) | Owner |
| --- | --- | --- |
| `<module>` | `<the data/decisions only this module may write>` | `<team or role>` |

Two rules follow from the table, and they are not negotiable:

1. **One source of truth per fact.** If a module needs data another module owns, it reads it through
   that module's public contract. It does not keep its own copy, and it does not write to the other
   module's tables.
2. **Ownership is about writes.** Several modules may read a fact. Exactly one may decide it.

## Core contracts

`<Where the shared contracts live, and what belongs in them.>` See
[contracts.md](./contracts.md).

## Dependency direction

```text
<inbound adapters>  ──►  <application>  ──►  <domain>
                              │
                              └──►  <ports>  ◄──  <outbound adapters>
```

Dependencies point inward. The domain imports no framework and no provider type. `<State the
enforcement: an ArchUnit rule, a Gradle module boundary, a lint rule — and where it lives.>`

## Persistence boundary

`<Which layer may touch the database, and through what.>` Nothing outside it constructs a query.

## Timeline / outbox

`<How state changes become events, and what guarantees the outbox gives — at-least-once, ordering,
retry, dead-letter handling.>`

## Flow engine

`<What orchestrates multi-step processes, and where a step's state lives.>`

## Context

`<What "context" means in this system, how it is assembled, and its trust level.>`

## Privacy

`<Which data is personal, where it may be stored, how long it is retained, and how deletion
propagates.>`

## Safety

`<The checks that must not be bypassed, and what happens when one fails.>`

## AI gateway

`<If the product calls a model: the single boundary it goes through, the timeout, and the
fallback.>` If this project has none: `NOT_APPLICABLE`.

## Localization and time

`<Which timezone the system stores in, which it renders in, and where the conversion happens.>`
Store instants in UTC; convert at the edge. `<State the project's rule explicitly.>`

## Observability

`<Log format, correlation ID propagation, metrics, and where they can be read.>`

## Configuration and feature flags

`<How configuration reaches the application, and how a flag is added, read and removed.>`

## Forbidden bypass paths

These exist because someone will otherwise find them under deadline pressure:

- `<e.g. writing to another module's tables directly>`
- `<e.g. calling an outbound adapter from the domain>`
- `<e.g. skipping the contract module for a "quick" cross-module call>`
- `<e.g. reading a secret from anywhere but the configured provider>`
