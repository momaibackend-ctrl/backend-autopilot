# ADR 018: Ephemeral verification environments

Status: accepted for v0.5. Delivered in parts: 2a (environment plan, this change), 2b (GitHub Actions harness), 2c (job kind, tool, evidence).

## Context

The autopilot can measure a collection against every contract in a repository (ADR 016, ADR 017). But it can only send requests to a server somebody has already deployed and registered by hand. In practice, verifying a Java port meant asking a person for the test server's address. A project nobody has deployed has no such address at all.

The autopilot is meant to own the whole verification cycle, so that dependency on a human has to go. A permanently running test server should not be a prerequisite either.

## Decision

The autopilot builds and starts the commit under test itself, in a throwaway environment, and destroys the environment afterwards.

### 2a — the environment plan

`packages/ephemeral-environment` reads a repository and produces an `EnvironmentPlan`:

- the stack: Gradle or Maven for Kotlin and Java, Node, Python, Go;
- the base image;
- the install, build, prepare and run commands, each as an argv list and never a shell string;
- the port and the health probes;
- the dependency containers: PostgreSQL, MySQL, Redis, MongoDB;
- the evidence behind each decision.

Dependency versions come from the project's own `docker-compose` files when it has them. Dependency credentials appear in the plan only as templates such as `{{postgres.password}}`. The harness fills them with values it generates for each run, so no plan, artifact or log carries a usable credential.

A project can pin or override any field in `.autopilot/environment.yml`. The manifest is validated strictly:
- unknown fields are rejected;
- commands must be argv lists;
- the root cannot leave the repository;
- a secret-like variable must hold a generated-credential template, never a literal value.

An invalid manifest is reported and none of it is applied.

Whatever the planner can neither infer nor read from the manifest is listed in `unresolved` with a concrete remediation. Examples: several applications in one repository, an unknown way to start the application, no recognised build. An unresolved plan is never executed. The run that needed it is `NOT_PROVEN` and names the reason. It is never a guess presented as a result.

`superadmin_environment_plan` shows the plan for any registered repository at an exact commit, before anything runs.

### 2b — the harness: three jobs, split by trust

The GitHub Actions workflow `autopilot-http-e2e.yml` has three jobs:

1. **Prepare** (control-plane secrets). Reads the durable job, resolves the exact SHA, fetches the source archive, and builds the plan and the contract inventory. Hands them on as a workflow artifact. The project's code is never executed here.
2. **Environment** (no secrets, no tokens). Starts the dependency containers with throwaway credentials, builds and starts the application inside a container, and waits for a health probe. Then runs the collection against the loopback port and writes the evidence: the report, plus redacted log tails from build, start and dependencies.
3. **Record** (control-plane secrets). Validates the evidence against its schema and records it, bound to the commit. The project's code is never executed here either.

The project's code therefore runs only where nothing worth stealing exists. The environment ends with the job: no long-lived server, nothing to clean up by hand.

Scenarios target an ordinary `LOCAL` `HTTP_API` resource at `http://127.0.0.1:18080`, which the runner already accepts for loopback. No new target type is introduced. Parity runs (stage 3) add a second one on port 18081.

### 2c — job kind, tool and evidence

- A new execution job kind `HTTP_E2E`, with a migration widening the kind constraint.
- A semantic tool to enqueue it, carrying operation-ID idempotency and audit.
- A report that classifies every failure, so the next step is diagnosis rather than a retry: `BUILD_FAILED`, `DEPENDENCY_UNAVAILABLE`, `ENVIRONMENT_BOOT_FAILED`, `HEALTH_CHECK_FAILED`, `CONTRACT_GAP`, `SCENARIO_FAILED`, `PLAN_UNRESOLVED`.

## Consequences

- Full HTTP verification no longer depends on a person supplying an address, nor on a deployed server existing.
- Each run builds from scratch and costs GitHub Actions minutes: typically 5–15 per implementation, double for a Kotlin/Java parity pair. Accepted.
- Kafka, RabbitMQ and Elasticsearch are detected but not yet provisioned. The plan notes them, and an application that cannot start without them reports `ENVIRONMENT_BOOT_FAILED` with its own log.
- The same plan and evidence feed the repair cycle (stage 4). That cycle diagnoses the classified cause and fixes it, rather than blocking after a number of attempts.
