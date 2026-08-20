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
- Provider accounts must be explicitly confirmed as dedicated sandbox identities before discovery; authenticated sessions alone grant no authority.
- GitHub authorization never logs out or overwrites existing accounts: the expected sandbox login must be explicitly switched active and matched before registration and every write.
- An existing GitHub repository is adopted only by exact `owner/name` confirmation, active-owner match, private visibility, `ADMIN` permission, and a project-scoped registry record.
- Generated passwords are transient credentials stored by `MutableSecretProvider`; sensitive CLI argument positions are journaled as `[REDACTED]`.
- IPv4-only sandbox hosts use the official Supavisor session pooler with encrypted `sslmode=require` semantics. CA-pinned `verify-full` remains preferred when the provider certificate is available; production autonomy remains unsupported.
- Repository/database deletion requires a separate semantic tool plus a resource-bound confirmation object.
- Capability status distinguishes implemented, configured and live-tested behavior; mocks can never produce live evidence.

Security tests cover production disablement, prompt injection, command injection, sensitive argument redaction, migration destruction, provider naming/identity guards, unknown resources, artifact isolation and cross-project repository use.

## Operator Console controls

- React renders task, repository and artifact content only as escaped text/JSON. There is no raw HTML or untrusted Markdown execution.
- Provider credentials remain in `SecretProvider`; console resource models replace every secret reference with `[SERVER_SIDE_SECRET]` and never resolve secret values for browser responses.
- API Request Runner requires a project-owned active `HTTP_API` resource, `AUTONOMOUS_STAGING`, `READ`, and a non-production project. HTTPS or loopback HTTP is required; redirects and protocol-relative/origin-changing paths are denied.
- `authorization`, cookies, API keys, credential-shaped request-body fields, CR/LF headers, and URL credentials cannot be supplied by the browser. Server-side resource credentials are injected only after policy authorization.
- Response `set-cookie` and authentication headers are not returned. Credential-shaped response fields and bearer values are recursively redacted before artifact/audit persistence.
- Saved scenario access is project-scoped. Sensitive extracted variables live only in memory and may only be consumed as a bearer value, never interpolated into URL/query/body text.
- Console routes return typed human errors. Unexpected server errors are logged after redaction and the browser receives no stack or raw exception details.
- Playwright proves artifact-based script/HTML payloads remain inert. Security tests prove production actions, origin escape, browser credentials, unknown resources, and cross-project scenario access are denied.
