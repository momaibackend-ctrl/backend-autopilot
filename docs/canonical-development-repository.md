# Canonical Development Repository, repository export, and human handover

Stage II gives a project one durable answer to the question *"where does this product get built
from now on?"* — and makes that answer a piece of recorded state rather than a convention.

## The idea in one paragraph

A **Canonical Development Repository** is a *role* a registered repository plays for a project. It
is not a name, not a hosting choice, and not a claim that anything is production. Assigning that
role is **promotion**. Moving Git history somewhere else is **export**. They are different
operations, published under different names, and a successful export never makes its target
canonical on its own.

```text
project
  └── CanonicalDevelopmentRepository (role, versioned, append-only)
        └── registered GITHUB_REPOSITORY resource   ← "what may Autopilot touch at all?"
              └── default branch
                    └── exact base SHA             ← what execution actually pins
```

There is exactly one repository registry. The resource registry answers *what may Autopilot touch*;
the canonical binding answers *which of those is this project's single source of further
development*. Nothing here introduces a second registry, and nothing here stores an owner/name or
URL that could drift away from the resource it claims to describe.

## Invariants

| Invariant | Where it is enforced |
| --- | --- |
| At most one `ACTIVE` canonical repository per project | Partial unique index `canonical_repo_one_active_uq` on `(project_id) WHERE status='ACTIVE'`, plus a `FOR UPDATE` row lock inside `promote_canonical_repository()` |
| One logical promotion never creates two bindings | `admin_operations` replay protection **and** a unique index on `operation_id` |
| A plan that went stale cannot be acted on | `expectedHeadSha` + `expectedCurrentCanonicalVersion` re-checked against freshly read state |
| History is never destroyed | Replaced bindings become `SUPERSEDED` / `ROLLED_BACK`; no delete path exists |
| Secrets never travel with an export | The handover artifact is built from reference *names*; no parameter accepts a value |

The uniqueness invariant is deliberately **not** an application-level read/check/write. Two
concurrent promotions racing through application code would both read "no ACTIVE binding" and both
write one; the database index is what makes that impossible.

## States

```text
CANDIDATE ──► ACTIVE ──► SUPERSEDED     (replaced by a later promotion)
                    └──► ROLLED_BACK    (undone by a metadata rollback)
```

`version` is monotonic per project and is the optimistic-locking token. A project with no binding
at all is a normal, supported state — it is what every project looked like before Stage II, and
those projects keep working unchanged.

## How work resolves a repository

```text
task already executed?  ──yes──►  its pinned repository (always wins)
        │no
project has ACTIVE canonical binding?
        │yes ──► the canonical resource; a supplied resourceId may only CONFIRM it
        │no  ──► the caller names a registered resource, exactly as before
```

Three consequences worth stating explicitly:

- **A promotion never retargets work already under way.** A half-finished task's branch and verified
  commit live in the repository it started in; moving it would strand both.
- **A caller cannot route around the binding.** Once a project is canonical-bound, a different
  `resourceId` is a `CANONICAL_TARGET_REQUIRED` policy violation, not an override.
- **Canonical does not mean floating.** The binding says *where the base comes from*; execution
  still resolves the default branch to an exact commit and persists it on the job. Nothing ever
  runs against "whatever `main` is right now".

## Operations

| Operation | Kind | Tool | Control API |
| --- | --- | --- | --- |
| Read binding + history | read | `superadmin_canonical_repository_get` | `GET /v1/projects/{id}/canonical-repository` |
| Promotion dry run | read | `superadmin_canonical_repository_plan` | `POST /v1/projects/{id}/canonical-repository/plan` |
| Promotion | mutation | `superadmin_canonical_repository_promote` | `POST /v1/projects/{id}/canonical-repository/promote` |
| Metadata rollback | mutation | `superadmin_canonical_repository_rollback` | `POST /v1/projects/{id}/canonical-repository/rollback` |
| Export dry run | read | `superadmin_repository_export_plan` | `POST /v1/projects/{id}/repository-export/plan` |
| Export | mutation | `superadmin_repository_export` | `POST /v1/projects/{id}/repository-export` |
| Export verification | mutation | `superadmin_repository_export_verify` | `POST /v1/projects/{id}/repository-export/verify` |
| Handover readiness | read (persists with `operationId`) | `superadmin_developer_handover_report` | `GET|POST /v1/projects/{id}/developer-handover` |

Every one of these is a thin publication of `CanonicalRepositoryService`. There is no second
implementation behind any of them, so no surface can disagree with another about a gate.

## Terminal artifacts

`CANONICAL_REPOSITORY_REPORT`, `REPOSITORY_EXPORT_REPORT`, `REPOSITORY_EXPORT_VERIFICATION`,
`SECRET_CONFIG_HANDOVER`, `DEVELOPER_HANDOVER_REPORT` — all written through the existing
`ArtifactStore`, alongside every other piece of evidence. No parallel evidence system was created.

Each mutation also writes one `mcp.<tool>` audit event and one domain audit event carrying
`projectId`, `operationId`, actor, source/target resource and repository, source/target SHA,
default branch, previous and new canonical binding, result and timestamp — and no credentials.

