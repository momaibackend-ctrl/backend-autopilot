# ADR 003: PostgreSQL control-plane state

Status: accepted. PostgreSQL stores durable JSONB domain envelopes plus relational identity/ownership/index columns. It preserves schema evolution flexibility while enforcing project-scoped queries and append-only audit. In-memory storage is test/diagnostic only.
