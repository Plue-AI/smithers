-- Existing installations can prebuild these indexes concurrently before migration.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_log_retention ON workflow_runs (completed_at, id)
 WHERE status IN ('success', 'failure', 'cancelled');
CREATE INDEX IF NOT EXISTS idx_workflow_logs_retention ON workflow_logs (workflow_run_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_workflow_run_logs_retention ON workflow_run_logs (workflow_run_id, created_at, id);
