-- name: CreateLandingRequest :one
INSERT INTO landing_requests (
    repository_id, number, title, body, author_id, target_bookmark,
    source_bookmark, state, stack_size, agent_authored,
    author_agent_session_id, turn_party, turn_actor_id, turn_reason
)
VALUES (
    $1, get_next_landing_number($1), $2, $3, $4, $5, $6, 'open', $7,
    sqlc.arg(agent_authored), NULLIF(sqlc.arg(author_agent_session_id)::text, '')::uuid,
    'reviewer', COALESCE(NULLIF(sqlc.arg(author_agent_session_id)::text, ''), $4::bigint::text), 'request'
)
RETURNING *;

-- name: CreateLandingRequestIdempotent :one
INSERT INTO landing_requests (
    repository_id, number, title, body, author_id, target_bookmark,
    source_bookmark, state, stack_size, agent_authored,
    author_agent_session_id, turn_party, turn_actor_id, turn_reason, request_id, create_request_hash
)
VALUES (
    $1, get_next_landing_number($1), $2, $3, $4, $5, $6, 'open', $7,
    sqlc.arg(agent_authored), NULLIF(sqlc.arg(author_agent_session_id)::text, '')::uuid,
    'reviewer', COALESCE(NULLIF(sqlc.arg(author_agent_session_id)::text, ''), $4::bigint::text), 'request', sqlc.arg(request_id), sqlc.arg(create_request_hash)
)
ON CONFLICT (repository_id, author_id, request_id) DO NOTHING
RETURNING *;

-- name: GetLandingRequestByCreateIdentity :one
SELECT * FROM landing_requests
WHERE repository_id = $1 AND author_id = $2 AND request_id = $3;

-- name: GetLandingRequestByNumber :one
SELECT *
FROM landing_requests
WHERE repository_id = $1
  AND number = $2;

-- name: GetLandingRequestWithChangeIDsByNumber :one
SELECT
    lr.*,
    ARRAY(
        SELECT lrc.change_id::text
        FROM landing_request_changes AS lrc
        WHERE lrc.landing_request_id = lr.id
        ORDER BY lrc.position_in_stack
    )::text[] AS change_ids
FROM landing_requests AS lr
WHERE lr.repository_id = $1
  AND lr.number = $2;

-- name: AddLandingRequestChange :one
INSERT INTO landing_request_changes (landing_request_id, change_id, position_in_stack)
VALUES ($1, $2, $3)
RETURNING *;

-- name: DeleteLandingRequestChanges :exec
DELETE FROM landing_request_changes
WHERE landing_request_id = $1;

-- name: ListLandingRequestChanges :many
SELECT *
FROM landing_request_changes
WHERE landing_request_id = $1
ORDER BY position_in_stack ASC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: CreateLandingRequestReview :one
INSERT INTO landing_request_reviews (
    landing_request_id,
    reviewer_id,
    reviewer_kind,
    agent_session_id,
    type,
    verdict,
    confidence_bucket,
    summary,
    commit_id,
    body,
    change_revisions
)
VALUES (
    sqlc.arg(landing_request_id),
    sqlc.narg(reviewer_id),
    COALESCE(NULLIF(sqlc.arg(reviewer_kind)::text, ''), 'human'),
    NULLIF(sqlc.arg(agent_session_id)::text, '')::uuid,
    sqlc.arg(type),
    NULLIF(sqlc.arg(verdict)::text, ''),
    NULLIF(sqlc.arg(confidence_bucket)::text, ''),
    sqlc.arg(summary),
    sqlc.arg(commit_id),
    sqlc.arg(body),
    COALESCE(sqlc.arg(change_revisions)::jsonb, '{}'::jsonb)
)
RETURNING *;

-- name: GetLandingRequestChangeRevisionByCommitID :one
SELECT cr.*
FROM change_revisions AS cr
JOIN landing_request_changes AS lrc
  ON lrc.change_id = cr.change_id
WHERE lrc.landing_request_id = sqlc.arg(landing_request_id)
  AND cr.repository_id = sqlc.arg(repository_id)
  AND cr.commit_id = sqlc.arg(commit_id)
LIMIT 1;

