# ADR 019: Behavioural parity between two implementations

Status: accepted for v0.5.

## Context

A port, such as a Kotlin service re-implemented in Java, is verified when the new implementation does what the old one did. Two `PROVEN` collection runs against one contract do not show that. Each says only that its implementation passed the checks the collection makes. Both can answer `200` with bodies that differ in a field, a nested shape, a timestamp format or an error code, and every assertion can still pass. Nothing compared the two answers to each other.

## Decision

`superadmin_http_e2e_run` takes an optional `counterpart`: the reference implementation, given as a registered repository, a ref, a root and a label.

- The reference is **authorized and pinned like the subject**: a project-owned, non-production repository, PolicyEngine `PROVISION` with `READ`, and an exact SHA resolved at enqueue.
- Both run the **same scenarios**, each in its own fresh environment. Each gets its own dependency containers and database, and they run one after the other on the same loopback port, so neither sees the other's state.
- Every response is **compared step by step**, pairing steps by scenario and position. The comparison covers:
  - the outcome;
  - the HTTP status;
  - the media type;
  - the normalized body.
- **Normalization removes only per-run values.** Generated identifiers, UUIDs, JWTs and timestamp instants are replaced by their type. Business data is compared as it is. Timestamp *formats* are kept, so `…Z` versus `….000Z` is reported.
- A step **only one side ran**, or a body that was **truncated** in the evidence and so **could not be compared**, is a difference. A check that was not made is not a match. Bodies are kept up to 64 KB in environment runs to make truncation rare.
- **`PROVEN` requires all three:** the subject is `PROVEN`, the reference is `PROVEN`, and there is no difference. Otherwise the failure is the subject's own failure, `REFERENCE_NOT_PROVEN`, or `PARITY_MISMATCH`. The evidence carries the reference run summarized and the full `ParityReport`, with the first 500 differences and their JSON paths.

The docker self-test proves the comparison both ways on every change to it:
- an implementation compared with itself must be `PROVEN`;
- the same implementation compared with a variant that adds one response field must be `NOT_PROVEN` with `PARITY_MISMATCH`.

## Consequences

- "The Java port behaves like the Kotlin service" becomes a recorded, commit-bound claim with an itemized list of every difference, instead of an inference from two green runs.
- Some ordering differences are legitimate, such as an unordered list returned in a different order. They are reported as differences. The project resolves them by making the order explicit in the API, or by sorting in the scenario's request. They are never silently ignored.
- Database state is compared only as far as the API exposes it. Comparing tables directly would need a read-only database resource per implementation. That is a possible later extension, and it does not change this report.
