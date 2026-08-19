# ADR 007: Dockerless durable bootstrap

Status: accepted. Before an external PostgreSQL control plane exists, state is persisted in a secret-free `.autopilot/state.json`. When `DATABASE_URL` is configured, runtime uses PostgreSQL. Docker Compose is an optional provider, never a bootstrap requirement.