-- name: GetLatestLandingRequestForChange :one
SELECT lr.*
FROM landing_requests AS lr
JOIN landing_request_changes AS lrc ON lrc.landing_request_id = lr.id
WHERE lr.repository_id = sqlc.arg(repository_id)
  AND lrc.change_id = sqlc.arg(change_id)
  AND lr.state NOT IN ('closed', 'merged')
ORDER BY lr.number DESC
LIMIT 1;

-- name: GetMergedLandingRequestForChange :one
SELECT
    lr.*,
    COALESCE(
      lr.landed_revisions -> lrc.change_id ->> 'commit_id',
      (
        SELECT cr.commit_id
        FROM change_revisions AS cr
        WHERE cr.repository_id = lr.repository_id
          AND cr.change_id = lrc.change_id
          AND cr.created_at <= lr.merged_at
        ORDER BY cr.seq DESC
        LIMIT 1
      ),
      c.commit_id,
      ''
    )::text AS landed_revision
FROM landing_requests AS lr
JOIN landing_request_changes AS lrc ON lrc.landing_request_id = lr.id
LEFT JOIN changes AS c
  ON c.repository_id = lr.repository_id
 AND c.change_id = lrc.change_id
WHERE lr.repository_id = sqlc.arg(repository_id)
  AND lrc.change_id = sqlc.arg(change_id)
  AND lr.state = 'merged'
ORDER BY lr.merged_at DESC, lr.id DESC
LIMIT 1;

-- name: ListSubmittedLandingApprovals :many
SELECT *
FROM landing_request_reviews
WHERE landing_request_id = $1
  AND type = 'approve'
  AND reviewer_kind = 'human'
  AND state = 'submitted'
ORDER BY created_at DESC, id DESC;

-- name: ListTeamNamesForUserByRepository :many
SELECT DISTINCT t.lower_name
FROM teams AS t
JOIN team_members AS tm ON tm.team_id = t.id
JOIN repositories AS r ON r.org_id = t.organization_id
WHERE r.id = sqlc.arg(repository_id)
  AND tm.user_id = sqlc.arg(user_id)
ORDER BY t.lower_name;

-- name: CreateLandingRequestComment :one
INSERT INTO landing_request_comments (landing_request_id, user_id, path, line, side, body, commit_id, anchor_hash)
VALUES ($1, $2, $3, $4, $5, $6, sqlc.arg(commit_id), sqlc.arg(anchor_hash))
RETURNING *;

-- name: UpdateLandingRequestTurn :one
UPDATE landing_requests
SET turn_party = sqlc.arg(turn_party),
    turn_actor_id = sqlc.arg(turn_actor_id),
    turn_since = statement_timestamp(),
    turn_reason = sqlc.arg(turn_reason),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: UpdateLandingRequestsTurnForRevision :exec
UPDATE landing_requests AS lr
SET turn_party = 'reviewer',
    turn_actor_id = COALESCE(cr.agent_session_id::text, lr.author_id::text),
    turn_since = cr.created_at,
    turn_reason = 'revision',
    turn_revision_id = cr.id,
    updated_at = NOW()
FROM landing_request_changes AS lrc
JOIN change_revisions AS cr
  ON cr.repository_id = sqlc.arg(repository_id)
 AND cr.change_id = lrc.change_id
 AND cr.commit_id = sqlc.arg(commit_id)
WHERE lr.id = lrc.landing_request_id
  AND lr.repository_id = sqlc.arg(repository_id)
  AND lrc.change_id = sqlc.arg(change_id)
  AND lr.state NOT IN ('closed', 'merged')
  -- A delayed or replayed push callback must not move the turn past newer
  -- feedback. The id rejects duplicate revisions; the timestamp orders the
  -- revision against comment/review events stored on the landing row.
  AND cr.id > lr.turn_revision_id
  AND cr.created_at >= lr.turn_since;

-- name: CountLandingRequestsByRepoFiltered :one
SELECT COUNT(*)
FROM landing_requests
WHERE repository_id = sqlc.arg(repository_id)
  AND (sqlc.arg(state)::text = '' OR state = sqlc.arg(state)::text);

