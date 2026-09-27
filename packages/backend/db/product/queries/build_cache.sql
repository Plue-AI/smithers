-- name: GetBuildCacheEntry :one
UPDATE build_cache_entries
SET last_accessed_at = NOW(),
    access_count = CASE WHEN access_count < 9223372036854775807 THEN access_count + 1 ELSE access_count END
WHERE repository_id = sqlc.arg(repository_id)
  AND key_digest = sqlc.arg(key_digest)
RETURNING body;

-- name: InsertBuildCacheEntry :one
INSERT INTO build_cache_entries (
    repository_id, key_digest, body, result_canonical, created_at_ms, recorded_run_id, recorded_event_seq
)
VALUES (
    sqlc.arg(repository_id), sqlc.arg(key_digest), sqlc.arg(body), sqlc.arg(result_canonical),
    sqlc.narg(created_at_ms), sqlc.narg(recorded_run_id), sqlc.narg(recorded_event_seq)
)
ON CONFLICT (repository_id, key_digest) DO NOTHING
RETURNING key_digest;

-- name: LockBuildCacheEntry :one
SELECT (result_canonical = sqlc.arg(result_canonical)::text) AS same
FROM build_cache_entries
WHERE repository_id = sqlc.arg(repository_id)
  AND key_digest = sqlc.arg(key_digest)
FOR NO KEY UPDATE;

-- name: TouchBuildCacheEntry :exec
UPDATE build_cache_entries
SET last_accessed_at = NOW(),
    access_count = CASE WHEN access_count < 9223372036854775807 THEN access_count + 1 ELSE access_count END
WHERE repository_id = sqlc.arg(repository_id)
  AND key_digest = sqlc.arg(key_digest);

-- name: RecordBuildCacheEntryArtifacts :exec
WITH present AS (
    SELECT a.digest
    FROM build_cache_artifacts AS a
    WHERE a.repository_id = sqlc.arg(repository_id)
      AND a.digest = ANY(sqlc.arg(digests)::char(64)[])
    ORDER BY a.digest
    FOR KEY SHARE
)
INSERT INTO build_cache_entry_artifacts (repository_id, key_digest, digest)
SELECT sqlc.arg(repository_id), sqlc.arg(key_digest), present.digest
FROM present
ON CONFLICT DO NOTHING;

-- name: DeleteBuildCacheEntry :one
DELETE FROM build_cache_entries
WHERE repository_id = sqlc.arg(repository_id)
  AND key_digest = sqlc.arg(key_digest)
RETURNING key_digest;

-- name: DeleteBuildCacheEntryFenced :one
DELETE FROM build_cache_entries
WHERE repository_id = sqlc.arg(repository_id)
  AND key_digest = sqlc.arg(key_digest)
  AND recorded_run_id = sqlc.arg(recorded_run_id)
  AND recorded_event_seq = sqlc.arg(recorded_event_seq)
RETURNING key_digest;

-- name: GetBuildCacheArtifact :one
UPDATE build_cache_artifacts
SET last_accessed_at = NOW(),
    access_count = CASE WHEN access_count < 9223372036854775807 THEN access_count + 1 ELSE access_count END
WHERE repository_id = sqlc.arg(repository_id)
  AND digest = sqlc.arg(digest)
RETURNING digest, size_bytes, gcs_key;

-- name: InsertBuildCacheArtifact :one
INSERT INTO build_cache_artifacts (repository_id, digest, size_bytes, gcs_key)
VALUES (sqlc.arg(repository_id), sqlc.arg(digest), sqlc.arg(size_bytes), sqlc.arg(gcs_key))
ON CONFLICT (repository_id, digest) DO NOTHING
RETURNING digest;

-- name: LockBuildCacheArtifact :one
SELECT digest, size_bytes, gcs_key
FROM build_cache_artifacts
WHERE repository_id = sqlc.arg(repository_id)
  AND digest = sqlc.arg(digest)
FOR NO KEY UPDATE;

-- name: TouchBuildCacheArtifact :exec
UPDATE build_cache_artifacts
SET last_accessed_at = NOW(),
    access_count = CASE WHEN access_count < 9223372036854775807 THEN access_count + 1 ELSE access_count END
WHERE repository_id = sqlc.arg(repository_id)
  AND digest = sqlc.arg(digest);

-- name: RepairBuildCacheArtifact :exec
UPDATE build_cache_artifacts
SET size_bytes = sqlc.arg(size_bytes),
    gcs_key = sqlc.arg(gcs_key),
    last_accessed_at = NOW()
WHERE repository_id = sqlc.arg(repository_id)
  AND digest = sqlc.arg(digest);

-- name: ListPresentBuildCacheArtifacts :many
UPDATE build_cache_artifacts
SET last_accessed_at = NOW(),
    access_count = CASE WHEN access_count < 9223372036854775807 THEN access_count + 1 ELSE access_count END
WHERE repository_id = sqlc.arg(repository_id)
  AND digest = ANY(sqlc.arg(digests)::char(64)[])
RETURNING digest;

-- name: CreateBuildCacheReadToken :one
INSERT INTO build_cache_read_tokens (repository_id, created_by, name, token_hash, token_last_eight, namespace_prefix)
VALUES (sqlc.arg(repository_id), sqlc.narg(created_by), sqlc.arg(name), sqlc.arg(token_hash), sqlc.arg(token_last_eight), sqlc.arg(namespace_prefix))
RETURNING *;

-- name: ListBuildCacheReadTokens :many
SELECT *
FROM build_cache_read_tokens
WHERE repository_id = sqlc.arg(repository_id)
  AND revoked_at IS NULL
ORDER BY created_at DESC, id DESC;

-- name: GetActiveBuildCacheReadTokenByHash :one
SELECT *
FROM build_cache_read_tokens
WHERE token_hash = sqlc.arg(token_hash)
  AND revoked_at IS NULL;

-- name: TouchBuildCacheReadToken :exec
UPDATE build_cache_read_tokens
SET last_used_at = NOW()
WHERE id = sqlc.arg(id);

-- name: RevokeBuildCacheReadToken :one
UPDATE build_cache_read_tokens
SET revoked_at = NOW()
WHERE id = sqlc.arg(id)
  AND repository_id = sqlc.arg(repository_id)
  AND revoked_at IS NULL
RETURNING id;
