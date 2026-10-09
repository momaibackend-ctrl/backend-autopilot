-- Rebase of an already-verified task onto the current base branch.
--
-- Purely additive: the execution_jobs kind CHECK constraint is widened to admit the new REBASE
-- job kind. Rebase reports reuse the existing artifacts table, so no new entity, column or index
-- is required and no existing row is touched.
--
-- Every deploy re-applies every migration in order, so this file runs again long after later
-- migrations widened the same constraint further. Unconditionally recreating it with this
-- migration's set would NARROW it back and fail on any row of a later kind (it did, once HTTP_E2E
-- jobs existed). It therefore acts only on the original constraint from 0002 -- present and not
-- yet admitting REBASE -- and leaves any wider or absent constraint to the migrations after it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'execution_jobs'::regclass
      AND conname = 'execution_jobs_kind_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%''REBASE''%'
  ) THEN
    ALTER TABLE execution_jobs DROP CONSTRAINT execution_jobs_kind_check;
    ALTER TABLE execution_jobs ADD CONSTRAINT execution_jobs_kind_check
      CHECK (kind IN ('IMPLEMENTATION','TEST','VALIDATION','REPAIR','RECONCILIATION','REBASE'));
  END IF;
END $$;