## What promotion does *not* do

It does not copy Git, create a repository, rename one, change organization, force-push, rewrite
history, delete a branch or tag, move a secret, or touch production. Rollback restores the previous
*binding* only; it is metadata, and there is no code path in it that reaches a repository.

## Repository export

Export moves Git as an engineering object — commit graph, branches, tags — never as a ZIP. The
mirror itself runs in the fixed control-repository workflow
(`.github/workflows/autopilot-repository-export.yml`), because the control plane has no subprocess
and must not gain one. The workflow re-validates every repository identity as `owner/name`, refuses
a target that already holds refs (the only alternative would be force-pushing over someone's
history), and pushes with `--mirror` and no `--force` anywhere.

Verification then reads the target back and checks source identity, target identity, source head,
target head, default branch, every required branch ref, every tag, and whether the source head
commit is actually reachable in the target. **A transfer that cannot be proved is `BLOCKED`, never
reported as partial success.**

### Secrets and configuration

Travels as Git content: workflow *definitions*, Dockerfile, build configuration, scripts, docs,
contracts, migrations, `.env.example`.

Never travels: Actions secret *values*, branch protection, WIF/IAM, cloud accounts, database
credentials, hosted environment configuration. These become a `SECRET_CONFIG_HANDOVER` checklist of
names, purposes, consumers, environments, destinations, owners and per-item setup status. Status
stays `REQUIRES_OPERATOR_SETUP` until an operator confirms a working value in the destination; it
is never marked `VERIFIED` on the strength of the export. A secret that cannot be moved safely is a
normal handover outcome, not a reason to copy it.

## Manual operator path

For when MCP is unavailable. It runs the *same* service through the Control API, so it cannot have
different business logic or skip a gate — an operator who tries to hand-write state instead is
bypassing the gates, which is exactly what this path exists to avoid.

```bash
BASE="https://<project-ref>.supabase.co/functions/v1/control-api"
AUTH="authorization: Bearer $SUPABASE_ACCESS_TOKEN"   # a SUPERADMIN operator session

# 1. What is canonical today?
curl -sS -H "$AUTH" "$BASE/v1/projects/$PROJECT_ID/canonical-repository"

# 2. Dry run. Read result, blockers, warnings and changesThatWouldOccur before going further.
curl -sS -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"resourceId\":\"$RESOURCE_ID\"}" \
  "$BASE/v1/projects/$PROJECT_ID/canonical-repository/plan"

# 3. Promote, pinning exactly what the plan reported. A moved head blocks with
#    STALE_PROMOTION_PLAN rather than being silently adopted.
curl -sS -X POST -H "$AUTH" -H 'content-type: application/json' -d '{
  "resourceId":"'"$RESOURCE_ID"'",
  "operationId":"canonical-promote-2026-08-30-1",
  "expectedHeadSha":"<candidateHeadSha from the plan>",
  "expectedCurrentCanonicalVersion":<expectedCurrentCanonicalVersion from the plan>,
  "confirmation":"PROMOTE_CANONICAL_DEVELOPMENT_REPOSITORY",
  "reason":"Operator-approved canonical development target"
}' "$BASE/v1/projects/$PROJECT_ID/canonical-repository/promote"
```

Rules that apply to the manual path exactly as they do to MCP:

1. Never skip the dry run. The mutation re-checks everything anyway and will refuse a blocked plan,
   but the plan is where a human sees what is about to change.
2. Reuse an `operationId` only to *replay* the same logical operation. A replay returns the existing
   result; it does not create a second binding or move `canonicalSinceAt`.
3. Never edit `canonical_development_repositories` by hand. The atomic function and the partial
   unique index are the invariant; a manual `UPDATE` is how a project ends up with two.

## Developer handover

`superadmin_developer_handover_report` checks objective facts about the canonical repository at an
exact commit: an ACTIVE binding, README and quick start, the `docs/handover/` package, an
`.env.example` free of secret material, migration instructions, runnable build and test commands,
documented contracts, an ownership map, an infrastructure inventory with explicit per-item status,
troubleshooting, no machine-specific absolute paths, and — importantly — that the local development
instructions do **not** require Backend Autopilot, an MCP client or a Superadmin token.

It judges presence and content. It does not judge writing quality, and it never invents an
infrastructure fact: anything unproven reads `UNVERIFIED` or `REQUIRES_OPERATOR_SETUP`.

Templates for the package live in [`docs/handover-template/`](./handover-template/). They are added
to a canonical repository the ordinary way — a task, a branch, a pull request — because the handover
package is repository content like any other.

## Autopilot and humans in one Git process

Backend Autopilot is *a* contributor to a canonical repository, never a runtime dependency of it.
After a merge the repository contains no proprietary hook without which a human cannot build or
change the project.

```text
human:      clone → branch → edit → test → commit → push → PR → merge
Autopilot:  task  → branch → implementation → verification → PR → merge
```

Both end at the same place, through the same Git.
