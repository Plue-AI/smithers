-- name: CreateGithubMirrorSyncRun :one
INSERT INTO github_mirror_sync_runs (repository_id, requested_by)
VALUES (sqlc.arg(repository_id), sqlc.arg(requested_by))
RETURNING *;

-- name: ExpireGithubMirrorSyncRuns :execrows
-- A fixed admission deadline also covers legacy rows and lost queued launches.
-- Lock each run before its refs so late writers serialize with interruption.
-- The result counts repository health updates, not interrupted runs: newer
-- independently verified health is preserved even when its old run expires.
WITH expired AS (
    UPDATE github_mirror_sync_runs
    SET state = 'failed', finished_at = NOW(), updated_at = NOW()
    WHERE id IN (
        SELECT id FROM github_mirror_sync_runs
        WHERE (sqlc.arg(repository_id)::bigint = 0 OR repository_id = sqlc.arg(repository_id))
          AND state IN ('queued', 'running')
          AND created_at <= NOW() - INTERVAL '11 minutes'
        ORDER BY id
        LIMIT 1000
        FOR UPDATE SKIP LOCKED
    )
    RETURNING id, repository_id, created_at
), interrupted_refs AS (
    UPDATE github_mirror_sync_ref_results rr
    SET status = 'failed', error = 'Git mirror sync interrupted; retry reconciliation', updated_at = NOW()
    FROM expired
    WHERE rr.run_id = expired.id AND rr.status = 'pending'
    RETURNING rr.run_id
)
UPDATE repositories r
SET mirror_status = 'failed',
    mirror_behind_refs = (SELECT COUNT(*)::integer FROM github_mirror_sync_ref_results rr
                         WHERE rr.run_id = expired.id AND rr.status <> 'succeeded'),
    mirror_failed_refs = (SELECT COUNT(*)::integer FROM github_mirror_sync_ref_results rr
                         WHERE rr.run_id = expired.id AND rr.status <> 'succeeded'),
    last_mirror_error = 'Git mirror sync interrupted; retry reconciliation'
FROM expired
WHERE r.id = expired.repository_id
  AND (r.last_mirror_at IS NULL OR r.last_mirror_at <= expired.created_at);

-- name: GetGithubMirrorSyncRun :one
SELECT *
FROM github_mirror_sync_runs
WHERE id = sqlc.arg(id)
  AND repository_id = sqlc.arg(repository_id);

-- name: MarkGithubMirrorSyncRunRunning :execrows
UPDATE github_mirror_sync_runs
SET state = 'running', started_at = NOW(), updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND state = 'queued'
  AND created_at > NOW() - INTERVAL '10 minutes';

-- name: FinishGithubMirrorSyncRun :exec
-- Failed runs publish current failure health without replacing the last
-- verified success. A completed run cannot finalize again over newer health.
WITH finished AS (
    UPDATE github_mirror_sync_runs AS sync_run
    SET state = sqlc.arg(state)::text, finished_at = NOW(), updated_at = NOW()
    WHERE sync_run.id = sqlc.arg(id) AND sync_run.state IN ('queued', 'running')
      AND sync_run.created_at > NOW() - INTERVAL '11 minutes'
    RETURNING sync_run.id, sync_run.repository_id, sync_run.state, sync_run.created_at
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
WHERE r.id = finished.repository_id AND finished.state = 'failed'
  AND (r.last_mirror_at IS NULL OR r.last_mirror_at <= finished.created_at);

-- name: UpsertGithubMirrorSyncRefResult :execrows
WITH active AS (
    SELECT sync_run.id FROM github_mirror_sync_runs sync_run
    WHERE sync_run.id = sqlc.arg(run_id) AND sync_run.state = 'running'
      AND sync_run.created_at > NOW() - INTERVAL '11 minutes'
    FOR UPDATE
)
INSERT INTO github_mirror_sync_ref_results (
    run_id, name, from_revision, to_revision, status, error
)
SELECT active.id, sqlc.arg(name)::text,
    sqlc.arg(from_revision)::text, sqlc.arg(to_revision)::text,
    sqlc.arg(status)::text, sqlc.arg(error)::text
FROM active
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
      AND sync_run.created_at > NOW() - INTERVAL '11 minutes'
    RETURNING sync_run.repository_id
)
UPDATE repositories r
SET mirror_status = 'synced', mirror_behind_refs = 0, mirror_failed_refs = 0,
    last_mirror_at = NOW(), last_mirror_error = NULL,
    last_mirror_github_head = sqlc.arg(verified_refs)::jsonb ->> ('refs/heads/' || r.default_bookmark)
FROM finished
WHERE r.id = finished.repository_id;
