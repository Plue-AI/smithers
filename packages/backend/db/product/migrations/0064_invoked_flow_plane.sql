-- InvokeWorkflow runs a repository flow through the canonical Flow runtime
-- (flowdispatch), not a whole-workflow VM. Its runs live on the flow plane,
-- which the sandbox scheduler never claims.
ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_execution_plane_check;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_execution_plane_check
    CHECK (execution_plane IN ('runner', 'sandbox', 'agent', 'flow'));

-- Nothing reads workflow_invocations: it only recorded the retired
-- smithers-orchestrator 0.28 drain identity for old sandbox runs.
DROP TABLE workflow_invocations;

-- One invocation per flow-plane run: the person who invoked it, the Flow
-- launch that runs it, and the box its host selected.
CREATE TABLE workflow_run_flow_invocations (
    workflow_run_id BIGINT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    flow_id TEXT NOT NULL CHECK (flow_id <> ''),
    operation_id TEXT NOT NULL CHECK (operation_id <> ''),
    workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_workflow_run_flow_invocations_user ON workflow_run_flow_invocations (user_id);
