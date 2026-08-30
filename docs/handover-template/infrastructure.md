# Infrastructure and access inventory

> **Template.** Replace every `<…>` with a fact about this project.
>
> **Never invent an entry here.** Every row carries an explicit status, and an honest
> `REQUIRES_OPERATOR_SETUP` is worth more to a new developer than a plausible-sounding endpoint that
> does not exist.

Status vocabulary — use exactly these words:

| Status | Meaning |
| --- | --- |
| `VERIFIED` | An operator confirmed this works, on the date given |
| `REQUIRES_OPERATOR_SETUP` | It is required; nobody has provisioned or granted it yet |
| `UNAVAILABLE` | It cannot currently be provided |
| `NOT_APPLICABLE` | This project does not need it |
| `UNVERIFIED` | Nobody has checked |

## Environments

| Environment | Purpose | Status | Verified on |
| --- | --- | --- | --- |
| Local | Developer laptop, throwaway containers | `VERIFIED` | `<date>` |
| `<staging>` | `<purpose>` | `REQUIRES_OPERATOR_SETUP` | — |
| `<production>` | `<purpose>` | `<status>` | `<date or —>` |

## Services

| Service | Provider | Environment | Status | Notes |
| --- | --- | --- | --- | --- |
| `<PostgreSQL>` | `<provider>` | `<env>` | `<status>` | `<notes>` |
| `<Redis>` | `<provider>` | `<env>` | `<status>` | `<notes>` |
| `<Object storage>` | `<provider>` | `<env>` | `<status>` | `<notes>` |

## Access a new developer needs

| Access | Granted by | Status |
| --- | --- | --- |
| Repository (write) | `<owner>` | `REQUIRES_OPERATOR_SETUP` |
| CI logs | `<owner>` | `REQUIRES_OPERATOR_SETUP` |
| `<staging environment>` | `<owner>` | `REQUIRES_OPERATOR_SETUP` |
| `<observability dashboard>` | `<owner>` | `REQUIRES_OPERATOR_SETUP` |

## Configuration and secrets

Names only. **No values in this repository, ever.** A value belongs in the destination system's
secret store, and it gets there by an operator putting it there.

| Name | Purpose | Consumer | Environment | Required | Destination | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `<DATABASE_URL>` | `<primary datastore>` | `<service>` | `<env>` | Required | `<secret store>` | `<owner>` | `REQUIRES_OPERATOR_SETUP` |
| `<REDIS_URL>` | `<cache/queue>` | `<service>` | `<env>` | Required | `<secret store>` | `<owner>` | `REQUIRES_OPERATOR_SETUP` |

Local development needs none of these from anybody: `.env.example` plus `docker compose up -d`
covers it. See [local-development.md](./local-development.md).

## Not carried by Git

Cloning this repository does **not** bring any of the following. Each has to be granted or created
in the destination:

- CI secret *values* (the workflow definitions travel; their secrets do not)
- Branch protection rules
- Workload identity federation / IAM bindings
- Cloud accounts and projects
- Database credentials
- Hosted environment configuration