-- name: ListLandingRequestsWithChangeIDsByRepoFiltered :many
SELECT
    lr.*,
    ARRAY(
        SELECT lrc.change_id::text
        FROM landing_request_changes AS lrc
        WHERE lrc.landing_request_id = lr.id
        ORDER BY lrc.position_in_stack
    )::text[] AS change_ids
FROM landing_requests AS lr
WHERE lr.repository_id = sqlc.arg(repository_id)
  AND (sqlc.arg(state)::text = '' OR lr.state = sqlc.arg(state)::text)
ORDER BY lr.number DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: UpdateLandingRequest :one
UPDATE landing_requests
SET title = sqlc.arg(title),
    body = sqlc.arg(body),
    state = sqlc.arg(state),
    target_bookmark = sqlc.arg(target_bookmark),
    source_bookmark = sqlc.arg(source_bookmark),
    conflict_status = sqlc.arg(conflict_status),
    stack_size = sqlc.arg(stack_size),
    closed_at = sqlc.arg(closed_at),
    merged_at = sqlc.arg(merged_at),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND state = sqlc.arg(expected_state)
  AND (
      state NOT IN ('queued', 'landing', 'merged')
      OR (
          target_bookmark = sqlc.arg(target_bookmark)
          AND source_bookmark = sqlc.arg(source_bookmark)
      )
  )
RETURNING *;

-- name: MergeLandingRequest :one
UPDATE landing_requests
SET state = 'merged',
    landed_revisions = COALESCE((
        SELECT jsonb_object_agg(
            lrc.change_id,
            jsonb_build_object(
                'commit_id', COALESCE(t.append_request->'change_ids'->>(lrc.position_in_stack::int-1), c.commit_id),
                'seq', CASE WHEN t.append_request IS NULL THEN c.revision_seq ELSE (
                    SELECT cr.seq FROM change_revisions cr
                    WHERE cr.repository_id=landing_requests.repository_id AND cr.change_id=lrc.change_id
                      AND cr.commit_id=t.append_request->'change_ids'->>(lrc.position_in_stack::int-1)
                    ORDER BY cr.id DESC LIMIT 1
                ) END
            )
        )
        FROM landing_request_changes AS lrc
        JOIN changes AS c
          ON c.repository_id = landing_requests.repository_id
         AND c.change_id = lrc.change_id
        LEFT JOIN landing_tasks t ON t.landing_request_id=landing_requests.id
        WHERE lrc.landing_request_id = landing_requests.id
    ), '{}'::jsonb),
    merged_at = NOW(),
    updated_at = NOW()
WHERE landing_requests.id = $1
RETURNING landing_requests.*;

-- name: ListLandingRequestReviews :many
SELECT *
FROM landing_request_reviews
WHERE landing_request_id = $1
ORDER BY created_at ASC, id ASC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: CountLandingRequestReviews :one
SELECT COUNT(*)
FROM landing_request_reviews
WHERE landing_request_id = $1;

-- name: CreateLandingReviewRequest :one
INSERT INTO landing_review_requests (
    landing_request_id,
    requested_by,
    reviewer_id,
    agent_name
)
VALUES (
    sqlc.arg(landing_request_id),
    sqlc.arg(requested_by),
    sqlc.narg(reviewer_id),
    NULLIF(sqlc.arg(agent_name)::text, '')
)
RETURNING *;

-- name: ListLandingReviewRequests :many
SELECT *
FROM landing_review_requests
WHERE landing_request_id = $1
ORDER BY created_at ASC, id ASC;

-- name: DismissLandingReviewRequest :one
UPDATE landing_review_requests
SET state = 'dismissed'
WHERE id = sqlc.arg(id)
  AND landing_request_id = sqlc.arg(landing_request_id)
  AND state = 'requested'
RETURNING *;

-- name: FulfillLandingReviewRequestsForUser :exec
UPDATE landing_review_requests
SET state = 'fulfilled'
WHERE landing_request_id = sqlc.arg(landing_request_id)
  AND reviewer_id = sqlc.arg(reviewer_id)
  AND state = 'requested';

-- name: FulfillLandingReviewRequestsForAgent :exec
UPDATE landing_review_requests
SET state = 'fulfilled'
WHERE landing_request_id = sqlc.arg(landing_request_id)
  AND lower(agent_name) = lower(sqlc.arg(agent_name)::text)
  AND state = 'requested';

