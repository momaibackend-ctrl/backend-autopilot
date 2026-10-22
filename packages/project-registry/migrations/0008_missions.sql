-- Missions: product goals that outlive any one agent session (ADR 026).
--
-- Strictly additive: one new table, nothing existing is altered. A mission's progress is derived
-- from evidence on every read and never stored, so this table holds only the goal, its tasks and
-- its status. Repository roles live in the existing resources.data document and need no change.
--
-- Every deploy re-applies every migration, so every statement is IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS missions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  key text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','ACHIEVED','CANCELLED')),
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS missions_project_key_uq ON missions(project_id, key);
CREATE INDEX IF NOT EXISTS missions_project_idx ON missions(project_id);
ALTER TABLE missions ENABLE ROW LEVEL SECURITY;
