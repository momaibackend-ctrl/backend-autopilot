# Handover index

> **Template.** Copy this file to the canonical repository as `docs/handover/README.md` and replace
> every `<…>` with a fact about the project. (This folder's own `README.md` is the guide to the
> template set, not part of the package.)

`<One paragraph: what this service is, who uses it, and what it is responsible for.>`

## Start here

You need a laptop, a Git client and a JDK. You do **not** need Backend Autopilot, an MCP client or
any platform token to build, run, test or change this project.

1. [local-development.md](./local-development.md) — clone, configure, run, test. Start here.
2. [architecture.md](./architecture.md) — the module map, ownership, and the bypass paths that are
   forbidden.
3. [change-guide.md](./change-guide.md) — the procedure for making a change without creating a
   second source of truth.

## Reference

| Document | Answers |
| --- | --- |
| [local-development.md](./local-development.md) | How do I get this running on my machine? |
| [architecture.md](./architecture.md) | What owns what, and which direction do dependencies point? |
| [contracts.md](./contracts.md) | How does anything talk to anything else? |
| [database.md](./database.md) | What is the schema, and how do I change it safely? |
| [testing.md](./testing.md) | Which test layers does my change need? |
| [deployment.md](./deployment.md) | How does this reach an environment, and how do I roll it back? |
| [infrastructure.md](./infrastructure.md) | What exists, what is only required, and who grants access? |
| [troubleshooting.md](./troubleshooting.md) | Why is it doing that? |
| [change-guide.md](./change-guide.md) | What is the procedure? |

## Status honesty

Anything in these documents that has not been verified says so, in these exact words: `VERIFIED`,
`REQUIRES_OPERATOR_SETUP`, `UNAVAILABLE`, `NOT_APPLICABLE`, `UNVERIFIED`. An honest
`REQUIRES_OPERATOR_SETUP` is worth more than a plausible-sounding endpoint that does not exist.

## Who to ask

| Topic | Owner | Contact |
| --- | --- | --- |
| `<domain>` | `<team or role>` | `<channel>` |
| `<infrastructure>` | `<team or role>` | `<channel>` |
