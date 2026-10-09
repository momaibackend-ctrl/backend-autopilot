# ADR 020: READY requires full HTTP verification, through a versioned profile

Status: accepted for v0.5.

## Context

ADRs 016–019 let the autopilot prove a commit over real HTTP in a throwaway environment, and compare it with the implementation it replaces. The READY gate did not use any of that. A task that added or changed an API could reach READY on green unit, integration and contract suites, without ever being built, started and called. That is the same false confidence a seven-request collection gave.

Two constraints shaped the decision:

- **Order.** HTTP verification needs a commit that exists, so it runs after the implementation job commits. The READY gate runs inside that same job. Requiring the evidence at that point would fail every review, spend a repair attempt each time, and push work towards BLOCKED, which is the outcome this project has chosen to avoid.
- **No retroactive block.** Tasks already planned must not acquire a new requirement.

## Decision

- **A versioned profile.** Verification profile **v2** adds an `HTTP_E2E` layer. It is `REQUIRED` when the task changes a public HTTP surface (the same intent-based classification as `HTTP_CONTRACT`), or when the task asks for end-to-end verification in so many words, in English or Russian ("e2e", "parity", "полная интеграционная проверка", …). Otherwise it is `NOT_APPLICABLE`, with the reason. A plan keeps the profile version it was made with, so v1 plans never owe the layer.
- **Where it applies.** The gate applies the layer only to projects whose code lives in a registered remote repository. A purely local project cannot provision a throwaway environment.
- **A resting state.** The gate accepts only `PROVEN` HTTP E2E evidence (a `VALIDATION_REPORT` with `suite: "HTTP_E2E"`) for the **exact latest run commit**. When that evidence is the one thing missing, review does not fail. The task moves `REVIEWING → VERIFYING`, a new resting state, and no repair attempt is spent. Readiness reports a `HTTP_E2E_EVIDENCE` blocker whose remediation names the commit, and `nextAction` names `superadmin_http_e2e_run`.
- **`VERIFYING → READY`** happens when PROVEN evidence for that commit is recorded. The record job calls `taskCompleteVerification`, which evaluates the **whole** gate again; nothing is granted on the verdict alone. `superadmin_task_complete_verification` is the recovery path if that step did not finish. The `FINAL_CHANGE_MANIFEST` records `gates.httpE2e` and the evidence artifact.
- **`VERIFYING → IMPLEMENTING`** is the repair path after a NOT_PROVEN verdict. A new implementation job is accepted from VERIFYING and re-enters the full gate chain for the new commit. The readiness blocker carries the failure class and message.
- **`VERIFYING` is a resting state.** The execution runner's rule that TESTING and REVIEWING are never observed at rest does not apply to it.

## Consequences

- An API task planned after this change cannot reach READY without its exact commit having been built, started and verified against every contract. That holds for every project with a registered repository, not just one product.
- Starting the HTTP E2E job when a task enters VERIFYING, and diagnosing a NOT_PROVEN verdict, is still the caller's next action here. Automating both, and replacing the repair-attempt limit with cause-driven repair, is the next decision (stage 4b).
- The Operator Console lifecycle rail gains a VERIFYING rung between REVIEWING and READY.
