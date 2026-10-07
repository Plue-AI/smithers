-- Preserve the step instance at admission; retries never reattribute old calls.
-- History outlives workflow row deletion, as existing run/repository bindings do.
ALTER TABLE model_usage ADD COLUMN workflow_step_id bigint CHECK (workflow_step_id > 0);
CREATE INDEX idx_model_usage_run_step ON model_usage (workflow_run_id, workflow_step_id)
    WHERE workflow_step_id IS NOT NULL;
