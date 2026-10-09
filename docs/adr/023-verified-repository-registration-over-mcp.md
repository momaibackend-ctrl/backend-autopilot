# ADR 023: Verified repository registration over the remote MCP

Status: accepted for v0.5.

## Context

ADRs 016–022 made a registered `GITHUB_REPOSITORY` resource the entry point to everything the autopilot verifies: contract discovery, environment plans, HTTP E2E runs, parity and the READY gate. But a remote agent could not register one.

- `superadmin_resource_create` refuses Git bindings, and it is right to. An unverified binding would let a caller point the autopilot at any repository it names.
- The verified flow existed only as local scripts (`register-self-resource`, `register-organization-repository`) on top of the `gh` CLI. The Edge MCP cannot spawn `gh`.

So the connector could reach every tool that needs a repository, but never the step that provides one. The work had a dead end at its first step.

## Decision

`superadmin_repository_register({operationId, projectId, repository, access})` performs the same verification as the local flow, over the GitHub REST API, with the credential the control plane actually holds. No check is relaxed:

- **Exact name.** `repository` is exactly `owner/name`. GitHub's answer for that name must be that name, ignoring case. A renamed repository answers with its new identity through a redirect, so the old name is refused and the current name is given. The autopilot never relies on the redirect.
- **Private.** The repository must be private (AGENTS.md rule 8).
- **ADMIN.** The control-plane identity must have **ADMIN** on the repository. That is the proof the local flow accepts for organization repositories, and every later write needs it. If ADMIN is missing, the refusal says how to grant it.
- **One project.** A repository registered to another project is a conflict, never silently re-pointed.
- **Namespace last.** The namespace (`GITHUB_ACCOUNT`) is registered only after the repository check passes, as the organization script does.
- **Access.** `access: READ` (the default) is enough for discovery, plans, HTTP E2E and parity. `access: FULL` grants `READ, WRITE, ADMIN` (the scripts' set) for task execution, pull requests and merges. Asking for FULL on a READ registration upgrades it only after the same verification passes again.
- **Semantics.** It is an idempotent semantic tool backed by `SuperadminService`, with `mcp.repository_register` audit. `superadmin_resource_create` keeps refusing Git bindings and now names this tool.

This is not the "generic Git binding" AGENTS.md rule 10 forbids. It accepts one repository identity, verifies it against GitHub itself, and refuses anything public, unadministered, renamed or owned by another project. It takes no URL, path or arbitrary remote.

## Consequences

- A remote agent can go from "here is the repository" to a verified HTTP E2E verdict without anyone running a local script.
- Registering a repository the identity cannot administer still needs a human: they grant the role in GitHub, and the refusal says so. The autopilot never asks for or stores a credential to work around it.
