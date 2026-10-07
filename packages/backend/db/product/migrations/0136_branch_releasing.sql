-- A release remains a live branch machine until verified capture and stop.
ALTER TABLE workspaces DROP CONSTRAINT workspaces_status_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_status_check CHECK
  (status IN ('pending','starting','running','releasing','suspended','stopped','failed'));
DROP INDEX uq_workspaces_active;
CREATE UNIQUE INDEX uq_workspaces_active
ON workspaces (repository_id, kind, target_bookmark, name)
WHERE parent_workspace_id IS NULL AND source_snapshot_id IS NULL
  AND agent_session_id IS NULL AND source_commit = '' AND deleted_at IS NULL
  AND status IN ('pending','starting','running','releasing','suspended');
