-- Ephemeral HTTP end-to-end verification jobs (ADR 018).
--
-- Purely additive: the execution_jobs kind CHECK constraint is widened to admit HTTP_E2E. The
-- evidence reuses the existing artifacts table (VALIDATION_REPORT, suite HTTP_E2E), so no new
-- entity, column or index is required and no existing row is touched.
--
-- Every deploy re-applies every migration, so this file must never narrow a constraint a later
-- migration widened: it acts only when the current constraint does not yet admit HTTP_E2E (or is
-- absent), and then installs the full superset, which never rejects a row that was valid before.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'execution_jobs'::regclass
      AND conname = 'execution_jobs_kind_check'
      AND pg_get_constraintdef(oid) LIKE '%''HTTP_E2E''%'
  ) THEN
    ALTER TABLE execution_jobs DROP CONSTRAINT IF EXISTS execution_jobs_kind_check;
    ALTER TABLE execution_jobs ADD CONSTRAINT execution_jobs_kind_check
      CHECK (kind IN ('IMPLEMENTATION','TEST','VALIDATION','REPAIR','RECONCILIATION','REBASE','HTTP_E2E'));
  END IF;
END $$;
