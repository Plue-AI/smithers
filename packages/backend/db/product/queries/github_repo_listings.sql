-- ---- GitHub repo listing cache (stale-while-revalidate /user/repos) ----

-- name: GetGitHubRepoListing :one
SELECT *
FROM github_repo_listings
WHERE user_id = $1;

-- name: UpsertGitHubRepoListing :one
-- Store a fresh last-good listing. Clears any recorded sync error and
-- releases the singleflight claim.
INSERT INTO github_repo_listings (user_id, payload, synced_at, sync_error, syncing_since)
VALUES (sqlc.arg(user_id), sqlc.arg(payload), NOW(), NULL, NULL)
ON CONFLICT (user_id) DO UPDATE
SET payload = EXCLUDED.payload,
    synced_at = NOW(),
    sync_error = NULL,
    syncing_since = NULL,
    updated_at = NOW()
RETURNING *;

-- name: ClaimGitHubRepoListingSync :execrows
-- Singleflight claim for a background refresh: only one caller wins while a
-- claim is live, and a completed refresh prevents stale readers reclaiming it;
-- claims older than 2 minutes are considered abandoned (the
-- refresher crashed or timed out) and may be taken over.
UPDATE github_repo_listings
SET syncing_since = NOW(),
    updated_at = NOW()
WHERE user_id = sqlc.arg(user_id)
  AND synced_at < NOW() - INTERVAL '5 minutes'
  AND (syncing_since IS NULL OR syncing_since < NOW() - INTERVAL '2 minutes');

-- name: SetGitHubRepoListingSyncError :exec
-- Record a background refresh failure WITHOUT touching the last-good payload,
-- and release the singleflight claim.
UPDATE github_repo_listings
SET sync_error = sqlc.arg(sync_error)::text,
    syncing_since = NULL,
    updated_at = NOW()
WHERE user_id = sqlc.arg(user_id);

-- name: DeleteGitHubRepoListing :exec
-- Invalidate a user's cached listing. Used when a background refresh proves
-- the stored GitHub credential is definitively gone (revoked/unlinked): the
-- next request must block on the live path and surface the honest 401 that
-- clients key their reconnect CTA off, instead of stale repos forever.
DELETE FROM github_repo_listings
WHERE user_id = sqlc.arg(user_id);
