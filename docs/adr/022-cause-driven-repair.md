# ADR 022: Repair is driven by the cause of failure, not limited by a count

Status: accepted for v0.5. Supersedes the "`maxAutoRepairAttempts`, then `BLOCKED`" rule. Second part of stage 4b.

## Context

A task whose tests failed returned to IMPLEMENTING until `maxAutoRepairAttempts` (3). After that it was BLOCKED, and `taskRetry` refused it with "Repair limit exhausted; human intervention required".

That rule measured the wrong thing:

- **It could not see progress.** Three different failures, each fixed in turn, counted exactly like one failure retried three times.
- **It stopped the caller who was making progress,** and told nobody what to do differently.
- **It did not guard against a runaway loop, because there is none.** Repairs in this control plane are never automatic: every one is a new change set that an agent chose to send. The counter therefore stopped nothing that needed stopping.

The project's goal is to solve the task: find the cause and fix it, not block it. ADR 021 made causes measurable: each failure gets a diagnosis and a fingerprint with run-specific values removed.

## Decision

- **A failed test run always returns to IMPLEMENTING.** The attempt counter stays, but only as a statistic. `taskRetry` accepts a BLOCKED or FAILED task whatever its count.
- **Progress is measured by cause.** `repairProgress` reads every failed verification of the task in order:
  - failed test reports, fingerprinted by which suites failed and how, plus failing replay seeds;
  - NOT_PROVEN HTTP E2E evidence, by its diagnosis fingerprint.

  A repair that changes the fingerprint is progress. When the same cause comes back `STAGNATION_THRESHOLD` (3) times in a row, the state does not change; the guidance does. The transition reason and `readiness.nextAction.why` tell the agent that the last fixes did not reach the cause, and say what to do next:
  - read the full failing output;
  - reproduce the failure in the smallest case;
  - check the neighbouring layer (contract, scenario, environment manifest, migration, dependency version);
  - only then send a repair based on a new hypothesis.
- **Readiness reports the progress** to every caller: `readiness.repair` carries `failures`, `consecutiveSameCause`, `stagnating`, the latest fingerprint and guidance.
- **The honest stop is unchanged.** It applies where the fix needs something the safety rules forbid: production access, a real secret, login or OAuth, a product or legal decision. Such a fix is still refused, with a precise request saying what is needed and why. Nothing in this change weakens those rules or the READY gate. READY still requires every piece of evidence.

## Consequences

- A task is never stopped because it needed a fourth attempt. It is told, with evidence, whether its repairs are reaching the cause.
- A stagnating task stays visible, in IMPLEMENTING with stagnation guidance in `awaitingCaller` and readiness, instead of disappearing into BLOCKED.
- The test-failure fingerprint is coarse: the failing suites, not individual test names. It can call two different failures in the same suite "the same cause". The only consequence of that is a stronger hint, never a block, so the error is cheap. A finer fingerprint can come from structured test output later.

## Amendment: the failing tests are named, and a task runs one job at a time

On a real Kotlin task the agent saw "473 tests completed, 1 failed" and an exit code. The name of the one failing test, an architecture rule, was buried in 4 MB of DEBUG output. The agent sent three variations of the same change and stalled on the stagnation guidance, because nothing told it what to look at. It had also sent change sets back to back, so two jobs built the same branch at once and one lost the push.

- **The Gradle test report carries `failedTests`.** These are the failing tests by class and name, with the first line of the message, at most 50. They are read from the JUnit XML results the build writes, with the console transcript as the fallback.
- **The repair guidance names them**, and `readiness.repair.latestFailedTests` carries them.
- **The fingerprint includes the failing test names.** "The same cause" now means the same tests, not just the same suite.
- **A task accepts one job at a time.** `enqueueImplementation` and `enqueueRebase` refuse a new job while one is in flight (queued, dispatched, claimed, running, or a resumed attempt waiting for its back-off). The `CONFLICT` names the job to wait for. Replaying an operationId stays status-only.