-- name: CountApprovedLandingRequestReviews :one
SELECT COUNT(DISTINCT reviewer_id)
FROM landing_request_reviews
WHERE landing_request_id = $1
  AND type = 'approve'
  AND reviewer_kind = 'human'
  AND state = 'submitted';

-- name: CountCurrentAgentLandingReviewCommits :one
SELECT COUNT(DISTINCT commit_id)
FROM landing_request_reviews
WHERE landing_request_id = sqlc.arg(landing_request_id)
  AND reviewer_kind = 'agent'
  AND verdict = 'lgtm'
  AND state = 'submitted'
  AND commit_id = ANY(sqlc.arg(commit_ids)::text[]);

-- name: CountCurrentApprovedLandingRequestReviews :one
SELECT COUNT(DISTINCT lrr.reviewer_id)
FROM landing_request_reviews AS lrr
WHERE lrr.landing_request_id = sqlc.arg(landing_request_id)
  AND lrr.type = 'approve'
  AND lrr.reviewer_kind = 'human'
  AND lrr.state = 'submitted'
  AND NOT EXISTS (
      SELECT 1
      FROM landing_request_changes AS lrc
      JOIN changes AS c
        ON c.repository_id = sqlc.arg(repository_id)
       AND c.change_id = lrc.change_id
      WHERE lrc.landing_request_id = lrr.landing_request_id
        AND (
          COALESCE((lrr.change_revisions -> lrc.change_id ->> 'seq')::bigint, 0) <> c.revision_seq
          OR COALESCE(lrr.change_revisions -> lrc.change_id ->> 'commit_id', '') <> c.commit_id
        )
  );

-- name: ListChangesRequestedLandingReviewers :many
-- A person's request for changes stands until they approve later or it is
-- dismissed (D-21, as on GitHub: a later comment does not clear it); an
-- agent's review, or one given through a run credential, never stands for a
-- person.
SELECT u.username
FROM (
    SELECT DISTINCT ON (reviewer_id) reviewer_id, type, state
    FROM landing_request_reviews
    WHERE landing_request_id = $1
      AND reviewer_kind = 'human'
      AND reviewer_id IS NOT NULL
      AND type IN ('approve', 'request_changes')
    ORDER BY reviewer_id, id DESC
) AS latest
JOIN users AS u ON u.id = latest.reviewer_id
WHERE latest.type = 'request_changes'
  AND latest.state = 'submitted'
ORDER BY u.lower_username;

-- name: GetLandingRequestReviewByID :one
SELECT *
FROM landing_request_reviews
WHERE id = $1;

-- name: UpdateLandingRequestReviewState :one
UPDATE landing_request_reviews
SET state = sqlc.arg(state),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: ListLandingRequestComments :many
SELECT *
FROM landing_request_comments
WHERE landing_request_id = $1
ORDER BY created_at ASC, id ASC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: CountLandingRequestComments :one
SELECT COUNT(*)
FROM landing_request_comments
WHERE landing_request_id = $1;

-- name: GetLandingRequestCommentByID :one
SELECT *
FROM landing_request_comments
WHERE id = sqlc.arg(id)
  AND landing_request_id = sqlc.arg(landing_request_id);

-- name: MarkLandingRequestThreadDone :one
UPDATE landing_request_comments
SET state = 'done',
    done_at = NOW(),
    done_by = sqlc.arg(done_by),
    resolved_in_revision = sqlc.arg(resolved_in_revision)::jsonb,
    resolved_at = NULL,
    resolved_by = NULL,
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND landing_request_id = sqlc.arg(landing_request_id)
  AND state = 'open'
RETURNING *;

-- name: AckLandingRequestThread :one
UPDATE landing_request_comments
SET state = 'resolved',
    resolved_at = NOW(),
    resolved_by = sqlc.arg(resolved_by),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND landing_request_id = sqlc.arg(landing_request_id)
  AND state = 'done'
RETURNING *;

-- name: ReopenLandingRequestThread :one
UPDATE landing_request_comments
SET state = 'open',
    done_at = NULL,
    done_by = NULL,
    resolved_in_revision = 'null'::jsonb,
    resolved_at = NULL,
    resolved_by = NULL,
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND landing_request_id = sqlc.arg(landing_request_id)
  AND state IN ('done', 'resolved')
