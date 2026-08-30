# ADR 015: Epic verification at one head commit

Status: accepted for v0.5.

## Context

Every gate in this control plane is per-task, and a per-task gate structurally cannot answer the question that matters at the end of an epic.

CORE-BE-01..21 each passed implementation, ArchitectureGuard, all required suites, exact-SHA CI and IndependentReview. Each of those verdicts was true — about the commit that member ran on. Task 07's CI report proves nothing about `main` after 08..21 landed on top of it. So "twenty-one green tasks" never meant "the epic is green"; it meant "twenty-one commits were green, one at a time, at twenty-one different SHAs". Nothing in the system could express that distinction, and nothing asked for it.

The failures this leaves invisible are the composition failures specifically. A later task can break an earlier task's contract without either task's gate noticing, because the task that breaks a consumer is not the task that owns it. Migrations that each applied cleanly in isolation can conflict in sequence. Cross-module journeys exist precisely to exercise paths that cross member boundaries, so no member's own suite covers them. ADR 014 closed a gap in *what class* of verification runs; this one closes a gap in *what state* it runs against.

## Decision

An epic is judged at one named head commit, and evidence counts only when it was produced at that commit.

`packages/core/src/epic-verification.ts` aggregates the members into one matrix over seven dimensions — `CONTRACTS`, `CONSUMERS`, `INVARIANTS`, `INTEGRATION_DEPENDENCIES`, `SECURITY_PRIVACY`, `MIGRATIONS`, `JOURNEYS`. Each dimension's *requirement* is derived from what the members actually declared: contract coverage in their plans, a non-empty `databaseChanges`, a verification profile marking `PROPERTY` as `REQUIRED`, and so on. Security and privacy is unconditional. Consumers and journeys apply only where there is more than one member, because a single-member epic composes nothing.

**Staleness is the central rule.** Member evidence produced at an earlier commit is not a partial pass and not a warning — it is `BLOCKED`, and the reason names which members it came from and at which commits. Passing requires a check that ran at the head SHA itself.

**Nothing may be silently skipped.** Every dimension resolves to `PASS`, `NOT_APPLICABLE` with a stated reason, or `BLOCKED` with a remediation. There is no fourth state in which a dimension quietly does not appear in the report.

The gate stays a pure function. Whatever performs the aggregate run — a workflow, or an operator recording a verified external run — records an `EPIC_DIMENSION_EVIDENCE` artifact carrying the dimension, the exact commit, the pass/fail result and structured provenance: repository, head SHA, workflow run id and URL, recording actor, artifact hash and runner version.

**Trust is classified by the server, never accepted from the caller.** A free-text `source` field that anyone can set to `"github"` is a label, not a provenance. `sourceType` is therefore derived: evidence recorded by an actor matching the execution runner's own lease-owner format, and carrying a workflow run id, is `TRUSTED_CI`; everything else is `OPERATOR`; rows written before provenance existed read back as `HISTORICAL`. Manual evidence stays permitted — an operator may legitimately be recording a run performed elsewhere — but it can never masquerade as a CI run. The report carries a `trust` verdict of `CI_VERIFIED`, `OPERATOR_ASSERTED`, `MIXED` or `NONE` so the distinction is visible without reading every row.

The report also lists `staleEvidence` — rows recorded for this epic at some other commit — and `missingDimensions`, the required dimensions with no evidence at all. Stale evidence is never counted and never hidden: an operator looking at a blocked epic needs to see that a check did run, just not on the commit in question, and "this ran and failed" is a different problem from "this never ran". `superadmin_epic_verify` derives `EPIC_VERIFICATION_REPORT` from those plus the members' own state, and is read-only unless `persist` is set, so an agent can ask "what does this epic still owe?" at any point without writing anything.

`headSha` is a required input rather than resolved from the integration branch. An epic is a claim about one named commit; resolving "whatever `main` is right now" would let the subject of the verdict move underneath the run.

## The evidence runner

`autopilot-epic-verification.yml` produces what the gate judges. It takes the commit as an explicit
input and checks it out **detached, verified by `rev-parse` before anything else runs**. A run that
took half its results from one `main` and half from a `main` that had moved would describe a state
that never existed — the exact failure the gate exists to end, so reproducing it in the runner would
be self-defeating. Real disposable PostgreSQL, Redis and object storage come up alongside it,
because an integration dimension whose tests skipped for want of a database is unverified, not
passing.

Results are attributed to dimensions by test class convention (`packages/core/src/epic-check-plan.ts`),
and three things that look like success are refused: no attributed test ran at all, every attributed
test skipped itself, or the suite passed while the generative layer inside it generated nothing.
The runner never decides whether the epic passes — it records what ran and hands the verdict back to
`superadmin_epic_verify`, so it cannot mark its own homework.

The target project's own integration variable names stay out of the control plane. The workflow
exposes canonical values (`AUTOPILOT_EPIC_POSTGRES_URL` and friends) and the dispatch input carries a
`serviceEnv` map from the project's names onto them — project data, not Autopilot knowledge.

The runner is dispatched rather than tracked as a durable job. `ExecutionJob` requires a `taskId` and
an epic has none, so using it would have meant a schema migration for a run whose failure mode is
already safe: a run that dies writes no evidence, and the gate stays `BLOCKED`. It fails closed, and
that is the trade — there is no watchdog for a hung epic run, only the absence of a passing verdict.

## Consequences

An epic becomes green only after its own final run, not as a side effect of its members finishing. The report names, per dimension, what ran, at which commit, and what is still owed — so "is the Core actually shippable?" has an answer with evidence ids behind it instead of an inference from twenty-one older verdicts.

The gate does not itself execute anything. It decides what must be true and refuses to accept stale or absent evidence; producing the evidence remains the job of a runner or an operator. That separation is deliberate — it keeps the rule testable in isolation and lets any execution mechanism satisfy it — but it does mean the gate is only as honest as the `source` recorded against each result, which is why `source` is mandatory and every record is audited.

Member selection is by explicit task ids or by `externalKey` prefix. No epic entity is persisted: the report is the record. That avoids inventing a new first-class entity, and avoids coupling to any external tracker's notion of an epic.

`artifacts.kind` has no check constraint, so the two new artifact kinds need no migration.
