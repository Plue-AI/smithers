-- name: InsertRepoPushEvent :execrows
-- A duplicate delivery_id inserts nothing and reports zero rows.
INSERT INTO repo_push_events (
    delivery_id, repository_id, owner, repo, ref_name, before_sha, commit_sha, pusher_id, pusher_login, pusher_credential
) VALUES (
    sqlc.arg(delivery_id), sqlc.arg(repository_id), sqlc.arg(owner), sqlc.arg(repo), sqlc.arg(ref_name),
    sqlc.arg(before_sha), sqlc.arg(commit_sha), sqlc.arg(pusher_id), sqlc.arg(pusher_login), sqlc.arg(pusher_credential)
)
ON CONFLICT (delivery_id) DO NOTHING;

-- name: ClaimPendingRepoPushEvents :many
WITH claimed AS (
    SELECT id
    FROM repo_push_events
    WHERE status = 'pending'
      AND available_at <= NOW()
    ORDER BY available_at ASC, id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT sqlc.arg(claim_limit)
)
UPDATE repo_push_events e
SET status = 'processing',
    attempts = e.attempts + 1,
    updated_at = NOW()
FROM claimed
WHERE e.id = claimed.id
RETURNING e.*;

-- Every write below is fenced on the claim generation (status='processing'
-- AND attempts=$n): a worker whose claim was reset as stalled and re-claimed
-- elsewhere changes zero rows.

-- name: MarkRepoPushEventStepDone :execrows
UPDATE repo_push_events
SET steps_done = array_append(steps_done, sqlc.arg(step)::text),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND status = 'processing'
  AND attempts = sqlc.arg(expected_attempts)
  AND NOT (sqlc.arg(step)::text = ANY(steps_done));

-- name: TouchRepoPushEvent :execrows
UPDATE repo_push_events
SET updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND status = 'processing'
  AND attempts = sqlc.arg(expected_attempts);

-- name: MarkRepoPushEventDone :execrows
UPDATE repo_push_events
SET status = 'done',
    error = '',
    processed_at = NOW(),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND status = 'processing'
  AND attempts = sqlc.arg(expected_attempts);

-- name: MarkRepoPushEventFailed :execrows
UPDATE repo_push_events
SET status = 'failed',
    error = sqlc.arg(error),
    processed_at = NOW(),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND status = 'processing'
  AND attempts = sqlc.arg(expected_attempts);

-- name: RetryRepoPushEvent :execrows
UPDATE repo_push_events
SET status = 'pending',
    error = sqlc.arg(error),
    available_at = NOW() + make_interval(secs => sqlc.arg(backoff_seconds)::double precision),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND status = 'processing'
  AND attempts = sqlc.arg(expected_attempts);

-- name: ResetStalledRepoPushEvents :execrows
UPDATE repo_push_events
SET status = 'pending',
    available_at = NOW(),
    updated_at = NOW()
WHERE status = 'processing'
  AND updated_at < NOW() - make_interval(secs => sqlc.arg(older_than_seconds)::double precision);
