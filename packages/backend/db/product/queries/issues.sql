-- name: CreateIssue :one
INSERT INTO issues (repository_id, number, title, body, state, author_id, milestone_id, kind, idempotency_key)
VALUES ($1, get_next_issue_number($1), $2, $3, 'open', $4, $5, COALESCE(NULLIF(sqlc.arg(kind)::text,''),'issue'), sqlc.arg(idempotency_key)::text)
RETURNING *;

-- name: GetIssueByNumber :one
SELECT *
FROM issues
WHERE repository_id = $1
  AND number = $2;

-- name: GetIssueByID :one
SELECT *
FROM issues
WHERE id = $1;

-- name: ListIssuesByRepoFiltered :many
SELECT *
FROM issues
WHERE repository_id = sqlc.arg(repository_id)
  AND (kind <> 'chat' OR author_id = sqlc.arg(viewer_id)::bigint)
  AND (sqlc.arg(state)::text = '' OR state = sqlc.arg(state)::text)
ORDER BY number DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: CountIssuesByRepoFiltered :one
SELECT COUNT(*)
FROM issues
WHERE repository_id = sqlc.arg(repository_id)
  AND (kind <> 'chat' OR author_id = sqlc.arg(viewer_id)::bigint)
  AND (sqlc.arg(state)::text = '' OR state = sqlc.arg(state)::text);

-- name: UpdateIssue :one
WITH repository_lock AS MATERIALIZED (
    SELECT r.id FROM repositories r JOIN issues i ON i.repository_id = r.id
    WHERE i.id = sqlc.arg(id) FOR UPDATE OF r
)
UPDATE issues
SET title = sqlc.arg(title),
    body = sqlc.arg(body),
    state = sqlc.arg(state),
    milestone_id = sqlc.arg(milestone_id),
    closed_at = sqlc.arg(closed_at),
    fixed_by_id = sqlc.arg(fixed_by_id),
    fixed_by_agent_session_id = NULLIF(sqlc.arg(fixed_by_agent_session_id)::text, '')::uuid,
    fixed_at = sqlc.arg(fixed_at),
    verified_by_id = sqlc.arg(verified_by_id),
    verified_by_agent_session_id = NULLIF(sqlc.arg(verified_by_agent_session_id)::text, '')::uuid,
    verified_at = sqlc.arg(verified_at),
    owner_id = sqlc.arg(owner_id),
    due_on = sqlc.arg(due_on),
    priority = sqlc.arg(priority),
    parent_id = sqlc.arg(parent_id),
    updated_at = NOW()
FROM repository_lock
WHERE issues.id = sqlc.arg(id) AND issues.repository_id = repository_lock.id
RETURNING issues.*;

-- name: ListLinkedChangesForIssue :many
SELECT
    c.change_id,
    c.commit_id,
    c.description,
    icl.link_type,
    icl.created_at
FROM issue_change_links AS icl
JOIN changes AS c
  ON c.repository_id = icl.repository_id
 AND c.change_id = icl.change_id
WHERE icl.issue_id = sqlc.arg(issue_id)
ORDER BY icl.created_at ASC, c.change_id ASC;

-- name: FixIssuesForLanding :many
WITH repository_lock AS MATERIALIZED (
    SELECT r.id FROM repositories r JOIN landing_requests lr ON lr.repository_id = r.id
    WHERE lr.id = sqlc.arg(landing_request_id) FOR UPDATE OF r
), linked AS MATERIALIZED (
    SELECT
        i.id AS issue_id,
        i.state AS before_state,
        ARRAY_AGG(DISTINCT lrc.change_id ORDER BY lrc.change_id) AS change_ids
    FROM landing_requests AS lr
    JOIN repository_lock locked ON locked.id = lr.repository_id
    JOIN landing_request_changes AS lrc
      ON lrc.landing_request_id = lr.id
    JOIN issue_change_links AS icl
      ON icl.repository_id = lr.repository_id
     AND icl.change_id = lrc.change_id
    JOIN issues AS i
      ON i.repository_id = icl.repository_id
     AND i.id = icl.issue_id
    WHERE lr.id = sqlc.arg(landing_request_id)
      AND i.state NOT IN ('fixed', 'verified')
    GROUP BY i.id, i.state
), fixed AS (
    UPDATE issues AS i
    SET state = 'fixed',
        closed_at = COALESCE(i.closed_at, NOW()),
        fixed_by_id = sqlc.arg(fixed_by_id),
        fixed_by_agent_session_id = NULLIF(sqlc.arg(fixed_by_agent_session_id)::text, '')::uuid,
        fixed_at = NOW(),
        verified_by_id = NULL,
        verified_by_agent_session_id = NULL,
        verified_at = NULL,
        updated_at = NOW()
    FROM linked
    WHERE i.id = linked.issue_id
    RETURNING i.id, linked.before_state, linked.change_ids, i.fixed_at
), recorded AS (
    INSERT INTO issue_events (issue_id, actor_id, event_type, payload)
    SELECT
        fixed.id,
        sqlc.arg(fixed_by_id),
        'fixed',
        jsonb_build_object(
            'type', 'fixed',
            'before', jsonb_build_object('state', fixed.before_state),
            'after', jsonb_build_object(
                'state', 'fixed',
                'fixed_by', sqlc.arg(fixed_by_id)::bigint,
                'fixed_by_agent_session_id', NULLIF(sqlc.arg(fixed_by_agent_session_id)::text, ''),
                'fixed_at', fixed.fixed_at,
                'linked_changes', to_jsonb(fixed.change_ids),
                'landing_request_id', sqlc.arg(landing_request_id)::bigint
            )
        )
    FROM fixed
    RETURNING issue_id
)
SELECT issue_id FROM recorded ORDER BY issue_id;

