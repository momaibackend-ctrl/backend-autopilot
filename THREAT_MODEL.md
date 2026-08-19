# Threat model

| Threat | Boundary/control | Remaining v0.2 risk |
|---|---|---|
| Prompt injection in tasks, attachments, README, comments or source | Structured context, provenance, no policy-from-text, semantic MCP operations | A future LLM provider needs content isolation and adversarial evals |
| Malicious repository content | Repository data is never executed implicitly; only plan-required fixed test entrypoints run | Test code itself executes inside the host account; OS/container sandbox is v0.2 |
| Shell injection | `spawn(..., shell:false)`, argument metacharacter denial, executable/category allowlist | Provider CLIs need narrower provider-specific argument schemas |
| Secret leakage | Secret references, env provider, recursive audit/artifact/log redaction | External vault integration and entropy scanning remain future work |
| Cross-project access | `projectId` on every lookup, resource ownership check, exact workspace match | PostgreSQL row-level security is not enabled on the control-plane store |
| Destructive migration | Versioned artifact, migration tests, deny by mode/resource permission | Automated down-migration execution is not implemented |
| Compromised dependency/supply chain | Lockfile, CI, minimal dependencies, no implicit postinstall approval | SBOM/signature verification is v0.2 |
| Privilege escalation / MCP abuse | No shell proxy, read/write/destructive annotations, PolicyEngine on writes | MCP transport authentication is delegated to the local stdio host |
| Wrong authenticated account | Dedicated-sandbox human confirmation plus exact identity/resource matching | Human may falsely confirm an account; live provisioning remains sandbox-name constrained |
| Credential bootstrap leakage | Generated values go directly to gitignored secret provider; command journal masks sensitive positions | CLI process arguments can be transiently visible to the local OS account |
| Misleading capability claims | Evidence-based statuses and audit-backed `LIVE_TESTED` | Provider behavior can change after the last test timestamp |
| Resource confusion | Explicit UUID allowlist and globally unique provider/reference | Human may register the wrong sandbox ID; a verification challenge is v0.2 |
| Audit tampering | Append-only API and PostgreSQL trigger | External immutable/WORM export is v0.2 |

Trust assumptions: the local OS account and external PostgreSQL administrator are trusted; confirmed bootstrap accounts have no production access; target credentials are scoped to the intended sandbox; Git itself is trusted. Production is outside the v0.2 trust boundary.
