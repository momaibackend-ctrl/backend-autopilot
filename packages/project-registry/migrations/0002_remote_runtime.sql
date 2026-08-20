CREATE TABLE IF NOT EXISTS execution_jobs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  resource_id uuid NOT NULL REFERENCES resources(id),
  run_id uuid REFERENCES runs(id),
  operation_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('IMPLEMENTATION','TEST','VALIDATION','REPAIR','RECONCILIATION')),
  status text NOT NULL CHECK (status IN ('QUEUED','DISPATCHING','DISPATCHED','CLAIMED','RUNNING','SUCCEEDED','FAILED','CANCELLED','TIMED_OUT','BLOCKED')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  workflow_run_id text,
  lease_owner text,
  lease_expires_at timestamptz,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(project_id, operation_id)
);
CREATE INDEX IF NOT EXISTS execution_jobs_task_idx ON execution_jobs(task_id);
CREATE INDEX IF NOT EXISTS execution_jobs_status_idx ON execution_jobs(status);
CREATE INDEX IF NOT EXISTS execution_jobs_lease_idx ON execution_jobs(lease_expires_at);

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES runs(id);
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'AVAILABLE';
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS storage_bucket text;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS storage_path text;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS byte_size bigint;

CREATE TABLE IF NOT EXISTS migration_markers (
  key text PRIMARY KEY,
  checksum text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    EXECUTE $bucket$
      INSERT INTO storage.buckets (id, name, public, file_size_limit)
      VALUES ('autopilot-artifacts', 'autopilot-artifacts', false, 52428800)
      ON CONFLICT (id) DO UPDATE SET public=false, file_size_limit=EXCLUDED.file_size_limit
    $bucket$;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS autopilot_operators (
  user_id uuid PRIMARY KEY,
  email text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF to_regclass('auth.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='autopilot_operators_user_id_fkey'
  ) THEN
    ALTER TABLE autopilot_operators ADD CONSTRAINT autopilot_operators_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS autopilot_project_memberships (
  user_id uuid NOT NULL REFERENCES autopilot_operators(user_id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('VIEWER','OPERATOR','ADMIN')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, project_id)
);

CREATE OR REPLACE FUNCTION claim_execution_job(
  requested_job_id uuid,
  requested_owner text,
  lease_seconds integer DEFAULT 900
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  selected execution_jobs%ROWTYPE;
  updated_data jsonb;
BEGIN
  IF requested_owner IS NULL OR length(requested_owner) < 3 THEN
    RAISE EXCEPTION 'lease owner is required';
  END IF;
  SELECT * INTO selected
  FROM execution_jobs
  WHERE id = requested_job_id
    AND status IN ('QUEUED','DISPATCHED','CLAIMED')
    AND (lease_expires_at IS NULL OR lease_expires_at <= now() OR lease_owner = requested_owner)
  FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(selected.task_id::text, 0));
  IF EXISTS (
    SELECT 1 FROM execution_jobs active
    WHERE active.task_id=selected.task_id
      AND active.id<>selected.id
      AND active.status IN ('CLAIMED','RUNNING')
      AND active.lease_expires_at>now()
  ) THEN RETURN NULL; END IF;
  updated_data := selected.data || jsonb_build_object(
    'status','CLAIMED',
    'leaseOwner',requested_owner,
    'leaseExpiresAt',(now() + make_interval(secs => lease_seconds)),
    'startedAt',COALESCE(selected.data->>'startedAt', now()::text),
    'updatedAt',now()
  );
  UPDATE execution_jobs SET
    status='CLAIMED', lease_owner=requested_owner,
    lease_expires_at=now() + make_interval(secs => lease_seconds),
    data=updated_data, updated_at=now()
  WHERE id=requested_job_id;
  RETURN updated_data;
END $$;

REVOKE ALL ON FUNCTION claim_execution_job(uuid,text,integer) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION claim_execution_job(uuid,text,integer) FROM anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION claim_execution_job(uuid,text,integer) FROM authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION claim_execution_job(uuid,text,integer) TO service_role'; END IF;
END $$;

CREATE OR REPLACE FUNCTION transition_task_atomic(task_data jsonb, transition_data jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE requested_project_id uuid; requested_task_id uuid;
BEGIN
  requested_project_id := (task_data->>'projectId')::uuid;
  requested_task_id := (task_data->>'id')::uuid;
  IF requested_task_id <> (transition_data->>'taskId')::uuid THEN RAISE EXCEPTION 'task transition identity mismatch'; END IF;
  UPDATE tasks SET data=task_data WHERE id=requested_task_id AND project_id=requested_project_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'task not found'; END IF;
  INSERT INTO task_transitions(id,task_id,data,created_at) VALUES ((transition_data->>'id')::uuid,requested_task_id,transition_data,(transition_data->>'timestamp')::timestamptz);
  RETURN task_data;
END $$;
REVOKE ALL ON FUNCTION transition_task_atomic(jsonb,jsonb) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION transition_task_atomic(jsonb,jsonb) FROM anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION transition_task_atomic(jsonb,jsonb) FROM authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION transition_task_atomic(jsonb,jsonb) TO service_role'; END IF;
END $$;

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_project_memberships ENABLE ROW LEVEL SECURITY;

-- State is intentionally unavailable through the browser-facing anon/authenticated
-- PostgREST roles. Authenticated access crosses the Edge API, which validates the
-- JWT and membership before using its service-role connection.
