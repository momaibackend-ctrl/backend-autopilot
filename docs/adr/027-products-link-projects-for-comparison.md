# ADR 027: Products link projects for read-only comparison

Status: accepted for v0.5. Owner decision. Amends AGENTS.md rule 1 and ADR 026.

## Context

Momna's repositories live in two control-plane projects.

- **The AICorn project** holds the working Kotlin service, `AICorn-Rocket-Group/momna-backend`. It is that project's canonical repository and carries 16 tasks and 42 jobs of history.
- **The development project** holds the sandbox, `momaibackend-ctrl/momna-backend` (canonical there), and the Java candidate. The Java parity task and its 24 jobs live here.

The Java candidate must be compared with the working Kotlin service. ADR 026 required a mission's reference to belong to the mission's own project. Getting there would have meant moving a registration between projects, or merging the projects, and neither is safe:

- **Moving the AICorn registration** would leave the AICorn project's history and its canonical binding pointing at a repository it no longer owns.
- **Merging the projects** is impossible without rewriting history. Both projects have an ACTIVE canonical repository, and both have tasks with the same keys.

## Decision

**Projects are linked, not merged.** A project can carry a `product`: a lower-case name shared by every project of one product. `superadmin_project_product_set` sets it or clears it. It writes only the project document, so linking and unlinking are safe and reversible, and every record stays where it is.

**What a link allows: comparison, read-only.**

- A PARITY mission may name as its reference a GitHub repository of another project of the same product.
- `superadmin_http_e2e_run` may name such a repository as its `counterpart`. It is cloned at one commit and run in a throwaway environment, exactly as a same-project reference.
- The owner project's policy still has to allow that: PolicyEngine `PROVISION` with `READ` is evaluated against the owner project. A reference therefore never reaches further than its owner allows.

**What a link never allows: writes.**

- A mission's target must be the project's own repository.
- Change sets, pull requests, merges and every other write stay inside each repository's own project, and are refused across the boundary as before.

**Pinned reference.** A PARITY goal may carry `referenceRef`: a branch, tag or commit. Only comparison runs made against exactly that pin count. This is needed for the planned replacement. Once the candidate has proven parity, it moves into the working repository in place of Kotlin; the last Kotlin commit is first tagged in that repository (`kotlin-final`, the owner's choice); the mission is then pinned to that tag. Without the pin, the mission would end up comparing the candidate with itself.

**The brief shows the product.** It adds `productRepositories`: the repositories of the other projects of the product, with their roles, purposes and the missions they serve. A session sees the whole product without guessing which project to open.

**Role rename.** The `PORT` role of ADR 026 is renamed `CANDIDATE`: the next version of WORKING, built until it is proven to match a reference, then moved into WORKING in its place. No repository carried `PORT` when it was renamed.

`ARCHIVE` is refused while a mission in **any** project still uses the repository. A reference in one project cannot be archived out from under a mission in another.

## Consequences

- Momna's development project and the AICorn project become one product, with no record moved:
  - AICorn is WORKING;
  - the sandbox is SANDBOX;
  - Java is CANDIDATE.

  A PARITY mission in the development project compares the Java candidate with the working Kotlin service.
- Replacing Kotlin with Java in the working repository is a later, separate step. It needs proven parity, an explicit owner confirmation, and the `kotlin-final` tag created first.
