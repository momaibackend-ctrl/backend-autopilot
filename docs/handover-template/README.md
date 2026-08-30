# Handover package template

These files are the shape of the `docs/handover/` package that a **Canonical Development
Repository** must carry, so a backend developer with no MCP client and no Superadmin token can pick
the project up.

Copy them into the canonical repository as `docs/handover/`, then fill them in with facts about that
project. They are added the ordinary way — a task, a branch, a pull request — because the handover
package is repository content like any other.

One file is renamed on the way in: `handover-index.md` becomes `docs/handover/README.md`. This file
you are reading is the guide to the template set and does not travel with it.

## What the gate checks

`superadmin_developer_handover_report` reads the canonical repository at an exact default-branch
commit and checks objective facts only:

| Check | Passes when |
| --- | --- |
| `CANONICAL_REPOSITORY_ACTIVE` | The project has an `ACTIVE` canonical binding |
| `DOCUMENTATION_READ_AT_EXACT_COMMIT` | The default-branch head resolved, so the report is reproducible |
| `HANDOVER_DOCUMENTS_PRESENT` | All twelve required paths exist |
| `HANDOVER_DOCUMENTS_SUBSTANTIAL` | Each prose document is more than a placeholder |
| `ENV_EXAMPLE_PRESENT` / `ENV_EXAMPLE_HAS_NO_SECRETS` | `.env.example` exists and carries no credential |
| `NO_RAW_SECRETS_IN_DOCUMENTATION` | The secret scanner finds nothing in any document |
| `NO_MACHINE_SPECIFIC_PATHS` | No `C:\Users\…`, `/home/…`, `/Users/…` |
| `LOCAL_DEVELOPMENT_NEEDS_NO_AUTOPILOT` | Local development needs no MCP, no `superadmin_*` tool, no Autopilot token |
| `MIGRATION_INSTRUCTIONS` | `database.md` says how to apply migrations |
| `TEST_COMMANDS` / `BUILD_AND_RUN_COMMANDS` | `testing.md` / `local-development.md` carry runnable fenced commands |
| `CONTRACTS_DOCUMENTED` | `contracts.md` describes the contracts |
| `OWNERSHIP_MAP` | `architecture.md` states module and data ownership |
| `INFRASTRUCTURE_INVENTORY` | `infrastructure.md` gives every item an explicit status |
| `TROUBLESHOOTING` | `troubleshooting.md` has concrete entries |
| `CHANGE_GUIDE` | `change-guide.md` gives a numbered procedure |

It judges presence and content. It does **not** judge writing quality.

## The one rule that is easy to get wrong

**Never write an infrastructure fact you have not verified.** Where something is not proven, say so
in the document with one of these words, which the inventory check looks for:

- `VERIFIED` — an operator confirmed it works
- `REQUIRES_OPERATOR_SETUP` — it exists as a requirement, nobody has set it up yet
- `UNAVAILABLE` — it cannot be provided
- `NOT_APPLICABLE` — this project does not need it
- `UNVERIFIED` — nobody has checked

A plausible-sounding invented endpoint costs a new developer more time than an honest
`REQUIRES_OPERATOR_SETUP`.

## Required paths

```text
README.md                          (repository root — quick start)
.env.example                       (repository root — variable names, placeholder values)
docs/handover/README.md
docs/handover/architecture.md
docs/handover/local-development.md
docs/handover/infrastructure.md
docs/handover/database.md
docs/handover/contracts.md
docs/handover/testing.md
docs/handover/deployment.md
docs/handover/troubleshooting.md
docs/handover/change-guide.md
```
