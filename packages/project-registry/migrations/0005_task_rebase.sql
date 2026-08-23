-- Rebase of an already-verified task onto the current base branch.
--
-- Purely additive: the execution_jobs kind CHECK constraint is widened to admit the new REBASE
-- job kind. Rebase reports reuse the existing artifacts table, so no new entity, column or index
-- is required and no existing row is touched. Re-runnable: the constraint is dropped by name only
-- if present and recreated with the superset, which never rejects a row that was already valid.
ALTER TABLE execution_jobs DROP CONSTRAINT IF EXISTS execution_jobs_kind_check;
ALTER TABLE execution_jobs ADD CONSTRAINT execution_jobs_kind_check
  CHECK (kind IN ('IMPLEMENTATION','TEST','VALIDATION','REPAIR','RECONCILIATION','REBASE'));
