-- Executable HTTP validation runner.
--
-- Scenario definitions and scenario execution results reuse the existing artifacts table
-- (VALIDATION_SCENARIO / VALIDATION_REPORT), so no new entity, column or constraint is
-- required and no existing data is touched. The runner does add a hot read path -- "every
-- scenario / every validation result for this project" -- that previously scanned all of a
-- project's artifacts. This migration is purely additive and re-runnable: it creates the
-- supporting index only, with no destructive statement of any kind.
CREATE INDEX IF NOT EXISTS artifacts_project_kind_idx ON artifacts(project_id, kind);