RETURNING *;

-- name: CountUnresolvedLandingRequestThreads :one
SELECT COUNT(*)
FROM landing_request_comments
WHERE landing_request_id = $1
  AND state <> 'resolved';

-- name: CountLandingRequestChanges :one
SELECT COUNT(*)
FROM landing_request_changes
WHERE landing_request_id = $1;
-- tmpwatch

-- name: EnqueueLandingRequest :one
UPDATE landing_requests
SET state = 'queued',
    queued_by = sqlc.arg(queued_by),
    queued_at = NOW(),
    landing_started_at = NULL,
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND state IN ('open', 'failed')
  AND target_bookmark = sqlc.arg(target_bookmark)
  AND source_bookmark = sqlc.arg(source_bookmark)
RETURNING *;

-- name: EnqueueAutoLandRequest :one
UPDATE landing_requests
SET state = 'queued',
    queued_by = sqlc.arg(queued_by),
    queued_at = NOW(),
    landing_started_at = NULL,
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND state = 'open'
  AND auto_land_enabled
  AND target_bookmark = sqlc.arg(target_bookmark)
  AND source_bookmark = sqlc.arg(source_bookmark)
RETURNING *;

-- name: SetLandingRequestAutoLand :one
UPDATE landing_requests
SET auto_land_enabled = TRUE,
    auto_land_set_by = sqlc.arg(set_by),
    auto_land_set_at = NOW(),
    auto_land_checked_at = NULL,
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND state = 'open'
RETURNING *;

-- name: ClearLandingRequestAutoLand :one
UPDATE landing_requests
SET auto_land_enabled = FALSE,
    auto_land_set_by = NULL,
    auto_land_set_at = NULL,
    auto_land_checked_at = NULL,
    updated_at = NOW()
WHERE id = sqlc.arg(id)
RETURNING *;

