-- The mythical snapshot sums each item's metered cost by its lane workspaces
-- (mythical_lanes.workspace_id) on every read; without this every read scans
-- the repository's whole usage history.
CREATE INDEX idx_model_usage_workspace ON model_usage (workspace_id) WHERE workspace_id IS NOT NULL;
