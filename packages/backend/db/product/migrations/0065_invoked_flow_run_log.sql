-- An invoked run shows its Flow in the run's step and log surface: one step
-- for the flow, and the journal cursor through which its events are logged,
-- so a re-delivered observation page is never logged twice.
ALTER TABLE workflow_run_flow_invocations
    ADD COLUMN workflow_step_id BIGINT REFERENCES workflow_steps(id) ON DELETE SET NULL,
    ADD COLUMN log_cursor TEXT NOT NULL DEFAULT '';
