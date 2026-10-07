-- Retain the workspace and branch history after reclaiming its runtime.
ALTER TABLE workspaces
    ADD COLUMN branch_archived_at timestamptz,
    ADD COLUMN cleanup_pending_head text NOT NULL DEFAULT '',
    ADD COLUMN cleanup_pending_capture_id text NOT NULL DEFAULT '',
    ADD COLUMN disk_reclaimed_at timestamptz;
