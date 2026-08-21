# ADR 013: Semantic superadmin control plane

Status: accepted for v0.5.

## Context

The remote MCP needed parity with Operator Console and broader administrative control without becoming a shell, SQL, filesystem or provider escape hatch. Project membership alone cannot express a trusted global administrator, while bypassing platform safety would invalidate the control-plane model.

## Decision

Introduce `SUPERADMIN` as an authenticated principal role and `SuperadminService` as a semantic application boundary over the existing stores, lifecycle services, PolicyEngine and durable execution coordinator. The role bypasses project membership only. Every mutation has a Zod contract, operation ID, redacted `mcp.<tool>` audit event and idempotent `admin_operations` record. Dangerous changes require typed confirmation and object identity fields.

Persist `ConsoleScreen` and `SystemSetting` domain objects so Console content/navigation can be managed without source-code or arbitrary HTML access. Formal workflow artifacts stay immutable; admin-authored content is restricted to `ADMIN_NOTE` and `CONSOLE_SNAPSHOT`. Project/task/run/artifact deletion is a recoverable tombstone or archive where history must remain reproducible.

Repository binding remains a dedicated verified provider flow. Generic superadmin resource calls cannot create or rebind Git/GitHub resources. `AUTONOMOUS_PRODUCTION`, production writes, arbitrary commands, SQL and paths remain technically unavailable.

## Consequences

The HTTP MCP can provide global system control and a one-call operational overview while preserving the original safety boundary. Adding an entity or Console screen requires a schema, store port implementation, semantic service methods, MCP contracts, audit/idempotency behavior and tests; it does not require a UI source-editing API.
