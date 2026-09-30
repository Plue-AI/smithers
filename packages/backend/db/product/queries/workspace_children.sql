-- #2802: child workspaces fanned out from one snapshot of a running parent.

-- name: LockUserForWorkspaceChildren :one
-- Serializes one user's child admissions so the live count cannot race.
SELECT id FROM users WHERE id = sqlc.arg(user_id) FOR UPDATE;

-- name: GetWorkspaceChildParentForUpdate :one
SELECT *
FROM workspaces
WHERE id = sqlc.arg(id)
  AND deleted_at IS NULL
FOR UPDATE;

-- name: IsWorkspaceChild :one
SELECT EXISTS (SELECT 1 FROM workspace_children WHERE workspace_id = sqlc.arg(workspace_id));

-- name: CountLiveWorkspaceChildren :one
SELECT COUNT(*)
FROM workspace_children
WHERE user_id = sqlc.arg(user_id)
  AND stopped_at IS NULL;

-- name: CreateWorkspaceChildBatch :one
INSERT INTO workspace_child_batches (parent_workspace_id, user_id, profile, requested, expires_at)
VALUES (sqlc.arg(parent_workspace_id), sqlc.arg(user_id), sqlc.arg(profile), sqlc.arg(requested), sqlc.arg(expires_at))
RETURNING *;

-- name: ReserveWorkspaceChildren :exec
-- Written before the workspace rows (the foreign key is deferred) so the
-- quota trigger sees each row as a child.
INSERT INTO workspace_children (workspace_id, batch_id, user_id, ordinal)
SELECT gen_random_uuid(), b.id, b.user_id, ordinal
FROM workspace_child_batches b
CROSS JOIN generate_series(0, b.requested - 1) AS ordinal
WHERE b.id = sqlc.arg(batch_id);

-- name: CreateWorkspaceChildRows :many
-- A child copies its parent's repository, bookmark, kind and environment. It
-- has no idle timeout of its own: the child reaper stops it when idle.
INSERT INTO workspaces (
    id, repository_id, user_id, name, is_fork, parent_workspace_id, target_bookmark, kind,
    environment_source, environment_revision, environment_closure_hash, environment_image,
    status, idle_timeout_secs
)
SELECT c.workspace_id, p.repository_id, p.user_id,
       'child-' || left(b.id::text, 8) || '-' || c.ordinal::text,
       TRUE, p.id, p.target_bookmark, p.kind,
       p.environment_source, p.environment_revision, p.environment_closure_hash, p.environment_image,
       'starting', 0
FROM workspace_children c
JOIN workspace_child_batches b ON b.id = c.batch_id
JOIN workspaces p ON p.id = b.parent_workspace_id
WHERE c.batch_id = sqlc.arg(batch_id)
ORDER BY c.ordinal
RETURNING *;

-- name: SetWorkspaceChildBatchSnapshot :exec
UPDATE workspace_child_batches
SET snapshot_id = sqlc.arg(snapshot_id)
WHERE id = sqlc.arg(id);

-- name: StartWorkspaceChild :execrows
-- Registers a booted child. Zero rows means the child was stopped while it
-- booted, and the caller deletes the machine it created.
WITH started AS (
    UPDATE workspaces
    SET vm_id = sqlc.arg(vm_id), status = 'running', started_at = now(),
        last_activity_at = now(), updated_at = now()
    WHERE id = sqlc.arg(workspace_id)
      AND status = 'starting'
      AND deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM workspace_children c WHERE c.workspace_id = sqlc.arg(workspace_id) AND c.stopped_at IS NULL)
    RETURNING id
)
UPDATE workspace_children c
SET vm_id = sqlc.arg(vm_id), started_at = now()
FROM started
WHERE c.workspace_id = started.id;

