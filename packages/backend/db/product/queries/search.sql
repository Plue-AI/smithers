-- name: SearchRepositoriesFTS :many
WITH visible_repositories AS (
    SELECT r.id
    FROM repositories r
    WHERE r.is_public = TRUE

    UNION

    SELECT r.id
    FROM repositories r
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND r.user_id = sqlc.arg(viewer_id)::bigint

    UNION

    SELECT r.id
    FROM repositories r
    JOIN org_members om ON om.organization_id = r.org_id
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND om.user_id = sqlc.arg(viewer_id)::bigint
      AND om.role = 'owner'

    UNION

    SELECT tr.repository_id AS id
    FROM team_repos tr
    JOIN team_members tm ON tm.team_id = tr.team_id
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND tm.user_id = sqlc.arg(viewer_id)::bigint

    UNION

    SELECT c.repository_id AS id
    FROM collaborators c
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND c.user_id = sqlc.arg(viewer_id)::bigint
)
SELECT
    r.id,
    r.user_id,
    r.org_id,
    r.name,
    r.lower_name,
    r.description,
    r.is_public,
    r.default_bookmark,
    r.topics,
    r.num_stars,
    r.num_watches,
    r.num_issues,
    r.created_at,
    r.updated_at,
    COALESCE(u.username, o.name) AS owner_name,
    ts_rank(r.search_vector, websearch_to_tsquery('simple', sqlc.arg(query)::text)) AS rank
FROM repositories r
JOIN visible_repositories vr ON vr.id = r.id
LEFT JOIN users u ON u.id = r.user_id
LEFT JOIN organizations o ON o.id = r.org_id
WHERE r.search_vector @@ websearch_to_tsquery('simple', sqlc.arg(query)::text)
ORDER BY rank DESC, r.id DESC
LIMIT sqlc.arg(page_size)::int
OFFSET sqlc.arg(page_offset)::int;

-- name: CountSearchRepositoriesFTS :one
WITH visible_repositories AS (
    SELECT r.id
    FROM repositories r
    WHERE r.is_public = TRUE

    UNION

    SELECT r.id
    FROM repositories r
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND r.user_id = sqlc.arg(viewer_id)::bigint

    UNION

    SELECT r.id
    FROM repositories r
    JOIN org_members om ON om.organization_id = r.org_id
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND om.user_id = sqlc.arg(viewer_id)::bigint
      AND om.role = 'owner'

    UNION

    SELECT tr.repository_id AS id
    FROM team_repos tr
    JOIN team_members tm ON tm.team_id = tr.team_id
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND tm.user_id = sqlc.arg(viewer_id)::bigint

    UNION

    SELECT c.repository_id AS id
    FROM collaborators c
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND c.user_id = sqlc.arg(viewer_id)::bigint
)
SELECT COUNT(*)
FROM repositories r
JOIN visible_repositories vr ON vr.id = r.id
WHERE r.search_vector @@ websearch_to_tsquery('simple', sqlc.arg(query)::text)
;

-- name: SearchIssuesFTS :many
WITH visible_repositories AS (
    SELECT r.id
    FROM repositories r
    WHERE r.is_public = TRUE

    UNION

    SELECT r.id
    FROM repositories r
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND r.user_id = sqlc.arg(viewer_id)::bigint

    UNION

    SELECT r.id
    FROM repositories r
    JOIN org_members om ON om.organization_id = r.org_id
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND om.user_id = sqlc.arg(viewer_id)::bigint
      AND om.role = 'owner'

    UNION

    SELECT tr.repository_id AS id
    FROM team_repos tr
    JOIN team_members tm ON tm.team_id = tr.team_id
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND tm.user_id = sqlc.arg(viewer_id)::bigint

    UNION

    SELECT c.repository_id AS id
    FROM collaborators c
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND c.user_id = sqlc.arg(viewer_id)::bigint
)
SELECT
    i.id,
    i.repository_id,
    i.number,
    i.title,
    i.body,
    i.state,
    i.author_id,
    i.comment_count,
    i.closed_at,
    i.created_at,
    i.updated_at,
    r.name AS repository_name,
    COALESCE(u.username, o.name) AS owner_name,
    ts_rank(i.search_vector, websearch_to_tsquery('simple', sqlc.arg(query)::text)) AS rank
