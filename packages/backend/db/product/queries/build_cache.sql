-- name: GetBuildCacheEntry :one
UPDATE build_cache_entries
SET last_accessed_at = NOW(),
    access_count = CASE WHEN access_count < 9223372036854775807 THEN access_count + 1 ELSE access_count END
WHERE build_cache_entries.repository_id = sqlc.arg(repository_id)
  AND build_cache_entries.key_digest = sqlc.arg(key_digest)
  AND build_cache_entries.created_at > sqlc.arg(cutoff)::timestamptz
  AND NOT EXISTS (
    SELECT 1 FROM build_cache_entry_artifacts r
    JOIN build_cache_artifacts a ON a.repository_id = r.repository_id AND a.digest = r.digest
    WHERE r.repository_id = build_cache_entries.repository_id
      AND r.key_digest = build_cache_entries.key_digest
      AND a.created_at <= sqlc.arg(cutoff)::timestamptz
  )
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
  AND created_at > sqlc.arg(cutoff)::timestamptz
RETURNING digest, size_bytes, gcs_key, created_at;

-- name: InsertBuildCacheArtifact :one
INSERT INTO build_cache_artifacts (repository_id, digest, size_bytes, gcs_key)
VALUES (sqlc.arg(repository_id), sqlc.arg(digest), sqlc.arg(size_bytes), sqlc.arg(gcs_key))
ON CONFLICT (repository_id, digest) DO NOTHING
RETURNING digest;

-- name: LockBuildCacheArtifact :one
SELECT digest, size_bytes, gcs_key, created_at
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
    created_at = NOW(),
    last_accessed_at = NOW()
WHERE repository_id = sqlc.arg(repository_id)
  AND digest = sqlc.arg(digest);

-- name: ListPresentBuildCacheArtifacts :many
UPDATE build_cache_artifacts
SET last_accessed_at = NOW(),
    access_count = CASE WHEN access_count < 9223372036854775807 THEN access_count + 1 ELSE access_count END
WHERE repository_id = sqlc.arg(repository_id)
  AND digest = ANY(sqlc.arg(digests)::char(64)[])
  AND created_at > sqlc.arg(cutoff)::timestamptz
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

-- name: ExpireBuildCacheEntries :exec
WITH candidates AS (
    (SELECT e.key_digest FROM build_cache_entries e
     WHERE e.repository_id = sqlc.arg(repository_id) AND e.created_at <= sqlc.arg(cutoff)::timestamptz
     ORDER BY e.created_at, e.key_digest LIMIT 64)
    UNION
    (SELECT r.key_digest FROM build_cache_entry_artifacts r
     JOIN (
       SELECT a.digest FROM build_cache_artifacts a
       WHERE a.repository_id = sqlc.arg(repository_id) AND a.created_at <= sqlc.arg(cutoff)::timestamptz
       ORDER BY a.created_at, a.digest LIMIT 16
     ) expired ON expired.digest = r.digest
     WHERE r.repository_id = sqlc.arg(repository_id) LIMIT 64)
), doomed AS (SELECT key_digest FROM candidates LIMIT 64)
DELETE FROM build_cache_entries e USING doomed d
WHERE e.repository_id = sqlc.arg(repository_id) AND e.key_digest = d.key_digest;

-- name: ExpireBuildCacheArtifacts :many
WITH doomed AS (
    SELECT a.digest FROM build_cache_artifacts a
    WHERE a.repository_id = sqlc.arg(repository_id) AND a.created_at <= sqlc.arg(cutoff)::timestamptz
      AND NOT EXISTS (SELECT 1 FROM build_cache_entry_artifacts r
                      WHERE r.repository_id = a.repository_id AND r.digest = a.digest)
    ORDER BY a.created_at, a.digest LIMIT 16
)
DELETE FROM build_cache_artifacts a USING doomed d
WHERE a.repository_id = sqlc.arg(repository_id) AND a.digest = d.digest
RETURNING a.gcs_key;

-- name: BuildCacheRepositoryBytes :one
SELECT COALESCE((SELECT size_bytes FROM build_cache_repository_usage
WHERE repository_id = sqlc.arg(repository_id)), 0)::bigint AS bytes;

-- name: ListExpiredBuildCacheRepositories :many
SELECT DISTINCT repository_id FROM (
    (SELECT e.repository_id FROM build_cache_entries e
     WHERE e.created_at <= sqlc.arg(cutoff)::timestamptz ORDER BY e.created_at LIMIT 64)
    UNION ALL
    (SELECT a.repository_id FROM build_cache_artifacts a
     WHERE a.created_at <= sqlc.arg(cutoff)::timestamptz ORDER BY a.created_at LIMIT 64)
) expired;
