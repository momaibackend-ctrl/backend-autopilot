# ADR 017: The API inventory is every contract in the repository

Status: accepted for v0.5.

## Context

ADR 016 made a collection run measure itself against the project's API contract. But "the contract" was one document: an OpenAPI file the caller passed inline, or the last `API_CONTRACT` artifact. Products split their API across files. A root `openapi.json` sits next to separate contracts for features such as check-in and onboarding, and path items often live in their own files behind `$ref`. With a single document as the denominator, "100% covered" could mean "100% of the one file somebody remembered". The rest of the API was outside the measurement, and nothing said so.

The caller also had to find and pass the contract. That is exactly the kind of manual step the autopilot exists to remove.

## Decision

The autopilot reads the repository itself, at one exact commit.

- `superadmin_repository_api_discovery` lists the tree of a registered GitHub repository at a resolved SHA. It opens every JSON/YAML candidate, classifies each by content, and merges all OpenAPI/Swagger documents into one inventory. Each operation keeps the `contract` that documents it, plus `alsoIn` for duplicates in other contracts.
- Path items split across files are followed through `$ref`, but only inside the repository. References that are absolute, use a URL scheme, or would climb above the repository root do not resolve.
- `superadmin_collection_run` and `superadmin_api_coverage` accept `contractRepository` and use this inventory. They report coverage per contract as well as in total, and the persisted report records the commit the inventory came from.
- `superadmin_collection_import` can read a collection straight from the repository.
- **A gap is never silent.** Any of the following is recorded as an inventory gap: an unparseable contract, an unresolved `$ref`, an oversized file, a candidate past the read budget, or a listing that GitHub truncated. Any gap keeps the collection verdict `NOT_PROVEN`. If the inventory may be missing operations, it cannot prove they were all covered.

The provider port gains an optional `listTree(repository, commitSha)`. The GitHub adapter implements it over `git/trees?recursive=1`. A runtime without it answers `NOT_SUPPORTED` rather than returning an empty inventory. Discovery authorizes the resource before the adapter sees it: it must be a project-owned `GITHUB_REPOSITORY`, non-production, with `READ` permission. The adapter only ever receives the registered owner/name and an exact SHA.

## Consequences

- Coverage now includes every contract the repository holds, and an incomplete contract set is visible as a gap rather than hidden.
- Existing behaviour is unchanged for single-document inventories. The inline and `API_CONTRACT` sources work as before, `byContract` appears only when operations carry provenance, and the new verdict reasons appear only for gaps or multi-contract inventories.
- This is stage 1 of making the autopilot run full HTTP verification without manual infrastructure. Stage 2 (ephemeral environments that build and start the application in GitHub Actions) uses this inventory, so that run has the right denominator from the start.