-- name: AddIssueAssignee :one
-- ON CONFLICT DO NOTHING handles the partial unique index
-- uq_issue_assignees_issue_user (active rows only).
WITH repository_lock AS MATERIALIZED (
    SELECT r.id FROM repositories r JOIN issues i ON i.repository_id = r.id
    WHERE i.id = $1 FOR UPDATE OF r
)
INSERT INTO issue_assignees (issue_id, user_id)
SELECT $1, $2 FROM repository_lock
ON CONFLICT DO NOTHING
RETURNING *;

-- name: DeleteIssueAssignees :exec
WITH repository_lock AS MATERIALIZED (
    SELECT r.id FROM repositories r JOIN issues i ON i.repository_id = r.id
    WHERE i.id = $1 FOR UPDATE OF r
)
DELETE FROM issue_assignees USING repository_lock
WHERE issue_id = $1;

-- name: DeleteIssueLabels :exec
WITH repository_lock AS MATERIALIZED (
    SELECT r.id FROM repositories r JOIN issues i ON i.repository_id = r.id
    WHERE i.id = $1 FOR UPDATE OF r
)
DELETE FROM issue_labels USING repository_lock
WHERE issue_id = $1;

-- name: ReplaceIssueAssignees :exec
-- Replaces the issue's assignee set in one statement. Set-diff, not
-- delete-all + re-add, so unchanged rows fire no issue_state_facts or
-- repository_job_events. Tombstones (user_id NULL from ON DELETE SET NULL) are
-- always removed. COALESCE: pgx encodes a nil slice as NULL, and
-- `<> ALL(NULL)` is NULL. ON CONFLICT DO NOTHING absorbs a concurrent
-- AddIssueAssignee for the same user (partial index
-- uq_issue_assignees_issue_user).
WITH repository_lock AS MATERIALIZED (
    SELECT r.id FROM repositories r JOIN issues i ON i.repository_id = r.id
    WHERE i.id = sqlc.arg(issue_id) FOR UPDATE OF r
), wanted AS (
    SELECT DISTINCT u AS user_id
    FROM UNNEST(COALESCE(sqlc.arg(user_ids)::bigint[], '{}'::bigint[])) AS u
), removed AS (
    DELETE FROM issue_assignees USING repository_lock
    WHERE issue_assignees.issue_id = sqlc.arg(issue_id)
      AND (issue_assignees.user_id IS NULL
           OR issue_assignees.user_id <> ALL(COALESCE(sqlc.arg(user_ids)::bigint[], '{}'::bigint[])))
)
INSERT INTO issue_assignees (issue_id, user_id)
SELECT sqlc.arg(issue_id), w.user_id FROM wanted w, repository_lock
WHERE NOT EXISTS (
    SELECT 1 FROM issue_assignees ia
    WHERE ia.issue_id = sqlc.arg(issue_id) AND ia.user_id = w.user_id
)
ON CONFLICT DO NOTHING;

-- name: ReplaceIssueLabels :exec
-- Replaces the issue's label set in one statement. Set-diff, so unchanged
-- labels fire no unlabeled/labeled journal facts or job events.
WITH repository_lock AS MATERIALIZED (
    SELECT r.id FROM repositories r JOIN issues i ON i.repository_id = r.id
    WHERE i.id = sqlc.arg(issue_id) FOR UPDATE OF r
), wanted AS (
    SELECT DISTINCT l AS label_id
    FROM UNNEST(COALESCE(sqlc.arg(label_ids)::bigint[], '{}'::bigint[])) AS l
), removed AS (
    DELETE FROM issue_labels USING repository_lock
    WHERE issue_labels.issue_id = sqlc.arg(issue_id)
      AND issue_labels.label_id <> ALL(COALESCE(sqlc.arg(label_ids)::bigint[], '{}'::bigint[]))
)
INSERT INTO issue_labels (issue_id, label_id, added_by)
SELECT sqlc.arg(issue_id), w.label_id, sqlc.narg(added_by)::bigint FROM wanted w, repository_lock
WHERE NOT EXISTS (
    SELECT 1 FROM issue_labels il
    WHERE il.issue_id = sqlc.arg(issue_id) AND il.label_id = w.label_id
)
ON CONFLICT DO NOTHING;

-- name: ListIssueAssignees :many
-- Excludes tombstone rows (user_id IS NULL from ON DELETE SET NULL) since
-- the user record is gone and there is nothing to display.
SELECT u.id, u.username, u.display_name, u.avatar_url
FROM issue_assignees ia
JOIN users u ON u.id = ia.user_id
WHERE ia.issue_id = $1
  AND ia.user_id IS NOT NULL
