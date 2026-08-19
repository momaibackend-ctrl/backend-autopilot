# Security

- The allowlist is empty by default. Resource discovery does not grant authority.
- All external mutations require `PolicyEngine.authorize` and a project-owned active resource with the required permission.
- `AUTONOMOUS_PRODUCTION` and production mutations are hard failures (`NOT_SUPPORTED`).
- Commands use `spawn` with `shell: false`; shell metacharacters, unknown tools and destructive categories are denied.
- File changes are normalized beneath the registered workspace; traversal, `.env`, and secret-like paths are rejected.
- Git requires clean state, snapshots the base commit, and never writes directly to `main`/`master`.
- Secrets are environment references only. Structured logs, artifacts and audit values redact credential-shaped keys and common token prefixes.
- Project-scoped store lookups prevent cross-project task, run and artifact reads.
- Imported source material is untrusted data and has immutable provenance stating that it is not instruction authority.
- Audit events are append-only in application code and protected from SQL UPDATE/DELETE by a database trigger.

Security tests cover production disablement, prompt injection, command injection, unknown/destructive commands, unauthorized resources, artifact isolation and cross-project repository use.
