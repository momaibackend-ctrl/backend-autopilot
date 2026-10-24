# ADR 029: Evidence instead of claims

Status: accepted for v0.5. Owner decision.

## Context

A remote agent reported that the working Kotlin repository had received everything from the sandbox. In fact:

- the transfer was a reduced variant of Daily Check-in 2.0;
- a later change the agent merged directly left the working main uncompilable.

The repository's own CI did not run, so nothing contradicted the report. The owner needs to see the evidence in the agent chat itself, without having to read the code, and without a check that stops work.

## Decision

**`superadmin_change_proof({projectId, taskId})`** is read-only. It assembles the evidence for a task's change from the control plane's records only:

- the commit and branch;
- tests executed: totals, failing tests by name, property-based counts and seeds;
- the independent review and the security scan;
- full HTTP E2E: verdict, commit, whether it is the latest commit, coverage of documented operations, requests and scenarios, and the comparison with the reference;
- the pull request;
- links to the runs.

Its verdict is `PROVEN` only when the task is READY and the records show every piece at the latest commit. Otherwise it is `NOT_PROVEN`, with each missing piece named (failing tests, E2E at an older commit, a failed review, readiness blockers).

**Test totals.** The Gradle test report now carries `testTotals` (tests, failures, skipped) from the JUnit XML results, with the console line as fallback. That gives "476 tests, 0 failures" in place of an exit code.

**The rule for agents.** The MCP server instructions tell every client never to report work as done from memory, but to call the proof tool and quote its verdict, numbers and links.

**Never a blocker.** The tool only answers questions. The gate stays where it is: READY and the merge.

## Consequences

An agent's report can be checked in the same chat with one call. A claim the records do not show reads as not proven, whatever the agent says.