-- name: StopWorkspaceChild :one
-- Closes a child's receipt once and tombstones its workspace. Returns the
-- machine the child held at that moment; no row means it was already stopped.
WITH receipt AS (
    UPDATE workspace_children
    SET stopped_at = now(), stop_reason = sqlc.arg(stop_reason)::text,
        failure_message = sqlc.narg(failure_message)
    WHERE workspace_id = sqlc.arg(workspace_id)
      AND stopped_at IS NULL
    RETURNING workspace_id
)
UPDATE workspaces w
SET status = CASE WHEN sqlc.arg(stop_reason)::text = 'failed' OR w.status = 'failed' THEN 'failed' ELSE 'stopped' END,
    failure_code = CASE WHEN sqlc.arg(stop_reason)::text = 'failed' THEN COALESCE(w.failure_code, 'child_provision_failed') ELSE w.failure_code END,
    failure_message = COALESCE(sqlc.narg(failure_message), w.failure_message),
    deleted_at = COALESCE(w.deleted_at, now()),
    updated_at = now()
FROM receipt
WHERE w.id = receipt.workspace_id
RETURNING w.vm_id;

-- name: ListWorkspaceChildOrdinals :many
SELECT workspace_id, ordinal
FROM workspace_children
WHERE batch_id = sqlc.arg(batch_id)
ORDER BY ordinal;

-- name: ListWorkspaceChildReceipts :many
SELECT c.workspace_id, c.batch_id, c.ordinal, c.vm_id, c.started_at, c.stopped_at,
       c.stop_reason, c.failure_message, b.profile, b.snapshot_id, b.expires_at, w.status
FROM workspace_children c
JOIN workspace_child_batches b ON b.id = c.batch_id
JOIN workspaces w ON w.id = c.workspace_id
WHERE b.parent_workspace_id = sqlc.arg(parent_workspace_id)
ORDER BY b.created_at, b.id, c.ordinal;

-- name: ListReapableWorkspaceChildren :many
-- Live children that must stop, and why: their parent stopped, they stopped
-- themselves, their batch expired, they never booted, or they went idle.
SELECT workspace_id, vm_id, reason::text AS reason
FROM (
    SELECT c.workspace_id, w.vm_id, c.created_at,
        CASE
            WHEN p.id IS NULL OR p.deleted_at IS NOT NULL OR p.status <> 'running' THEN 'parent_stopped'
            WHEN w.status = 'failed' THEN 'failed'
            WHEN w.deleted_at IS NOT NULL OR w.status IN ('suspended', 'stopped') THEN 'requested'
            WHEN b.expires_at <= now() THEN 'expired'
            WHEN w.status IN ('pending', 'starting') AND w.vm_id = ''
                AND c.created_at < now() - make_interval(secs => sqlc.arg(abandon_after_secs)::int) THEN 'abandoned'
            WHEN w.status = 'running'
                AND w.last_activity_at < now() - make_interval(secs => sqlc.arg(idle_after_secs)::int) THEN 'idle'
        END AS reason
    FROM workspace_children c
    JOIN workspace_child_batches b ON b.id = c.batch_id
    JOIN workspaces w ON w.id = c.workspace_id
    LEFT JOIN workspaces p ON p.id = b.parent_workspace_id
    WHERE c.stopped_at IS NULL
      AND (sqlc.narg(parent_workspace_id)::uuid IS NULL OR b.parent_workspace_id = sqlc.narg(parent_workspace_id)::uuid)
) candidates
WHERE reason IS NOT NULL
ORDER BY created_at, workspace_id
LIMIT sqlc.arg(max_rows);

-- name: ListDrainedWorkspaceChildSnapshots :many
-- Batch snapshots no live child still boots from.
SELECT b.id, b.snapshot_id
FROM workspace_child_batches b
WHERE b.snapshot_id <> ''
  AND b.snapshot_deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM workspace_children c WHERE c.batch_id = b.id AND c.stopped_at IS NULL)
ORDER BY b.created_at, b.id
LIMIT sqlc.arg(max_rows);

-- name: MarkWorkspaceChildSnapshotDeleted :exec
UPDATE workspace_child_batches
SET snapshot_deleted_at = now()
WHERE id = sqlc.arg(id)
  AND snapshot_deleted_at IS NULL;
