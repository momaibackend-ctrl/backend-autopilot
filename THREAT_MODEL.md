# Threat model

| Threat | Boundary/control | Remaining v0.5 risk |
|---|---|---|
| Prompt injection in tasks, attachments, README, comments or source | Structured context, provenance, no policy-from-text, semantic MCP operations | A future LLM provider needs content isolation and adversarial evals |
| Malicious repository content | Repository data is never executed implicitly; only plan-required fixed test entrypoints run | Test code itself executes inside the host account; OS/container sandbox remains future hardening |
| Shell injection | `spawn(..., shell:false)`, argument metacharacter denial, executable/category allowlist | Provider CLIs need narrower provider-specific argument schemas |
| Secret leakage | Secret references, env provider, recursive audit/artifact/log redaction | External vault integration and entropy scanning remain future work |
| Cross-project access | `projectId` on every lookup, resource ownership check, exact workspace match | PostgreSQL row-level security is not enabled on the control-plane store |
| Destructive migration | Versioned artifact, migration tests, deny by mode/resource permission | Automated down-migration execution is not implemented |
| Compromised dependency/supply chain | Lockfile, CI, minimal dependencies, no implicit postinstall approval | SBOM/signature verification remains future hardening |
| Privilege escalation / MCP abuse | Separate high-entropy superadmin token, semantic Zod tools, operation idempotency, audit, no shell/SQL/path/provider escape, PolicyEngine on writes | Static bearer rotation and per-tool rate limits need a managed identity gateway before multi-tenant SaaS |
| Wrong authenticated account | Dedicated-sandbox human confirmation plus exact identity/resource matching | Human may falsely confirm an account; live provisioning remains sandbox-name constrained |
| Credential bootstrap leakage | Generated values go directly to gitignored secret provider; command journal masks sensitive positions | CLI process arguments can be transiently visible to the local OS account |
| Misleading capability claims | Evidence-based statuses and audit-backed `LIVE_TESTED` | Provider behavior can change after the last test timestamp |
| Resource confusion | Explicit UUID allowlist and globally unique provider/reference | Human may register the wrong sandbox ID; an additional verification challenge remains future work |
| Audit tampering | Append-only API and PostgreSQL trigger | External immutable/WORM export remains future work |
| Artifact-based XSS / malicious Markdown | React text/JSON rendering only; no raw HTML or Markdown; browser E2E executes hostile probes | A future rich Markdown renderer requires a reviewed sanitizer and CSP |
| API Runner SSRF / origin escape | Exact project-owned `HTTP_API` allowlist, non-production mode, HTTPS or loopback HTTP, same-origin path assertion, no redirects | DNS rebinding and private-address resolution checks require a hardened outbound proxy before remote multi-tenant deployment |
| Browser credential exfiltration | Secret-bearing headers/body fields rejected; server-side secret resolution; response cookies/auth headers omitted; recursive redaction | Auth identities need a richer server-side credential-profile abstraction |
| Saved-scenario token leakage | Sensitive extractions stay in memory, can only feed `bearerFrom`, and are redacted from evidence | Distributed scenario workers need encrypted ephemeral state |
| Cross-project console access | Edge validates Supabase operator role and membership; Dashboard aggregation is membership-filtered; explicit `SUPERADMIN` is global | Organization/tenant-level delegated administration remains future work |
| Superadmin credential theft | Credential is separate from browser and project MCP, exists only in secret stores, mutations are audited and safety invariants remain enforced | Managed short-lived identity, MFA-bound tokens and revocation telemetry remain future work |
| Semantic admin deletion abuse | Typed confirmation/reason/object identity, active-job checks, archive/tombstone semantics, last-superadmin protection | Retention policy and external immutable backups remain future work |

Trust assumptions: GitHub Actions and the dedicated Supabase sandbox control plane are trusted; the holder of the dedicated superadmin token is authorized for global administration but not safety bypass; target credentials are scoped to explicit registered resources; hostile requirements and repository text remain data. The local OS is not part of the deployed runtime. Production writes remain outside the v0.5 trust boundary.
