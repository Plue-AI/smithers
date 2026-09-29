-- name: CreateGithubMirrorSyncRun :one
-- Recover abandoned slots after the ten-minute worker deadline plus a minute
-- for cancellation. The INSERT depends on expiry; the active-run unique index
-- still serializes competing admissions for this repository.
WITH expired AS (
    UPDATE github_mirror_sync_runs AS sync_run
    SET state = 'failed', finished_at = NOW(), updated_at = NOW()
    WHERE sync_run.repository_id = sqlc.arg(repository_id)
      AND sync_run.state IN ('queued', 'running')
      AND sync_run.updated_at < NOW() - INTERVAL '11 minutes'
    RETURNING sync_run.id
)
INSERT INTO github_mirror_sync_runs (repository_id, requested_by)
SELECT sqlc.arg(repository_id), sqlc.arg(requested_by) FROM (SELECT COUNT(*) FROM expired) AS expiry
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
-- Failed runs publish current failure health without replacing the last
-- verified success. A completed run cannot finalize again over newer health.
WITH finished AS (
    UPDATE github_mirror_sync_runs AS sync_run
    SET state = sqlc.arg(state)::text, finished_at = NOW(), updated_at = NOW()
    WHERE sync_run.id = sqlc.arg(id) AND sync_run.state IN ('queued', 'running')
    RETURNING sync_run.id, sync_run.repository_id, sync_run.state
)
UPDATE repositories r
SET mirror_status = 'failed',
    mirror_behind_refs = (
        SELECT COUNT(*)::integer FROM github_mirror_sync_ref_results rr
        WHERE rr.run_id = finished.id AND rr.status <> 'succeeded'
    ),
    mirror_failed_refs = (
        SELECT COUNT(*)::integer FROM github_mirror_sync_ref_results rr
        WHERE rr.run_id = finished.id AND rr.status = 'failed'
    ),
    last_mirror_error = COALESCE((
        SELECT NULLIF(rr.error, '') FROM github_mirror_sync_ref_results rr
        WHERE rr.run_id = finished.id AND rr.status = 'failed' AND rr.error <> ''
        ORDER BY rr.name LIMIT 1
    ), 'Git mirror sync failed')
FROM finished
WHERE r.id = finished.repository_id AND finished.state = 'failed';

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
-- refused or already-matching results never grant a prune.
SELECT rr.*
FROM github_mirror_sync_ref_results rr
JOIN github_mirror_sync_runs runs ON runs.id = rr.run_id
WHERE runs.repository_id = sqlc.arg(repository_id)
  AND rr.name = sqlc.arg(name)::text
  AND rr.status = 'succeeded'
  AND rr.from_revision <> rr.to_revision
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
