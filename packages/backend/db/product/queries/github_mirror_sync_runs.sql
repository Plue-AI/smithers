-- name: CreateGithubMirrorSyncRun :one
INSERT INTO github_mirror_sync_runs (repository_id, requested_by)
VALUES (sqlc.arg(repository_id), sqlc.arg(requested_by))
RETURNING *;

-- name: GetGithubMirrorSyncRun :one
SELECT *
FROM github_mirror_sync_runs
WHERE id = sqlc.arg(id)
  AND repository_id = sqlc.arg(repository_id);

-- name: MarkGithubMirrorSyncRunRunning :execrows
UPDATE github_mirror_sync_runs
SET state = 'running', started_at = NOW(), updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND state = 'queued';

-- name: FinishGithubMirrorSyncRun :exec
UPDATE github_mirror_sync_runs
SET state = sqlc.arg(state)::text,
    finished_at = NOW(),
    updated_at = NOW()
WHERE id = sqlc.arg(id);

-- name: UpsertGithubMirrorSyncRefResult :exec
INSERT INTO github_mirror_sync_ref_results (
    run_id, name, from_revision, to_revision, status, error
)
VALUES (
    sqlc.arg(run_id), sqlc.arg(name)::text,
    sqlc.arg(from_revision)::text, sqlc.arg(to_revision)::text,
    sqlc.arg(status)::text, sqlc.arg(error)::text
)
ON CONFLICT (run_id, name) DO UPDATE
SET from_revision = EXCLUDED.from_revision,
    to_revision = EXCLUDED.to_revision,
    status = EXCLUDED.status,
    error = EXCLUDED.error,
    updated_at = NOW();

-- name: ListGithubMirrorSyncRefResults :many
SELECT *
FROM github_mirror_sync_ref_results
WHERE run_id = sqlc.arg(run_id)
ORDER BY name;

-- name: GetLatestGithubMirrorSyncRefResult :one
SELECT rr.*
FROM github_mirror_sync_ref_results rr
JOIN github_mirror_sync_runs runs ON runs.id = rr.run_id
WHERE runs.repository_id = sqlc.arg(repository_id)
  AND rr.name = sqlc.arg(name)::text
ORDER BY runs.created_at DESC, runs.id DESC
LIMIT 1;

-- name: GetLatestSucceededGithubMirrorSyncRefResult :one
-- The last revision this mirror verifiably wrote for a ref. Failed and
-- refused results never grant a prune.
SELECT rr.*
FROM github_mirror_sync_ref_results rr
JOIN github_mirror_sync_runs runs ON runs.id = rr.run_id
WHERE runs.repository_id = sqlc.arg(repository_id)
  AND rr.name = sqlc.arg(name)::text
  AND rr.status = 'succeeded'
ORDER BY runs.created_at DESC, runs.id DESC
LIMIT 1;

-- name: FinishSuccessfulGithubMirrorSyncRun :execrows
-- A complete, verified push publishes its run receipt and repository health
-- atomically. Per-ref retries use the ordinary finisher: they cannot certify
-- the other refs. The default bookmark's SHA comes from the verified target.
WITH finished AS (
    UPDATE github_mirror_sync_runs AS sync_run
    SET state = 'succeeded', finished_at = NOW(), updated_at = NOW()
    WHERE sync_run.id = sqlc.arg(id) AND sync_run.state = 'running'
    RETURNING sync_run.repository_id
)
UPDATE repositories r
SET mirror_status = 'synced', mirror_behind_refs = 0, mirror_failed_refs = 0,
    last_mirror_at = NOW(), last_mirror_error = NULL,
    last_mirror_github_head = sqlc.arg(verified_refs)::jsonb ->> ('refs/heads/' || r.default_bookmark)
FROM finished
WHERE r.id = finished.repository_id;
