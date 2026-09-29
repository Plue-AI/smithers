-- name: SetWorkspaceServicePublic :exec
INSERT INTO workspace_service_previews (workspace_id, port, public)
VALUES ($1, $2, $3)
ON CONFLICT (workspace_id, port) DO UPDATE SET public = EXCLUDED.public;

-- name: WorkspaceServicePublic :one
SELECT EXISTS (SELECT 1 FROM workspace_service_previews WHERE workspace_id = $1 AND port = $2 AND public);

-- name: AuthorizePublicWorkspaceService :one
SELECT EXISTS (
    SELECT 1 FROM workspace_service_previews p
    JOIN workspaces w ON w.id = p.workspace_id
    JOIN users u ON u.id = w.user_id
    WHERE p.workspace_id = $1 AND p.port = $2 AND p.public AND w.deleted_at IS NULL
      AND u.is_active AND NOT u.prohibit_login AND u.deleted_at IS NULL
);
