-- Phase 1 follow-up: PARTIAL_SUCCESS/UNVERIFIED were added to the Zod status enum for
-- execution_jobs (and admitted through admin_operations' jsonb data), but the Postgres
-- CHECK constraint on execution_jobs.status was never widened to admit them. Same
-- purely-additive pattern already used in 0005_task_rebase.sql for the kind constraint.
ALTER TABLE execution_jobs DROP CONSTRAINT IF EXISTS execution_jobs_status_check;
ALTER TABLE execution_jobs ADD CONSTRAINT execution_jobs_status_check
  CHECK (status IN ('QUEUED','DISPATCHING','DISPATCHED','CLAIMED','RUNNING','SUCCEEDED','FAILED','CANCELLED','TIMED_OUT','BLOCKED','PARTIAL_SUCCESS','UNVERIFIED'));

-- Heartbeat: a dedicated, indexable column so the watchdog can cheaply find stale RUNNING
-- jobs without scanning jsonb. Nullable and unbackfilled so existing rows and jobs that
-- predate this migration stay valid with no data migration required.
ALTER TABLE execution_jobs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
CREATE INDEX IF NOT EXISTS execution_jobs_heartbeat_idx ON execution_jobs(status, heartbeat_at);

-- A narrow, atomic heartbeat touch that only ever writes heartbeat_at (plus the matching
-- path inside the jsonb data blob) so it can never race with -- or clobber -- the much
-- larger writes the main execution flow makes to the same row (baseCommit, branch,
-- commitSha, status, ...). Mirrors the existing claim_execution_job function pattern.
CREATE OR REPLACE FUNCTION touch_execution_job_heartbeat(
  requested_job_id uuid,
  requested_project_id uuid,
  at timestamptz
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE execution_jobs
  SET heartbeat_at = at,
      data = jsonb_set(data, '{heartbeatAt}', to_jsonb(at)),
      updated_at = at
  WHERE id = requested_job_id AND project_id = requested_project_id;
$$;
REVOKE ALL ON FUNCTION touch_execution_job_heartbeat(uuid,uuid,timestamptz) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION touch_execution_job_heartbeat(uuid,uuid,timestamptz) FROM anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION touch_execution_job_heartbeat(uuid,uuid,timestamptz) FROM authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION touch_execution_job_heartbeat(uuid,uuid,timestamptz) TO service_role'; END IF;
END $$;

-- Per-step evidence, durable independently of the job's own row so a step that already
-- succeeded survives a hard kill of the worker process, and so the watchdog can record a
-- stale/recovered/presumed-dead episode as evidence without needing to touch job.status.
CREATE TABLE IF NOT EXISTS execution_checkpoints (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES execution_jobs(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  seq integer NOT NULL CHECK (seq >= 0),
  step text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(job_id, seq)
);
CREATE INDEX IF NOT EXISTS execution_checkpoints_job_idx ON execution_checkpoints(job_id, seq);
ALTER TABLE execution_checkpoints ENABLE ROW LEVEL SECURITY;
