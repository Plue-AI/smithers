-- name: UpsertChange :one
INSERT INTO changes (
    repository_id,
    change_id,
    commit_id,
    description,
    author_name,
    author_email,
    has_conflict,
    is_empty,
    parent_change_ids
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (repository_id, change_id)
DO UPDATE SET
    commit_id = EXCLUDED.commit_id,
    description = EXCLUDED.description,
    author_name = EXCLUDED.author_name,
    author_email = EXCLUDED.author_email,
    has_conflict = EXCLUDED.has_conflict,
    is_empty = EXCLUDED.is_empty,
    parent_change_ids = EXCLUDED.parent_change_ids,
    revision_seq = CASE
        WHEN changes.commit_id IS DISTINCT FROM EXCLUDED.commit_id THEN changes.revision_seq + 1
        ELSE changes.revision_seq
    END,
    updated_at = NOW()
RETURNING *;

-- name: RecordChangeRevision :one
WITH change_lock AS MATERIALIZED (
    -- Serialize sequence allocation for one stable change while allowing
    -- unrelated changes to be recorded concurrently.
    SELECT pg_advisory_xact_lock(hashtextextended(
        sqlc.arg(repository_id)::bigint::text || ':' || sqlc.arg(change_id)::text,
        0
    ))
)
INSERT INTO change_revisions (
    repository_id,
    change_id,
    seq,
    commit_id,
    parent_commit_id,
    source,
    agent_session_id,
    workspace_snapshot_id,
    workspace_id,
    operation_ids
)
SELECT
    sqlc.arg(repository_id)::bigint,
    sqlc.arg(change_id),
    COALESCE((
        SELECT MAX(existing.seq) + 1
        FROM change_revisions AS existing
        WHERE existing.repository_id = sqlc.arg(repository_id)::bigint
          AND existing.change_id = sqlc.arg(change_id)
    ), 1),
    sqlc.arg(commit_id),
    sqlc.arg(parent_commit_id),
    COALESCE(NULLIF(sqlc.arg(source)::text, ''), 'push'),
    NULLIF(sqlc.arg(agent_session_id)::text, '')::uuid,
    NULLIF(sqlc.arg(workspace_snapshot_id)::text, '')::uuid,
    NULLIF(sqlc.arg(workspace_id)::text, '')::uuid,
    COALESCE(sqlc.arg(operation_ids)::text[], '{}'::text[])
FROM change_lock
ON CONFLICT (repository_id, change_id, commit_id)
WHERE source <> 'undo'
DO UPDATE SET commit_id = EXCLUDED.commit_id
RETURNING *;

-- name: GetChangeByChangeID :one
SELECT *
FROM changes
WHERE repository_id = $1
  AND change_id = $2;

-- name: CountChangesByRepo :one
SELECT COUNT(*)
FROM changes
WHERE repository_id = $1;

-- name: ListChangesByRepo :many
SELECT *
FROM changes
WHERE repository_id = $1
ORDER BY id DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: DeleteChangesByRepo :execrows
DELETE FROM changes
WHERE repository_id = $1;

-- name: ListChangeRevisions :many
SELECT *
FROM change_revisions
WHERE repository_id = $1
  AND change_id = $2
ORDER BY seq ASC;

-- name: DeleteIssueChangeLinksByChange :exec
DELETE FROM issue_change_links
WHERE repository_id = sqlc.arg(repository_id)
  AND change_id = sqlc.arg(change_id);

-- name: CreateIssueChangeLink :exec
INSERT INTO issue_change_links (repository_id, issue_id, change_id, link_type)
SELECT
    sqlc.arg(repository_id),
    i.id,
    sqlc.arg(change_id),
    sqlc.arg(link_type)
FROM issues AS i
WHERE i.kind <> 'chat' AND i.repository_id = sqlc.arg(repository_id)
  AND i.number = sqlc.arg(issue_number)
ON CONFLICT (repository_id, issue_id, change_id)
DO UPDATE SET link_type = EXCLUDED.link_type;

-- name: ListLinkedIssuesForChange :many
SELECT
    i.id,
    i.number,
    i.title,
    i.state,
    icl.link_type,
    icl.created_at
FROM issue_change_links AS icl
JOIN issues AS i
  ON i.repository_id = icl.repository_id
 AND i.id = icl.issue_id
WHERE i.kind <> 'chat' AND icl.repository_id = sqlc.arg(repository_id)
  AND icl.change_id = sqlc.arg(change_id)
ORDER BY i.number ASC;

-- name: GetChangeRevision :one
SELECT *
FROM change_revisions
WHERE repository_id = sqlc.arg(repository_id)
  AND change_id = sqlc.arg(change_id)
  AND seq = sqlc.arg(seq);

-- name: ListChangeReviews :many
WITH change_review_rows AS (
    SELECT
        lrr.id,
        lrr.reviewer_kind,
        CASE
            WHEN lrr.reviewer_kind = 'agent' THEN COALESCE(lrr.agent_session_id::text, 'agent')
            ELSE COALESCE(u.username, 'deleted-user')
        END::text AS reviewer,
        CASE
            WHEN lrr.reviewer_kind = 'agent' THEN COALESCE(lrr.agent_session_id::text, 'review:' || lrr.id::text)
            ELSE COALESCE(lrr.reviewer_id::text, 'review:' || lrr.id::text)
        END::text AS reviewer_key,
        lrr.type,
        COALESCE(lrr.verdict, lrr.type)::text AS verdict,
        lrr.confidence_bucket,
        lrr.body AS summary,
        COALESCE(lrr.change_revisions -> lrc.change_id ->> 'commit_id', '')::text AS commit_id,
        COALESCE((lrr.change_revisions -> lrc.change_id ->> 'seq')::bigint, 0)::bigint AS seq,
        lrr.state,
        lrr.created_at
    FROM landing_request_reviews AS lrr
    JOIN landing_request_changes AS lrc
      ON lrc.landing_request_id = lrr.landing_request_id
    JOIN landing_requests AS lr
      ON lr.id = lrr.landing_request_id
    LEFT JOIN users AS u
      ON u.id = lrr.reviewer_id
    WHERE lr.repository_id = sqlc.arg(repository_id)
      AND lrc.change_id = sqlc.arg(change_id)
), change_reviews_with_last AS (
    SELECT
        *,
        CAST(MAX(seq) OVER (PARTITION BY reviewer_kind, reviewer_key) AS bigint) AS last_reviewed_seq
    FROM change_review_rows
)
SELECT
    id,
    reviewer,
    reviewer_key,
    reviewer_kind,
    type,
    verdict,
    confidence_bucket,
    summary,
    commit_id,
    seq,
    last_reviewed_seq,
    created_at
FROM change_reviews_with_last
WHERE state = 'submitted'
ORDER BY created_at ASC, id ASC;

-- name: GetChangeLandingProvenance :one
SELECT
    lr.id AS landing_request_id,
    lr.number AS landing_request_number,
    COALESCE(lr.merged_at, lr.updated_at) AS landed_at,
    COALESCE(lander.username, '')::text AS landed_by
FROM landing_requests AS lr
JOIN landing_request_changes AS lrc ON lrc.landing_request_id = lr.id
LEFT JOIN users AS lander ON lander.id = lr.queued_by
WHERE lr.repository_id = sqlc.arg(repository_id)
  AND lrc.change_id = sqlc.arg(change_id)
  AND lr.state = 'merged'
  AND lr.merged_at IS NOT NULL
ORDER BY lr.number DESC
LIMIT 1;

-- name: ListChangeLandingApprovers :many
SELECT latest.login, latest.seq
FROM (
    SELECT DISTINCT ON (lrr.reviewer_id)
        reviewer.username::text AS login,
        (lrr.change_revisions -> sqlc.arg(change_id)::text ->> 'seq')::bigint AS seq
    FROM landing_request_reviews AS lrr
    JOIN landing_requests AS lr ON lr.id = lrr.landing_request_id
    JOIN users AS reviewer ON reviewer.id = lrr.reviewer_id
    WHERE lrr.landing_request_id = sqlc.arg(landing_request_id)
      AND lrr.type = 'approve'
      AND lrr.state = 'submitted'
      AND lrr.reviewer_id <> lr.author_id
      AND (lrr.change_revisions -> sqlc.arg(change_id)::text ->> 'seq') ~ '^[1-9][0-9]*$'
    ORDER BY lrr.reviewer_id, lrr.created_at DESC, lrr.id DESC
) AS latest
ORDER BY latest.login;

-- name: GetChangeRevisionForWalkthrough :one
SELECT *
FROM change_revisions
WHERE repository_id = sqlc.arg(repository_id)::bigint
  AND change_id = sqlc.arg(change_id)::text
  AND (
      seq = sqlc.arg(revision_seq)::bigint
      OR (
          sqlc.arg(revision_seq)::bigint = 0
          AND seq = (
              SELECT MAX(latest.seq)
              FROM change_revisions AS latest
              WHERE latest.repository_id = sqlc.arg(repository_id)::bigint
                AND latest.change_id = sqlc.arg(change_id)::text
          )
      )
  );

-- name: UpsertChangeWalkthrough :one
INSERT INTO change_walkthroughs (change_revision_id, sections, quiz)
VALUES (
    sqlc.arg(change_revision_id)::bigint,
    sqlc.arg(sections)::jsonb,
    sqlc.arg(quiz)::jsonb
)
ON CONFLICT (change_revision_id)
DO UPDATE SET
    sections = EXCLUDED.sections,
    quiz = EXCLUDED.quiz,
    updated_at = NOW()
RETURNING *;

-- name: GetChangeWalkthrough :one
SELECT cw.*
FROM change_walkthroughs AS cw
JOIN change_revisions AS cr ON cr.id = cw.change_revision_id
WHERE cr.repository_id = sqlc.arg(repository_id)::bigint
  AND cr.change_id = sqlc.arg(change_id)::text
  AND (
      cr.seq = sqlc.arg(revision_seq)::bigint
      OR (
          sqlc.arg(revision_seq)::bigint = 0
          AND cr.seq = (
              SELECT MAX(latest.seq)
              FROM change_revisions AS latest
              WHERE latest.repository_id = sqlc.arg(repository_id)::bigint
                AND latest.change_id = sqlc.arg(change_id)::text
          )
      )
  );

-- name: NotifyChangeEvent :exec
SELECT pg_notify(
    'change_' || sqlc.arg(repository_id)::bigint::text,
    sqlc.arg(payload)::text
);

-- name: GetChangeStack :one
SELECT
    lrc.landing_request_id,
    lr.number AS landing_request_number,
    lrc.position_in_stack AS position,
    lr.stack_size AS size,
    lr.turn_party,
    lr.turn_actor_id,
    lr.turn_since,
    lr.turn_reason
FROM landing_request_changes AS lrc
JOIN landing_requests AS lr ON lr.id = lrc.landing_request_id
WHERE lr.repository_id = $1
  AND lrc.change_id = $2
ORDER BY
    CASE lr.state
        WHEN 'open' THEN 0
        WHEN 'draft' THEN 1
        WHEN 'queued' THEN 2
        WHEN 'landing' THEN 3
        ELSE 4
    END,
    lr.id DESC
LIMIT 1;

-- name: StampAgentSessionRevisionsWorkspaceSnapshot :execrows
-- RFD-004: after a run completes, the workspace snapshot taken of its
-- computer is stamped on every revision the run produced that has none.
UPDATE change_revisions
SET workspace_snapshot_id = sqlc.arg(workspace_snapshot_id)::uuid
WHERE agent_session_id = sqlc.arg(agent_session_id)::uuid
  AND workspace_snapshot_id IS NULL;
