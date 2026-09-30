-- name: LockWorkspaceShareForMutation :one
-- Returns a grantee's share level on a live workspace and holds the share row
-- (and the workspace key) until the caller's transaction ends. A mutation runs
-- inside that transaction, so a revocation, demotion or hard delete waits for
-- it, and a mutation that starts after the change no longer finds the grant.
SELECT ws.level
FROM workspaces w
JOIN workspace_shares ws ON ws.workspace_id = w.id
WHERE w.id = sqlc.arg(workspace_id)::uuid
  AND ws.grantee_user_id = sqlc.arg(grantee_user_id)::bigint
  AND w.deleted_at IS NULL
FOR KEY SHARE OF w
FOR SHARE OF ws;
