-- Product queries extracted from the transitional Plue source.

-- name: HasWritableWorkspaceShares :one
SELECT EXISTS (
    SELECT 1 FROM workspace_shares
    WHERE workspace_id = sqlc.arg(workspace_id)::uuid AND level = 'write'
);
