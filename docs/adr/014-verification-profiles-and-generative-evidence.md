# ADR 014: Verification profiles and generative-test evidence

Status: accepted for v0.5.

## Context

The Momna core epic CORE-BE-01..21 completed with every formal gate green: unit, domain, contract, integration, migration, security and regression suites, real PostgreSQL/Redis/MinIO coverage, exact-SHA CI, IndependentReview and final manifests on all twenty-one tasks. Not one of them contained a property-based test, and nothing in Autopilot noticed. The gap was found by a human reading the finished epic, after everything had already merged.

The reason is that the required-test set was a fixed list plus two keyword-driven extras. It could ask whether a suite ran; it could not ask whether the right *class* of verification ran. Example-based tests answer "does this behave correctly on the inputs a developer thought to write down?". They cannot answer whether a rollout bucketing rule stays monotonic across every `userId x threshold` pair, or whether `startOfLocalDay <= instant < endOfLocalDay` holds for arbitrary instants in zones that observe DST. Repository and integration tests do not cover that risk class either; they cover a different one.

Two further defects surfaced on the follow-up task CORE-QA-02, which was created specifically to close the gap:

1. Its requirements forbid public HTTP APIs and involve no migration, yet the planner recorded `apiChanges` and `databaseChanges` anyway, and the READY gate then demanded `MISSING_API_CONTRACT` and `MISSING_MIGRATION_MANIFEST` for evidence the task was not allowed to produce. The keyword scan could not distinguish "add a REST endpoint" from "do not add public HTTP APIs". An `INTERNAL_ONLY` escape hatch existed, but only for the API axis and only when an author remembered the exact word.
2. Its execution job sat at `DISPATCHED`, its run at `RUNNING` and its task at `IMPLEMENTING` with no branch and no failure. The reconciler only examined jobs carrying a `workflowRunId`, and `workflow_dispatch` answers `204` with an empty body, so the dispatcher never had one to record. Jobs GitHub never started were exactly the jobs the watchdog could not see.

## Decision

**Classify scope by intent, not by mention.** `scope-classification.ts` splits a task's text into clauses and treats a negation cue governing a subject ("do not", "without", "rather than", "preserve") as evidence against that change. `INTERNAL_ONLY` remains an author-written override. Suite *coverage* still follows mention -- asking for more coverage than needed is harmless -- while `apiChanges` and `databaseChanges`, which the gate turns into required artifacts, follow intent. `schema` no longer counts as a database signal on its own, because Zod, JSON and artifact schemas appear in nearly every control-plane task.

**Decide the verification matrix before implementation.** `verification-profile.ts` records every layer as `REQUIRED` or `NOT_APPLICABLE` with a stated reason, and the profile is persisted inside the implementation plan. `PROPERTY` is required when the task text carries an algorithmic invariant -- state machine or lifecycle, time/timezone/DST, numeric logic, deterministic hashing or bucketing, idempotency or deduplication, parsers and serializers, ordering, monotonicity and bounds, or complex data transformation -- and refused where none exists, naming the CRUD/DTO/thin-adapter/static-registry shape it matched. Property-based testing is deliberately not imposed everywhere: a gate that demands it on straight-line mapping code teaches people to route around the gate.

**Never satisfy a generative layer with an exit code.** A build with zero property tests and a build with nine exit `0` identically, which is how the original gap passed twenty-one gates. `PROPERTY_BASED_REPORT` therefore carries property and generated-case counts, shrinking state, replay seeds and counterexample counts parsed from the runner's own output: jqwik's console report on the JVM, fast-check's failure output on Node, or a project-emitted `reports/property-based-report.json` for runners that stay silent on success. Absent evidence is `UNVERIFIED`, never a pass, and `UNVERIFIED` blocks `READY` through both the readiness gate and a dedicated `propertyBasedAdequacy` review check.

**Terminalize stale executions on elapsed time.** The runner stamps its `GITHUB_RUN_ID` onto the job when it claims one, so the reconciler has a run to query. Independently of that, `execution-reconciliation.ts` terminalizes any active job that goes unclaimed past the dispatch grace period (`EXECUTION_NEVER_STARTED`), holds a lease expired past its grace (`EXECUTION_LEASE_EXPIRED`), or exceeds the hard timeout (`EXECUTION_EXCEEDED_HARD_TIMEOUT`), each with a coded reason and a remediation naming the fresh `operationId` a retry needs.

## Consequences

A task that carries an algorithmic invariant cannot reach `READY` without generated-case evidence, and a task that carries none records that judgement instead of leaving a silent hole. The gap that took twenty-one merged tasks and a human review to notice is now a blocker at the first task that exhibits it.

The classifiers are lexical and therefore fallible in both directions. A false `REQUIRED` is cheap and self-correcting: an author states the task's shape in its requirements and re-plans. A false `NOT_APPLICABLE` is the expensive direction, so the trigger list is deliberately broad and the exclusions are narrow.

Plans persisted before this change carry no verification profile, and `requiredGateArtifacts` treats an absent profile as demanding nothing extra -- already-merged work is not retroactively blocked. Any task re-planned after this change gets a profile and is held to it.

`PROPERTY` is a new member of the plan's `testsRequired` enum. The `artifacts.kind` column has no check constraint, so `PROPERTY_BASED_REPORT` needs no migration; `TIMED_OUT` and `FAILED` already exist in the `execution_jobs` status constraint, so stale terminalization needs none either.
