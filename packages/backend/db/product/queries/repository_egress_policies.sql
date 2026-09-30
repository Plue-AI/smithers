-- name: GetRepositoryEgressPolicy :one
SELECT *
FROM repository_egress_policies
WHERE repository_id = $1;

-- name: UpsertRepositoryEgressPolicy :one
INSERT INTO repository_egress_policies (repository_id, allow_domains, updated_by)
VALUES (sqlc.arg(repository_id), sqlc.arg(allow_domains)::text[], sqlc.narg(updated_by))
ON CONFLICT (repository_id)
DO UPDATE SET
    allow_domains = EXCLUDED.allow_domains,
    updated_by = EXCLUDED.updated_by,
    updated_at = NOW()
RETURNING *;

-- name: ListRepositoryLiveSandboxIDs :many
-- The sandboxes of a repository whose egress proxy may be running and was
-- created from the repository's policy: its running workspaces and the VMs
-- of its agent sessions' live workflow tasks.
SELECT DISTINCT sandbox_id::text
FROM (
    SELECT w.vm_id AS sandbox_id
    FROM workspaces w
    WHERE w.repository_id = sqlc.arg(repository_id)
      AND w.status = 'running'
      AND w.vm_id <> ''
      AND w.deleted_at IS NULL
    UNION
    SELECT t.vm_id AS sandbox_id
    FROM workflow_tasks t
    JOIN agent_sessions s ON s.workflow_run_id = t.workflow_run_id
    WHERE t.repository_id = sqlc.arg(repository_id)
      AND t.status IN ('assigned', 'running')
      AND COALESCE(t.vm_id, '') <> ''
) live
ORDER BY sandbox_id;
