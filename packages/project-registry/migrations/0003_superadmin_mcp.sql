ALTER TABLE autopilot_operators
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'OPERATOR',
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE autopilot_operators DROP CONSTRAINT IF EXISTS autopilot_operators_role_check;
ALTER TABLE autopilot_operators ADD CONSTRAINT autopilot_operators_role_check
  CHECK (role IN ('OPERATOR','SUPERADMIN'));

ALTER TABLE autopilot_project_memberships
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS system_settings (
  key text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS console_screens (
  screen_id text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_operations (
  operation_id text PRIMARY KEY,
  actor text NOT NULL,
  tool text NOT NULL,
  project_id uuid REFERENCES projects(id),
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_operations_project_idx ON admin_operations(project_id);

ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_screens ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_operations ENABLE ROW LEVEL SECURITY;

INSERT INTO console_screens(screen_id,data,updated_at)
SELECT value->>'screenId',value,now()
FROM jsonb_array_elements('[
  {"screenId":"dashboard","navigationLabel":"Dashboard","title":"Dashboard","description":"System-wide delivery state","enabled":true,"navigationOrder":10,"blocks":[],"updatedAt":"2026-08-21T00:00:00.000Z","updatedBy":"migration-v0.5"},
  {"screenId":"projects","navigationLabel":"Projects","title":"Projects","description":"Registered project targets","enabled":true,"navigationOrder":20,"blocks":[],"updatedAt":"2026-08-21T00:00:00.000Z","updatedBy":"migration-v0.5"},
  {"screenId":"tasks","navigationLabel":"Tasks","title":"Tasks","description":"Task lifecycle and readiness gates","enabled":true,"navigationOrder":30,"blocks":[],"updatedAt":"2026-08-21T00:00:00.000Z","updatedBy":"migration-v0.5"},
  {"screenId":"runs","navigationLabel":"Runs","title":"Runs","description":"Reproducible execution history","enabled":true,"navigationOrder":40,"blocks":[],"updatedAt":"2026-08-21T00:00:00.000Z","updatedBy":"migration-v0.5"},
  {"screenId":"validation","navigationLabel":"Validation Center","title":"Validation Center","description":"Semantic validation suites and scenarios","enabled":true,"navigationOrder":50,"blocks":[],"updatedAt":"2026-08-21T00:00:00.000Z","updatedBy":"migration-v0.5"},
  {"screenId":"api-explorer","navigationLabel":"API Explorer","title":"API Explorer","description":"Persisted API contracts and request evidence","enabled":true,"navigationOrder":60,"blocks":[],"updatedAt":"2026-08-21T00:00:00.000Z","updatedBy":"migration-v0.5"},
  {"screenId":"database","navigationLabel":"Database","title":"Database","description":"Migrations, schema and policy evidence","enabled":true,"navigationOrder":70,"blocks":[],"updatedAt":"2026-08-21T00:00:00.000Z","updatedBy":"migration-v0.5"},
  {"screenId":"infrastructure","navigationLabel":"Infrastructure","title":"Infrastructure","description":"Registered provider resources","enabled":true,"navigationOrder":80,"blocks":[],"updatedAt":"2026-08-21T00:00:00.000Z","updatedBy":"migration-v0.5"},
  {"screenId":"artifacts","navigationLabel":"Artifacts","title":"Artifacts","description":"Immutable and tombstoned evidence","enabled":true,"navigationOrder":90,"blocks":[],"updatedAt":"2026-08-21T00:00:00.000Z","updatedBy":"migration-v0.5"},
  {"screenId":"audit","navigationLabel":"Audit","title":"Audit","description":"Append-only trust trail","enabled":true,"navigationOrder":100,"blocks":[],"updatedAt":"2026-08-21T00:00:00.000Z","updatedBy":"migration-v0.5"},
  {"screenId":"capabilities","navigationLabel":"Capabilities","title":"Capabilities","description":"Evidence-based provider support","enabled":true,"navigationOrder":110,"blocks":[],"updatedAt":"2026-08-21T00:00:00.000Z","updatedBy":"migration-v0.5"},
  {"screenId":"settings","navigationLabel":"Settings","title":"Settings","description":"Policy-controlled runtime configuration","enabled":true,"navigationOrder":120,"blocks":[],"updatedAt":"2026-08-21T00:00:00.000Z","updatedBy":"migration-v0.5"}
]'::jsonb) AS value
ON CONFLICT (screen_id) DO NOTHING;

INSERT INTO system_settings(key,data,updated_at) VALUES
('safety.production_writes', '{"key":"safety.production_writes","value":"NOT_SUPPORTED","description":"Hard platform invariant","visibility":"PUBLIC","updatedAt":"2026-08-21T00:00:00.000Z","updatedBy":"migration-v0.5"}'::jsonb, now()),
('execution.max_auto_repair_attempts', '{"key":"execution.max_auto_repair_attempts","value":3,"description":"Maximum bounded repair attempts","visibility":"OPERATOR","updatedAt":"2026-08-21T00:00:00.000Z","updatedBy":"migration-v0.5"}'::jsonb, now())
ON CONFLICT (key) DO NOTHING;
