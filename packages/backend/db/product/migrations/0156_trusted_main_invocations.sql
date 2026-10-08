-- Stored server authority for manual main runs; legacy invocations stay untrusted.
ALTER TABLE workflow_run_flow_invocations
    ADD COLUMN manual_credential jsonb,
    ADD COLUMN background_workspace_id uuid REFERENCES workspaces(id),
    ADD COLUMN trusted_main_revision text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX workflow_invocation_background_machine
    ON workflow_run_flow_invocations(background_workspace_id)
    WHERE background_workspace_id IS NOT NULL;