FROM issues i
JOIN repositories r ON r.id = i.repository_id
JOIN visible_repositories vr ON vr.id = r.id
LEFT JOIN users u ON u.id = r.user_id
LEFT JOIN organizations o ON o.id = r.org_id
WHERE i.kind <> 'chat' AND i.search_vector @@ websearch_to_tsquery('simple', sqlc.arg(query)::text)
  AND (
    sqlc.arg(state_filter)::text = ''
    OR i.state = sqlc.arg(state_filter)::text
  )
  AND (
    sqlc.arg(label_filter)::text = ''
    OR EXISTS (
      SELECT 1
      FROM issue_labels il
      JOIN labels l ON l.id = il.label_id
      WHERE il.issue_id = i.id
        AND l.repository_id = r.id
        AND LOWER(l.name) = LOWER(sqlc.arg(label_filter)::text)
    )
  )
  AND (
    sqlc.arg(assignee_filter)::text = ''
    OR EXISTS (
      SELECT 1
      FROM issue_assignees ia
      JOIN users au ON au.id = ia.user_id
      WHERE ia.issue_id = i.id
        AND au.lower_username = LOWER(sqlc.arg(assignee_filter)::text)
    )
  )
  AND (
    sqlc.arg(milestone_filter)::text = ''
    OR EXISTS (
      SELECT 1
      FROM milestones m
      WHERE m.id = i.milestone_id
        AND m.repository_id = r.id
        AND LOWER(m.title) = LOWER(sqlc.arg(milestone_filter)::text)
    )
  )
ORDER BY rank DESC, i.id DESC
LIMIT sqlc.arg(page_size)::int
OFFSET sqlc.arg(page_offset)::int;

-- name: CountSearchIssuesFTS :one
WITH visible_repositories AS (
    SELECT r.id
    FROM repositories r
    WHERE r.is_public = TRUE

    UNION

    SELECT r.id
    FROM repositories r
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND r.user_id = sqlc.arg(viewer_id)::bigint

    UNION

    SELECT r.id
    FROM repositories r
    JOIN org_members om ON om.organization_id = r.org_id
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND om.user_id = sqlc.arg(viewer_id)::bigint
      AND om.role = 'owner'

    UNION

    SELECT tr.repository_id AS id
    FROM team_repos tr
    JOIN team_members tm ON tm.team_id = tr.team_id
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND tm.user_id = sqlc.arg(viewer_id)::bigint

    UNION

    SELECT c.repository_id AS id
    FROM collaborators c
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND c.user_id = sqlc.arg(viewer_id)::bigint
)
SELECT COUNT(*)
FROM issues i
JOIN repositories r ON r.id = i.repository_id
JOIN visible_repositories vr ON vr.id = r.id
WHERE i.kind <> 'chat' AND i.search_vector @@ websearch_to_tsquery('simple', sqlc.arg(query)::text)
  AND (
    sqlc.arg(state_filter)::text = ''
    OR i.state = sqlc.arg(state_filter)::text
  )
  AND (
    sqlc.arg(label_filter)::text = ''
    OR EXISTS (
      SELECT 1
      FROM issue_labels il
      JOIN labels l ON l.id = il.label_id
      WHERE il.issue_id = i.id
        AND l.repository_id = r.id
        AND LOWER(l.name) = LOWER(sqlc.arg(label_filter)::text)
    )
  )
  AND (
    sqlc.arg(assignee_filter)::text = ''
    OR EXISTS (
      SELECT 1
      FROM issue_assignees ia
      JOIN users au ON au.id = ia.user_id
      WHERE ia.issue_id = i.id
        AND au.lower_username = LOWER(sqlc.arg(assignee_filter)::text)
    )
  )
  AND (
    sqlc.arg(milestone_filter)::text = ''
    OR EXISTS (
      SELECT 1
      FROM milestones m
      WHERE m.id = i.milestone_id
        AND m.repository_id = r.id
        AND LOWER(m.title) = LOWER(sqlc.arg(milestone_filter)::text)
    )
  );

-- name: SearchCodeFTS :many
WITH visible_repositories AS (
    SELECT r.id
    FROM repositories r
    WHERE r.is_public = TRUE

    UNION

    SELECT r.id
    FROM repositories r
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND r.user_id = sqlc.arg(viewer_id)::bigint

    UNION

    SELECT r.id
    FROM repositories r
    JOIN org_members om ON om.organization_id = r.org_id
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND om.user_id = sqlc.arg(viewer_id)::bigint
      AND om.role = 'owner'

    UNION

    SELECT tr.repository_id AS id
    FROM team_repos tr
    JOIN team_members tm ON tm.team_id = tr.team_id
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND tm.user_id = sqlc.arg(viewer_id)::bigint

    UNION

    SELECT c.repository_id AS id
    FROM collaborators c
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND c.user_id = sqlc.arg(viewer_id)::bigint
)
SELECT
    c.repository_id,
    r.name AS repository_name,
    COALESCE(u.username, o.name) AS owner_name,
    c.file_path,
    ts_headline(
      'simple',
      c.content,
      websearch_to_tsquery('simple', sqlc.arg(query)::text),
      'StartSel=[[HL]],StopSel=[[/HL]],MaxFragments=1,MaxWords=20,MinWords=5'
    ) AS snippet,
    ts_rank(c.search_vector, websearch_to_tsquery('simple', sqlc.arg(query)::text)) AS rank
