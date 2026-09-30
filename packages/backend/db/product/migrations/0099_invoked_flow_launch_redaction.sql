-- An invoked run keeps the exact secret values its launch injected, sealed
-- like stored secrets, so its log masks them after the secret rotates or is
-- deleted. The column lives and dies with the run's invocation row.
ALTER TABLE workflow_run_flow_invocations
    ADD COLUMN launch_redaction TEXT NOT NULL DEFAULT '';
