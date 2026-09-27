-- name: CountWikiPagesByRepo :one
SELECT COUNT(*)
FROM wiki_pages
WHERE repository_id = $1;

-- name: ListWikiPagesByRepo :many
SELECT
    wp.id,
    wp.repository_id,
    wp.slug,
    wp.title,
    wp.body,
    wp.author_id,
    wp.created_at,
    wp.updated_at,
    wp.revision,
    u.username AS author_username
FROM wiki_pages wp
JOIN users u ON u.id = wp.author_id
WHERE wp.repository_id = $1
ORDER BY wp.updated_at DESC, wp.id DESC
LIMIT $2 OFFSET $3;

-- name: CountSearchWikiPagesByRepo :one
SELECT COUNT(*)
FROM wiki_pages
WHERE repository_id = sqlc.arg(repository_id)
  AND (
    strpos(lower(title), lower(sqlc.arg(query)::text)) > 0
    OR strpos(lower(slug), lower(sqlc.arg(query)::text)) > 0
    OR strpos(lower(body), lower(sqlc.arg(query)::text)) > 0
  );

-- name: SearchWikiPagesByRepo :many
SELECT
    wp.id,
    wp.repository_id,
    wp.slug,
    wp.title,
    wp.body,
    wp.author_id,
    wp.created_at,
    wp.updated_at,
    wp.revision,
    u.username AS author_username
FROM wiki_pages wp
JOIN users u ON u.id = wp.author_id
WHERE wp.repository_id = sqlc.arg(repository_id)
  AND (
    strpos(lower(wp.title), lower(sqlc.arg(query)::text)) > 0
    OR strpos(lower(wp.slug), lower(sqlc.arg(query)::text)) > 0
    OR strpos(lower(wp.body), lower(sqlc.arg(query)::text)) > 0
  )
ORDER BY
    CASE
        WHEN lower(wp.slug) = lower(sqlc.arg(query)::text) THEN 0
        WHEN lower(wp.title) = lower(sqlc.arg(query)::text) THEN 1
        WHEN starts_with(lower(wp.title), lower(sqlc.arg(query)::text)) THEN 2
        WHEN starts_with(lower(wp.slug), lower(sqlc.arg(query)::text)) THEN 3
        ELSE 4
    END,
    wp.updated_at DESC,
    wp.id DESC
LIMIT sqlc.arg(page_size) OFFSET sqlc.arg(page_offset);

-- name: GetWikiPageBySlug :one
SELECT
    wp.id,
    wp.repository_id,
    wp.slug,
    wp.title,
    wp.body,
    wp.author_id,
    wp.created_at,
    wp.updated_at,
    wp.revision,
    u.username AS author_username
FROM wiki_pages wp
JOIN users u ON u.id = wp.author_id
WHERE wp.repository_id = $1 AND wp.slug = $2;

-- name: CreateWikiPage :one
INSERT INTO wiki_pages (repository_id, slug, title, body, author_id)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: UpdateWikiPage :one
UPDATE wiki_pages
SET slug = $2,
    title = $3,
    body = $4,
    author_id = $5,
    updated_at = NOW(),
    last_update_id = NULL, last_update = NULL
WHERE id = $1 AND crdt_state IS NULL AND revision = sqlc.arg(expected_revision)
RETURNING *;

-- name: DeleteWikiPage :execrows
-- A null expected_revision deletes whatever the page holds.
DELETE FROM wiki_pages
WHERE id = sqlc.arg(id)
  AND (sqlc.narg(expected_revision)::bigint IS NULL OR revision = sqlc.narg(expected_revision));