-- Claim one enabled intent for gate evaluation. Advancing checked_at before
-- the (potentially remote) gate checks gives every intent a turn without
-- holding a database lock across repo-host calls.
-- name: ClaimAutoLandCandidate :one
WITH candidate AS (
    SELECT id
    FROM landing_requests
    WHERE auto_land_enabled
      AND state = 'open'
    ORDER BY auto_land_checked_at ASC NULLS FIRST, auto_land_set_at ASC, id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
UPDATE landing_requests AS lr
SET auto_land_checked_at = NOW()
FROM candidate
WHERE lr.id = candidate.id
RETURNING lr.*;

-- name: CreateLandingTask :one
INSERT INTO landing_tasks (landing_request_id, repository_id, priority, append_request, status)
VALUES ($1, $2, $3, sqlc.narg(append_request)::jsonb,
  CASE WHEN sqlc.narg(append_request)::jsonb IS NULL THEN 'pending' ELSE 'append_pending' END)
RETURNING *;

-- The existing service transaction uses this upsert. Never reset an active
-- worker, or erase an append's durable receipt by converting it to ordinary land.
-- name: ResetOrCreateLandingTask :one
INSERT INTO landing_tasks (landing_request_id, repository_id, priority, append_request, status)
VALUES (sqlc.arg(landing_request_id), sqlc.arg(repository_id), sqlc.arg(priority), sqlc.narg(append_request)::jsonb,
  CASE WHEN sqlc.narg(append_request)::jsonb IS NULL THEN 'pending' ELSE 'append_pending' END)
ON CONFLICT (landing_request_id) DO UPDATE
SET status = EXCLUDED.status,
    append_request = EXCLUDED.append_request,
    priority = EXCLUDED.priority,
    attempt = 0,
    last_error = NULL,
    available_at = NOW(),
    started_at = NULL,
    finished_at = NULL,
    updated_at = NOW()
WHERE landing_tasks.status IN ('failed', 'done')
  AND NOT (landing_tasks.append_request IS NOT NULL AND EXCLUDED.append_request IS NULL)
RETURNING *;

-- name: ClaimPendingLandingTask :one
WITH claimable AS (
    SELECT lt.id
    FROM landing_tasks lt
    WHERE lt.status IN ('pending', 'append_pending')
      AND lt.available_at <= NOW()
      AND NOT EXISTS (
          SELECT 1 FROM landing_tasks lt2
          WHERE lt2.repository_id = lt.repository_id
            AND lt2.status = 'running'
      )
    ORDER BY lt.priority DESC, lt.created_at ASC, lt.id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
UPDATE landing_tasks lt
SET status = 'running',
    attempt = lt.attempt + 1,
    started_at = NOW(),
    updated_at = NOW()
FROM claimable
WHERE lt.id = claimable.id
RETURNING lt.*;

-- name: MarkLandingTaskDone :one
UPDATE landing_tasks
SET status = 'done',
    finished_at = NOW(),
    updated_at = NOW()
WHERE id = $1
RETURNING *;

-- name: MarkLandingStarted :one
UPDATE landing_requests
SET state = 'landing',
    landing_started_at = NOW(),
    updated_at = NOW()
WHERE id = $1
RETURNING *;

-- name: FailLandingTask :one
UPDATE landing_tasks
SET status = 'failed',
    last_error = $2,
    finished_at = NOW(),
    updated_at = NOW()
WHERE id = $1
RETURNING *;

-- A repository its host holds refuses the landing for now: the task goes back
-- to the queue until available_at without spending an attempt, and its
-- landing request is queued again.
-- name: DeferHeldLanding :one
WITH deferred AS (
    UPDATE landing_tasks
    SET status = CASE WHEN append_request IS NULL THEN 'pending' ELSE 'append_pending' END,
        attempt = GREATEST(attempt - 1, 0),
        last_error = sqlc.arg(last_error)::text,
        available_at = NOW() + make_interval(secs => sqlc.arg(delay_seconds)::float8),
        started_at = NULL,
        updated_at = NOW()
    WHERE landing_tasks.id = sqlc.arg(task_id) AND landing_tasks.status = 'running'
    RETURNING *
), requeued AS (
    UPDATE landing_requests lr
    SET state = 'queued',
        landing_started_at = NULL,
        updated_at = NOW()
    FROM deferred
    WHERE lr.id = deferred.landing_request_id AND lr.state = 'landing'
    RETURNING lr.id
)
SELECT * FROM deferred;

-- name: RevertLandingRequestToOpen :one
UPDATE landing_requests
SET state = 'open',
    queued_by = NULL,
    queued_at = NULL,
    landing_started_at = NULL,
    updated_at = NOW()
WHERE id = $1
RETURNING *;

-- name: MarkLandingRequestFailed :one
UPDATE landing_requests
SET state = 'failed',
    updated_at = NOW()
WHERE id = $1
RETURNING *;

-- name: GetLandingTaskByLandingRequestID :one
SELECT *
FROM landing_tasks
WHERE landing_request_id = $1;

-- name: GetLandingRequestByID :one
SELECT *
FROM landing_requests
WHERE id = $1;

-- name: ListLandingRequestsByRepoFilteredKeyset :many
-- Stable cursor pagination: returns landing requests with number < after_number (DESC),
-- or all landing requests when after_number = 0 (first page).
SELECT
    lr.*,
    ARRAY(
        SELECT lrc.change_id::text
        FROM landing_request_changes AS lrc
        WHERE lrc.landing_request_id = lr.id
        ORDER BY lrc.position_in_stack
    )::text[] AS change_ids
FROM landing_requests AS lr
WHERE lr.repository_id = sqlc.arg(repository_id)
  AND (sqlc.arg(state)::text = '' OR lr.state = sqlc.arg(state)::text)
  AND (sqlc.arg(after_number)::bigint = 0 OR lr.number < sqlc.arg(after_number)::bigint)
ORDER BY lr.number DESC
LIMIT sqlc.arg(page_size);

-- name: GetLandingQueuePositionByTaskID :one
SELECT COUNT(*) AS position
FROM landing_tasks AS t
WHERE t.status IN ('pending', 'append_pending', 'running')
  AND t.repository_id = (SELECT lt.repository_id FROM landing_tasks AS lt WHERE lt.id = $1)
  AND t.created_at <= (SELECT lt2.created_at FROM landing_tasks AS lt2 WHERE lt2.id = $1);
