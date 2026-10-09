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
