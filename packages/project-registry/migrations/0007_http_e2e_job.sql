-- Ephemeral HTTP end-to-end verification jobs (ADR 018).
--
-- Purely additive: the execution_jobs kind CHECK constraint is widened to admit HTTP_E2E. The
-- evidence reuses the existing artifacts table (VALIDATION_REPORT, suite HTTP_E2E), so no new
-- entity, column or index is required and no existing row is touched. Re-runnable: the constraint
-- is dropped by name only if present and recreated with the superset, which never rejects a row
-- that was already valid.
ALTER TABLE execution_jobs DROP CONSTRAINT IF EXISTS execution_jobs_kind_check;
ALTER TABLE execution_jobs ADD CONSTRAINT execution_jobs_kind_check
  CHECK (kind IN ('IMPLEMENTATION','TEST','VALIDATION','REPAIR','RECONCILIATION','REBASE','HTTP_E2E'));
