-- Product queries extracted from the transitional Plue source.

-- name: HasWritableWorkspaceShares :one
SELECT EXISTS (
    SELECT 1 FROM workspace_shares
    WHERE workspace_id = sqlc.arg(workspace_id)::uuid AND level = 'write'
);

-- WorkspaceSoleWriter answers whether a workspace is one person's alone: their
-- own with no write share, or a branch machine the install's machine service
-- owns whose only write share is theirs. A box's coding host holds that
-- person's repository credential only then (no other writer could read it).
-- name: WorkspaceSoleWriter :one
SELECT EXISTS (
    SELECT 1 FROM workspaces w
    WHERE w.id = sqlc.arg(workspace_id)::uuid AND w.deleted_at IS NULL
      AND (
        (w.user_id = sqlc.arg(user_id)::bigint AND NOT EXISTS (
            SELECT 1 FROM workspace_shares s WHERE s.workspace_id = w.id AND s.level = 'write'))
        OR (w.user_id IN (
              SELECT u.id FROM users u WHERE u.lower_username = 'smithers-machines'
                AND u.user_type = 'service' AND u.prohibit_login AND u.deleted_at IS NULL)
            AND EXISTS (
              SELECT 1 FROM workspace_shares s WHERE s.workspace_id = w.id AND s.level = 'write'
                AND s.grantee_user_id = sqlc.arg(user_id)::bigint)
            AND NOT EXISTS (
              SELECT 1 FROM workspace_shares s WHERE s.workspace_id = w.id AND s.level = 'write'
                AND s.grantee_user_id <> sqlc.arg(user_id)::bigint))
      )
);
