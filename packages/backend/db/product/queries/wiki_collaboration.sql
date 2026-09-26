-- name: GetWikiDocument :one
SELECT wp.*, u.username AS author_username
FROM wiki_pages wp JOIN users u ON u.id = wp.author_id
WHERE wp.repository_id = $1 AND wp.slug = $2 AND wp.visibility = coalesce(nullif(sqlc.arg(visibility)::text,''),'public');

-- name: WriteWikiDocument :one
UPDATE wiki_pages
SET path = sqlc.arg(path), body = sqlc.arg(body), crdt_state = sqlc.arg(crdt_state), crdt_vector = sqlc.arg(crdt_vector),
    last_update_id = sqlc.narg(update_id), last_update = sqlc.arg(update_bytes),
    author_id = sqlc.arg(author_id), title = sqlc.arg(title), slug = sqlc.arg(slug), updated_at = NOW()
WHERE id = sqlc.arg(page_id) AND repository_id = sqlc.arg(repository_id) AND revision = sqlc.arg(expected_revision)
RETURNING *;

-- name: GetWikiUpdateReceipt :one
SELECT * FROM wiki_page_revisions WHERE page_id = $1 AND update_id = $2;

-- name: CountWikiRevisions :one
SELECT count(*) FROM wiki_page_revisions WHERE repository_id = $1 AND page_id = $2;

-- name: ListWikiRevisions :many
SELECT * FROM wiki_page_revisions WHERE repository_id = $1 AND page_id = $2
ORDER BY revision DESC LIMIT $3 OFFSET $4;

-- name: ListWikiUpdatesAfter :many
SELECT * FROM wiki_page_revisions
WHERE repository_id = $1 AND page_id = $2 AND revision > $3
ORDER BY revision LIMIT $4;

-- name: ListWikiHistoryPending :many
SELECT * FROM wiki_page_revisions WHERE repository_id = $1 AND history_commit_id = ''
ORDER BY id LIMIT $2;

-- name: MarkWikiHistoryProjected :execrows
UPDATE wiki_page_revisions SET history_commit_id = $2
WHERE id = $1 AND history_commit_id = '';

-- name: InitializeWikiDocument :execrows
UPDATE wiki_pages SET crdt_state = sqlc.arg(crdt_state), crdt_vector = sqlc.arg(crdt_vector)
WHERE id = sqlc.arg(page_id) AND repository_id = sqlc.arg(repository_id)
  AND revision = sqlc.arg(expected_revision) AND crdt_state IS NULL;

-- name: GetWikiPageIdentity :one
SELECT page_id, slug FROM wiki_page_revisions
WHERE repository_id = $1 AND page_id = $2 AND slug = $3 AND visibility = coalesce(nullif(sqlc.arg(visibility)::text,''),'public') ORDER BY revision DESC LIMIT 1;

-- name: ListWikiHistoryRecovery :many
SELECT wr.*, ns.lower_slug AS owner_name, r.name AS repo_name
FROM wiki_page_revisions wr JOIN repositories r ON r.id = wr.repository_id
JOIN owner_namespaces ns ON (ns.owner_type = 'user' AND ns.user_id = r.user_id)
 OR (ns.owner_type = 'org' AND ns.org_id = r.org_id)
WHERE wr.visibility = 'public' AND wr.attachment IS NULL AND wr.history_commit_id = '' AND NOT EXISTS (
 SELECT 1 FROM wiki_page_revisions prior
 WHERE prior.page_id = wr.page_id AND prior.revision < wr.revision AND prior.history_commit_id = ''
)
ORDER BY wr.id LIMIT $1;

-- name: LockWikiHistoryRepository :one
SELECT r.id, r.name AS repo_name, ns.lower_slug AS owner_name
FROM repositories r JOIN owner_namespaces ns
 ON (ns.owner_type = 'user' AND ns.user_id = r.user_id)
 OR (ns.owner_type = 'org' AND ns.org_id = r.org_id)
WHERE r.id = $1 FOR SHARE OF r;

-- name: DeleteWikiPageAsActor :execrows
WITH actor AS MATERIALIZED (
 SELECT set_config('smithers.wiki_actor_id', sqlc.arg(actor_id)::bigint::text, true) AS configured
)
DELETE FROM wiki_pages WHERE id = sqlc.arg(page_id)
AND (sqlc.narg(expected_revision)::bigint IS NULL OR revision = sqlc.narg(expected_revision))
AND (SELECT configured FROM actor) IS NOT NULL;
