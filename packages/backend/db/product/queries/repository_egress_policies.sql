-- name: GetRepositoryEgressPolicy :one
SELECT *
FROM repository_egress_policies
WHERE repository_id = $1;

-- name: PatchRepositoryEgressPolicy :one
-- Adds and removes hosts in one statement: the row lock of ON CONFLICT makes
-- overlapping writers apply one after the other, so neither loses the
-- other's change. The list stays deduplicated and sorted byte-wise. A result
-- longer than max_domains writes nothing and returns no row.
INSERT INTO repository_egress_policies AS p (repository_id, allow_domains, updated_by)
SELECT sqlc.arg(repository_id), fresh.domains, sqlc.narg(updated_by)
FROM (
    SELECT ARRAY(
        SELECT DISTINCT d COLLATE "C" FROM unnest(COALESCE(sqlc.arg(add_domains)::text[], '{}')) AS d
        WHERE NOT d = ANY(COALESCE(sqlc.arg(remove_domains)::text[], '{}'))
        ORDER BY d COLLATE "C"
    )::text[] AS domains
) fresh
WHERE cardinality(fresh.domains) <= sqlc.arg(max_domains)::int
ON CONFLICT (repository_id)
DO UPDATE SET
    allow_domains = ARRAY(
        SELECT DISTINCT d COLLATE "C" FROM unnest(p.allow_domains || EXCLUDED.allow_domains) AS d
        WHERE NOT d = ANY(COALESCE(sqlc.arg(remove_domains)::text[], '{}'))
        ORDER BY d COLLATE "C"
    )::text[],
    updated_by = EXCLUDED.updated_by,
    updated_at = NOW()
WHERE cardinality(ARRAY(
    SELECT DISTINCT d FROM unnest(p.allow_domains || EXCLUDED.allow_domains) AS d
    WHERE NOT d = ANY(COALESCE(sqlc.arg(remove_domains)::text[], '{}'))
)) <= sqlc.arg(max_domains)::int
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
