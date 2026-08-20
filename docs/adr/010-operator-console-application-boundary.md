# ADR 010: Operator Console uses a dedicated application read model

Status: accepted for v0.3.

## Context

The browser needs aggregated project, task, provider, validation, artifact, and audit data. Allowing React to read state files, databases, Git, GitHub, or Supabase would duplicate domain logic and bypass project/resource authorization.

## Decision

`OperatorConsoleService` is a server-side application service composed from the existing `StateStore`, `AutopilotService`, `PolicyEngine`, test/command engines, provider adapters, and `SecretProvider`. Fastify exposes typed semantic console routes. Next.js only calls those routes and renders returned data as escaped text/JSON.

Read models may aggregate existing state but do not redefine workflow or readiness. Mutations are limited to non-production validation, allowlisted HTTP requests, and persisted validation scenarios. Every external request must name a project-owned `HTTP_API` resource and pass `PolicyEngine`; protocol-relative origin changes, browser-provided credentials, redirects, and production actions are rejected.

Validation scenarios store non-secret definitions as artifacts. Extracted values exist only for the duration of a server-side run. Sensitive values may be used only through `bearerFrom`, are never interpolated into paths/bodies, and are redacted from response artifacts and audit.

## Consequences

- MCP, CLI, API, and UI continue to share domain/application behavior.
- Polling provides restart-safe live updates without a new messaging system.
- The console can be replaced without changing Core.
- Full Figma/frontend assembly remains outside v0.3; provider-neutral `DesignSourceAdapter` and `FrontendTaskSourceAdapter` define its future boundary.
