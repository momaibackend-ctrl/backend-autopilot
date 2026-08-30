-- Canonical Development Repository: which registered repository is a project's single source of
-- further development.
--
-- Strictly additive. No existing table, column, index or row is altered, so every historical
-- project, resource, task, job, run and artifact stays exactly as it was and remains readable. A
-- project with no binding is the normal state until someone explicitly promotes one, and every
-- workflow that predates this table keeps working unchanged because absence is not an error.
--
-- Re-runnable: every statement is IF NOT EXISTS / CREATE OR REPLACE.

CREATE TABLE IF NOT EXISTS canonical_development_repositories (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  resource_id uuid NOT NULL REFERENCES resources(id),
  status text NOT NULL CHECK (status IN ('CANDIDATE','ACTIVE','SUPERSEDED','ROLLED_BACK')),
  version integer NOT NULL CHECK (version >= 1),
  operation_id text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

-- THE invariant, held by the database rather than by an application read/check/write. Two
-- concurrent promotions cannot both produce an ACTIVE binding no matter how their transactions
-- interleave: the second INSERT violates this index and is rejected.
CREATE UNIQUE INDEX IF NOT EXISTS canonical_repo_one_active_uq
  ON canonical_development_repositories(project_id) WHERE status = 'ACTIVE';
-- Versions are the optimistic-locking token, so they must be unique per project as well.
CREATE UNIQUE INDEX IF NOT EXISTS canonical_repo_version_uq
  ON canonical_development_repositories(project_id, version);
-- Replaying one logical promotion must never create a second binding row.
CREATE UNIQUE INDEX IF NOT EXISTS canonical_repo_operation_uq
  ON canonical_development_repositories(operation_id);
CREATE INDEX IF NOT EXISTS canonical_repo_project_idx
  ON canonical_development_repositories(project_id);

ALTER TABLE canonical_development_repositories ENABLE ROW LEVEL SECURITY;

-- The single atomic replacement primitive. Both promotion and metadata rollback call it; they
-- differ only in what the displaced binding becomes. It locks the current ACTIVE row before
-- checking the caller's expected id/version, so a stale plan loses the race deterministically
-- instead of overwriting a promotion that landed in between.
CREATE OR REPLACE FUNCTION promote_canonical_repository(
  p_project_id uuid,
  p_record jsonb,
  p_expected_id uuid,
  p_expected_version integer,
  p_displaced_status text,
  p_displaced_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  current_row canonical_development_repositories%ROWTYPE;
  displaced jsonb := NULL;
BEGIN
  IF p_displaced_status NOT IN ('SUPERSEDED','ROLLED_BACK') THEN
    RAISE EXCEPTION 'Invalid displaced status %', p_displaced_status USING ERRCODE = 'PT400';
  END IF;

  SELECT * INTO current_row
  FROM canonical_development_repositories
  WHERE project_id = p_project_id AND status = 'ACTIVE'
  FOR UPDATE;

  IF p_expected_id IS NULL THEN
    IF FOUND THEN
      RAISE EXCEPTION 'Project already has an ACTIVE canonical repository' USING ERRCODE = 'PT409';
    END IF;
  ELSE
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Expected an ACTIVE canonical repository that no longer exists' USING ERRCODE = 'PT409';
    END IF;
    IF current_row.id <> p_expected_id OR current_row.version <> p_expected_version THEN
      RAISE EXCEPTION 'Canonical repository changed since the plan was generated' USING ERRCODE = 'PT409';
    END IF;
  END IF;

  IF current_row.id IS NOT NULL THEN
    displaced := current_row.data
      || jsonb_build_object(
           'status', p_displaced_status,
           'supersededBy', p_record->>'id',
           'supersededAt', to_char(p_displaced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'updatedAt', to_char(p_displaced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         );
    UPDATE canonical_development_repositories
    SET status = p_displaced_status, data = displaced, updated_at = p_displaced_at
    WHERE id = current_row.id;
  END IF;

  INSERT INTO canonical_development_repositories(
    id, project_id, resource_id, status, version, operation_id, data, created_at, updated_at
  ) VALUES (
    (p_record->>'id')::uuid,
    (p_record->>'projectId')::uuid,
    (p_record->>'resourceId')::uuid,
    p_record->>'status',
    (p_record->>'version')::integer,
    p_record->>'operationId',
    p_record,
    (p_record->>'createdAt')::timestamptz,
    (p_record->>'updatedAt')::timestamptz
  );

  RETURN jsonb_build_object('active', p_record, 'displaced', displaced);
END;
$$;
