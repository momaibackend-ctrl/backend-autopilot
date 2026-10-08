# ADR 016: Whole API collection coverage

Status: accepted for v0.5.

## Context

The executable HTTP runner (`superadmin_scenario_run`) proves that the scenarios somebody saved behave. It never knew how many operations the API has, so it could not tell a full end-to-end run from a smoke check. Reconciling a ported backend against its Postman collection exposed exactly that: the verified set was seven requests — health, version, auth and a 404 — and the original repository's collection was just as thin. Every request was green, the build was green, and nothing in the control plane could say that full parity had not been shown.

## Decision

A collection is judged against the project's own API contract, and only a run that covers the whole contract may claim to prove it.

- **Inventory.** The operations come from the project's OpenAPI/Swagger document, inline or from the latest `API_CONTRACT` artifact. No inventory means `NO_INVENTORY`, which never proves anything.
- **Import.** A project's whole Postman collection becomes saved scenarios (`superadmin_collection_import`). The deterministic subset of test scripts becomes assertions and extractions. Everything else is returned as `skipped` or `warnings` with a reason. Credentials follow the runner's existing rules, so the import adds no way in for secrets.
- **Run.** `superadmin_collection_run` executes every scenario of a resource in order, sharing one variable map the way a Postman runner does. Each scenario still goes through the single `HttpScenarioRunner`.
- **Verdict.** `PROVEN` requires both conditions: every scenario passed, and every documented operation was exercised by a *passing* request. A failing or skipped request counts as attempted, not as covered. The report's `result` is `PASS` only for `PROVEN`.
- **Drafts.** `superadmin_api_coverage` is read-only. It returns a runnable draft step for each uncovered operation. Drafts are never saved automatically: a request body and real sandbox identifiers are project knowledge the contract does not carry.

Everything is additive. `superadmin_scenario_run`, the scenario schema and its 20-step limit, the task READY gate and the VALIDATION_REPORT shape the Console reads are unchanged. The one runner change is an optional variable map parameter, and omitting it keeps the previous behaviour.

## Consequences

- An agent can no longer report "the Postman collection passes" for a smoke-only collection. The verdict says `NOT_PROVEN` and lists the operations that were not covered.
- Parity between two implementations of one contract means two `PROVEN` runs of the same collection, one against each implementation's registered resource.
- The collection run is bounded at 100 scenarios and 120 s per call. A larger collection runs in parts with `scenarioIds`, and the variables it needs must be extracted within each part.
- Not included yet: comparing two runs response by response, and a READY-gate requirement for a `PROVEN` collection. Both build on this report and can be added without changing it.
