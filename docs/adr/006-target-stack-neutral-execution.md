# ADR 006: Target-stack-neutral execution ports

Status: accepted. Core depends on `ImplementationExecutor`, `GitWorkspaceAdapter`, `TestExecutor` and `CommandJournal` ports. The bundled local Git and Node test implementations prove v0.1, while Python, Go or other target stacks can replace them without changing workflow, policy, registry, audit, artifacts, MCP or application orchestration.
