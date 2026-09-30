-- name: CountWikiPagesByRepo :one
SELECT COUNT(*)
FROM wiki_pages
WHERE repository_id = $1 AND visibility = coalesce(nullif(sqlc.arg(visibility)::text,''),'public');

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
    wp.visibility, wp.path, wp.content_digest, wp.attachment,
    u.username AS author_username
FROM wiki_pages wp
JOIN users u ON u.id = wp.author_id
WHERE wp.repository_id = $1 AND wp.visibility = coalesce(nullif(sqlc.arg(visibility)::text,''),'public')
ORDER BY wp.updated_at DESC, wp.id DESC
LIMIT $2 OFFSET $3;

-- name: CountSearchWikiPagesByRepo :one
SELECT COUNT(*)
FROM wiki_pages
WHERE repository_id = sqlc.arg(repository_id) AND visibility = coalesce(nullif(sqlc.arg(visibility)::text,''),'public')
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
    wp.visibility, wp.path, wp.content_digest, wp.attachment,
    u.username AS author_username
FROM wiki_pages wp
JOIN users u ON u.id = wp.author_id
WHERE wp.repository_id = sqlc.arg(repository_id) AND wp.visibility = coalesce(nullif(sqlc.arg(visibility)::text,''),'public')
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
    wp.visibility, wp.path, wp.content_digest, wp.attachment,
    u.username AS author_username
FROM wiki_pages wp
JOIN users u ON u.id = wp.author_id
WHERE wp.repository_id = $1 AND wp.visibility = coalesce(nullif(sqlc.arg(visibility)::text,''),'public') AND wp.slug = $2;

-- name: CreateWikiPage :one
INSERT INTO wiki_pages (repository_id, slug, title, body, author_id, visibility, path)
VALUES ($1, $2, $3, $4, $5, coalesce(nullif(sqlc.arg(visibility)::text,''),'public'), sqlc.arg(path))
RETURNING *;

-- name: UpdateWikiPage :one
UPDATE wiki_pages
SET path = sqlc.arg(path), slug = $2,
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

-- name: GetWikiSpaceHead :one
-- The last committed event sequence of one wiki, 0 before its first event.
SELECT coalesce(max(head), 0)::bigint AS head FROM wiki_spaces WHERE repository_id = $1 AND visibility = $2;

-- name: ListWikiIndex :many
SELECT wp.*, u.username AS author_username
FROM wiki_pages wp JOIN users u ON u.id = wp.author_id
WHERE wp.repository_id = $1 AND wp.visibility = sqlc.arg(visibility)
ORDER BY wp.id;

-- name: CreateWikiAttachment :one
INSERT INTO wiki_pages(repository_id,visibility,slug,path,title,body,author_id,attachment)
VALUES($1,$2,$3,$4,$5,'',$6,$7) RETURNING *;

-- name: UpdateWikiAttachment :one
UPDATE wiki_pages SET attachment=sqlc.arg(attachment), path=sqlc.arg(path),title=sqlc.arg(title),author_id=sqlc.arg(author_id),updated_at=now(),last_update_id=NULL,last_update=NULL
WHERE id=sqlc.arg(page_id) AND repository_id=sqlc.arg(repository_id) AND revision=sqlc.arg(expected_revision) AND attachment IS NOT NULL
RETURNING *;

-- name: ListWikiEvents :many
SELECT * FROM wiki_page_revisions WHERE repository_id=$1 AND visibility=$2 AND sequence>$3 ORDER BY sequence LIMIT $4;

-- name: GetWikiRevisionByNumber :one
SELECT * FROM wiki_page_revisions WHERE repository_id=$1 AND visibility=$2 AND page_id=$3 AND revision=$4;

-- name: GetWikiLatestRevision :one
SELECT * FROM wiki_page_revisions WHERE repository_id=$1 AND visibility=$2 AND page_id=$3 ORDER BY revision DESC LIMIT 1;