FROM code_search_documents c
JOIN repositories r ON r.id = c.repository_id
JOIN visible_repositories vr ON vr.id = r.id
LEFT JOIN users u ON u.id = r.user_id
LEFT JOIN organizations o ON o.id = r.org_id
WHERE c.search_vector @@ websearch_to_tsquery('simple', sqlc.arg(query)::text)
ORDER BY rank DESC, c.repository_id DESC, c.file_path ASC
LIMIT sqlc.arg(page_size)::int
OFFSET sqlc.arg(page_offset)::int;

-- name: CountSearchCodeFTS :one
WITH visible_repositories AS (
    SELECT r.id
    FROM repositories r
    WHERE r.is_public = TRUE

    UNION

    SELECT r.id
    FROM repositories r
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND r.user_id = sqlc.arg(viewer_id)::bigint

    UNION

    SELECT r.id
    FROM repositories r
    JOIN org_members om ON om.organization_id = r.org_id
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND om.user_id = sqlc.arg(viewer_id)::bigint
      AND om.role = 'owner'

    UNION

    SELECT tr.repository_id AS id
    FROM team_repos tr
    JOIN team_members tm ON tm.team_id = tr.team_id
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND tm.user_id = sqlc.arg(viewer_id)::bigint

    UNION

    SELECT c.repository_id AS id
    FROM collaborators c
    WHERE sqlc.arg(viewer_id)::bigint > 0
      AND c.user_id = sqlc.arg(viewer_id)::bigint
)
SELECT COUNT(*)
FROM code_search_documents c
JOIN repositories r ON r.id = c.repository_id
JOIN visible_repositories vr ON vr.id = r.id
WHERE c.search_vector @@ websearch_to_tsquery('simple', sqlc.arg(query)::text)
;

-- name: UpsertCodeSearchDocument :one
INSERT INTO code_search_documents (
    repository_id,
    file_path,
    content
) VALUES (
    sqlc.arg(repository_id)::bigint,
    sqlc.arg(file_path)::text,
    sqlc.arg(content)::text
)
ON CONFLICT (repository_id, file_path) DO UPDATE SET
    content = EXCLUDED.content,
    updated_at = NOW()
RETURNING
    id,
    repository_id,
    file_path,
    content,
    search_vector::text AS search_vector,
    created_at,
    updated_at;

-- name: HasCodeSearchDocumentsForRepo :one
SELECT EXISTS (
    SELECT 1
    FROM code_search_documents
    WHERE repository_id = sqlc.arg(repository_id)::bigint
);

-- name: DeleteCodeSearchDocumentByPath :exec
DELETE FROM code_search_documents
WHERE repository_id = sqlc.arg(repository_id)::bigint
  AND file_path = sqlc.arg(file_path)::text;

-- name: DeleteCodeSearchDocumentsByRepo :execrows
DELETE FROM code_search_documents
WHERE repository_id = sqlc.arg(repository_id)::bigint;

-- name: SearchUsersFTS :many
SELECT
    u.id,
    u.username,
    u.display_name,
    u.avatar_url,
    u.bio,
    u.created_at,
    u.updated_at,
    ts_rank(u.search_vector, websearch_to_tsquery('simple', sqlc.arg(query)::text)) AS rank
FROM users u
WHERE u.is_active = TRUE
  AND (
    u.search_vector @@ websearch_to_tsquery('simple', sqlc.arg(query)::text)
    OR starts_with(u.lower_username, LOWER(sqlc.arg(query)::text))
    OR starts_with(LOWER(u.display_name), LOWER(sqlc.arg(query)::text))
  )
ORDER BY
  CASE
    WHEN u.lower_username = LOWER(sqlc.arg(query)::text) THEN 0
    WHEN starts_with(u.lower_username, LOWER(sqlc.arg(query)::text)) THEN 1
    WHEN starts_with(LOWER(u.display_name), LOWER(sqlc.arg(query)::text)) THEN 2
    ELSE 3
  END,
  rank DESC,
  u.id ASC
LIMIT sqlc.arg(page_size)::int
OFFSET sqlc.arg(page_offset)::int;

-- name: CountSearchUsersFTS :one
SELECT COUNT(*)
FROM users
WHERE is_active = TRUE
  AND (
    search_vector @@ websearch_to_tsquery('simple', sqlc.arg(query)::text)
    OR starts_with(lower_username, LOWER(sqlc.arg(query)::text))
    OR starts_with(LOWER(display_name), LOWER(sqlc.arg(query)::text))
  );

-- name: GetCodeSearchIndexedCommit :one
SELECT commit_id FROM code_search_index_state WHERE repository_id = $1;

-- name: SetCodeSearchIndexedCommit :exec
INSERT INTO code_search_index_state (repository_id, commit_id) VALUES ($1, $2)
ON CONFLICT (repository_id) DO UPDATE SET commit_id = EXCLUDED.commit_id;

-- name: DeleteCodeSearchDocumentsExceptPaths :exec
DELETE FROM code_search_documents
WHERE repository_id = sqlc.arg(repository_id)
  AND NOT (file_path = ANY(sqlc.arg(paths)::text[]));
