-- name: TryLockWorkspaceProvisioning :one
-- Transaction-scoped ownership is released on an API crash, not on row age.
SELECT pg_try_advisory_xact_lock(hashtextextended('workspace-provision:' || sqlc.arg(workspace_id)::text, 0))::boolean AS acquired;

-- name: ListWorkspaceProvisioningRecovery :many
SELECT w.id, w.repository_id, w.user_id, w.target_bookmark,
       COALESCE(u.username, o.name, '')::text AS repository_owner,
       r.name AS repository_name
FROM workspaces w
JOIN repositories r ON r.id = w.repository_id
LEFT JOIN users u ON u.id = r.user_id
LEFT JOIN organizations o ON o.id = r.org_id
WHERE w.deleted_at IS NULL AND (w.status IN ('pending','starting')
 OR (w.status='running' AND EXISTS (SELECT 1 FROM workspace_sessions s WHERE s.workspace_id=w.id AND s.status IN ('pending','starting'))))
-- Older API replicas do not hold ownership locks. Allow their bounded
-- ten-minute attempt to finish during the first rolling upgrade.
AND (w.status='running' OR w.updated_at < now()-interval '10 minutes')
-- A child workspace boots only through its batch, never a credentialed recovery.
AND NOT EXISTS (SELECT 1 FROM workspace_children c WHERE c.workspace_id=w.id)
ORDER BY w.updated_at, w.id
LIMIT 100;

-- name: CompletePendingWorkspaceSessions :many
UPDATE workspace_sessions s SET status='running', updated_at=now()
FROM workspaces w
WHERE s.workspace_id=w.id AND w.id=sqlc.arg(workspace_id)::uuid
  AND w.status='running' AND w.deleted_at IS NULL
  AND s.status IN ('pending','starting')
RETURNING s.id;