ORDER BY u.username ASC;

-- name: CreateIssueComment :one
WITH repository_lock AS MATERIALIZED (
    SELECT r.id FROM repositories r JOIN issues i ON i.repository_id = r.id
    WHERE i.id = $1 FOR UPDATE OF r
)
INSERT INTO issue_comments (issue_id, user_id, body, commenter, type, persona, idempotency_key)
SELECT $1, $2, $3, $4, 'comment', COALESCE(sqlc.narg(persona)::jsonb,'{}'::jsonb), sqlc.arg(idempotency_key)::text FROM repository_lock
WHERE NOT EXISTS (SELECT 1 FROM issue_comment_keys k WHERE k.issue_id=$1 AND k.user_id=$2 AND k.key=sqlc.arg(idempotency_key)::text AND (k.request_hash <> digest(jsonb_build_array($3::text,COALESCE(sqlc.narg(persona)::jsonb,'{}'::jsonb))::text,'sha256') OR NOT EXISTS (SELECT 1 FROM issue_comments c WHERE c.id=k.comment_id)))
ON CONFLICT (issue_id,user_id,idempotency_key) WHERE idempotency_key<>''
DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
WHERE (issue_comments.body=EXCLUDED.body AND issue_comments.persona=EXCLUDED.persona)
 OR EXISTS (SELECT 1 FROM issue_comment_keys k WHERE k.issue_id=EXCLUDED.issue_id AND k.user_id=EXCLUDED.user_id AND k.key=EXCLUDED.idempotency_key AND k.request_hash=digest(jsonb_build_array(EXCLUDED.body,EXCLUDED.persona)::text,'sha256'))
RETURNING *;

-- name: CreateIssueEvent :one
INSERT INTO issue_events (issue_id, actor_id, event_type, payload)
VALUES (
    sqlc.arg(issue_id),
    sqlc.arg(actor_id),
    sqlc.arg(event_type),
    sqlc.arg(payload)
)
RETURNING *;

-- name: ListIssueComments :many
SELECT *
FROM issue_comments
WHERE issue_id = $1
ORDER BY created_at ASC, id ASC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: ListIssueEventsByIssue :many
SELECT *
FROM issue_events
WHERE issue_id = sqlc.arg(issue_id)
ORDER BY created_at ASC, id ASC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: CountIssueCommentsByIssue :one
SELECT COUNT(*)
FROM issue_comments
WHERE issue_id = $1;

-- name: GetIssueCommentByID :one
SELECT *
FROM issue_comments
WHERE id = $1;

-- name: UpdateIssueComment :one
UPDATE issue_comments
SET body = sqlc.arg(body),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: DeleteIssueComment :exec
WITH repository_lock AS MATERIALIZED (
    SELECT r.id FROM repositories r JOIN issues i ON i.repository_id = r.id
    JOIN issue_comments c ON c.issue_id = i.id WHERE c.id = $1 FOR UPDATE OF r
)
DELETE FROM issue_comments USING repository_lock
WHERE issue_comments.id = $1;

-- name: GetIssueByCommentID :one
SELECT i.*
FROM issues i
JOIN issue_comments ic ON ic.issue_id = i.id
WHERE ic.id = $1;

-- issues.comment_count and repositories.num_issues / num_closed_issues are
-- maintained by database triggers (trg_issue_comments_count_*,
-- trg_issues_repo_counts_*); there are intentionally no increment/decrement
-- queries for them.

-- name: ListIssuesByRepoFilteredKeyset :many
-- Stable cursor pagination: returns issues with number < after_number (DESC),
-- or all issues when after_number = 0 (first page).
SELECT *
FROM issues
WHERE repository_id = sqlc.arg(repository_id)
  AND (kind <> 'chat' OR author_id = sqlc.arg(viewer_id)::bigint)
  AND (sqlc.arg(state)::text = '' OR state = sqlc.arg(state)::text)
  AND (sqlc.arg(after_number)::bigint = 0 OR number < sqlc.arg(after_number)::bigint)
ORDER BY number DESC
LIMIT sqlc.arg(page_size);

-- name: ListIssueCommentsByIssueKeyset :many
-- Stable cursor pagination for issue comments: returns comments with id > after_id (ASC),
-- or all comments when after_id = 0 (first page).
SELECT *
FROM issue_comments
WHERE issue_id = sqlc.arg(issue_id)
  AND (sqlc.arg(after_id)::bigint = 0 OR id > sqlc.arg(after_id)::bigint)
ORDER BY id ASC
LIMIT sqlc.arg(page_size);

-- name: SetIssueTextEditor :exec
-- Names the person who writes issue titles and bodies in this transaction
-- (record_issue_text_editor), or the agent source that writes them for no
-- person; an empty editor and source name no one.
SELECT set_config('smithers.issue_text_editor', sqlc.arg(editor)::text, true),
    set_config('smithers.issue_text_source', sqlc.arg(source)::text, true);
