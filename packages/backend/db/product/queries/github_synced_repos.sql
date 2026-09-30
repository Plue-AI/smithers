-- ---- GitHub sync registry + metadata store (continuously-synced mirror) ----

-- name: GetGitHubSyncedRepo :one
SELECT *
FROM github_synced_repos
WHERE owner_login_lower = LOWER(sqlc.arg(owner_login)::text)
  AND repo_name_lower = LOWER(sqlc.arg(repo_name)::text);

-- name: EnrollGitHubSyncedRepo :one
-- Idempotent enrollment. Re-enrolling never downgrades an existing row: sync
-- kinds are OR-ed on, a known installation id is not overwritten with NULL, and
-- enrolled_via keeps the FIRST (strongest) provenance so a lazy read cannot
-- relabel a repo that was enrolled by import.
--
-- A slug row bound to a DIFFERENT GitHub repo id is a different repository
-- that previously held the slug (renamed or transferred away, then the name
-- was reused). It is rebound to the incoming id, its synced issues and
-- comments are dropped, and its sync bookkeeping restarts, so the old repo's
-- metadata is never served as the new repo's. A row that already holds the
-- incoming id under another slug is the service's to adopt first; see
-- GitHubSyncedRepoService.EnrollGitHubRepo.
WITH rebound AS (
    SELECT g.id
    FROM github_synced_repos g
    WHERE g.owner_login_lower = LOWER(sqlc.arg(owner_login)::text)
      AND g.repo_name_lower = LOWER(sqlc.arg(repo_name)::text)
      AND g.github_repository_id <> sqlc.narg(github_repository_id)::bigint
),
dropped_issues AS (
    DELETE FROM github_synced_issues
    WHERE synced_repo_id IN (SELECT id FROM rebound)
),
dropped_comments AS (
    DELETE FROM github_synced_issue_comments
    WHERE synced_repo_id IN (SELECT id FROM rebound)
)
INSERT INTO github_synced_repos (
    owner_login, owner_login_lower, repo_name, repo_name_lower,
    installation_id, github_repository_id, sync_refs, sync_metadata, enrolled_via
)
VALUES (
    sqlc.arg(owner_login)::text,
    LOWER(sqlc.arg(owner_login)::text),
    sqlc.arg(repo_name)::text,
    LOWER(sqlc.arg(repo_name)::text),
    sqlc.narg(installation_id)::bigint,
    sqlc.narg(github_repository_id)::bigint,
    sqlc.arg(sync_refs)::boolean,
    sqlc.arg(sync_metadata)::boolean,
    sqlc.arg(enrolled_via)::text
)
ON CONFLICT (owner_login_lower, repo_name_lower) DO UPDATE
SET owner_login     = EXCLUDED.owner_login,
    repo_name       = EXCLUDED.repo_name,
    installation_id = COALESCE(EXCLUDED.installation_id, github_synced_repos.installation_id),
    github_repository_id = COALESCE(EXCLUDED.github_repository_id, github_synced_repos.github_repository_id),
    sync_refs       = github_synced_repos.sync_refs OR EXCLUDED.sync_refs,
    sync_metadata   = github_synced_repos.sync_metadata OR EXCLUDED.sync_metadata,
    -- A rebind restarts sync bookkeeping. An operator-disabled row stays
    -- disabled, and an in-flight claim keeps its singleflight until release.
    sync_state = CASE
        WHEN github_synced_repos.github_repository_id <> EXCLUDED.github_repository_id
             AND github_synced_repos.sync_state NOT IN ('disabled', 'syncing')
        THEN 'pending'
        ELSE github_synced_repos.sync_state
    END,
    last_synced_at = CASE
        WHEN github_synced_repos.github_repository_id <> EXCLUDED.github_repository_id THEN NULL
        ELSE github_synced_repos.last_synced_at
    END,
    last_webhook_at = CASE
        WHEN github_synced_repos.github_repository_id <> EXCLUDED.github_repository_id THEN NULL
        ELSE github_synced_repos.last_webhook_at
    END,
    sync_error = CASE
        WHEN github_synced_repos.github_repository_id <> EXCLUDED.github_repository_id THEN NULL
        ELSE github_synced_repos.sync_error
    END,
    consecutive_failures = CASE
        WHEN github_synced_repos.github_repository_id <> EXCLUDED.github_repository_id THEN 0
        ELSE github_synced_repos.consecutive_failures
    END,
    updated_at      = NOW()
RETURNING *;

-- name: GetGitHubSyncedRepoByGitHubID :one
-- Numeric-id fallback for webhook applies: a rename/transfer changes the slug
-- but never GitHub's repo id, so a delivery whose slug misses is re-keyed here.
SELECT *
FROM github_synced_repos
WHERE github_repository_id = sqlc.arg(github_repository_id);

-- name: AdoptGitHubSyncedRepoSlug :one
-- Repair the stored owner/name after a rename/transfer detected via the
-- numeric-id fallback. Fails (unique slug) if a different row already holds the
-- new slug; the caller logs and leaves the old row for the reconciler.
UPDATE github_synced_repos
SET owner_login       = sqlc.arg(owner_login)::text,
    owner_login_lower = LOWER(sqlc.arg(owner_login)::text),
    repo_name         = sqlc.arg(repo_name)::text,
    repo_name_lower   = LOWER(sqlc.arg(repo_name)::text),
    updated_at        = NOW()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: ListDueGitHubSyncedRepos :many
-- Reconciliation backstop candidates, oldest staleness first. Due-ness (the
-- adaptive clamp, failure backoff, webhook-heartbeat stretch) is computed by
-- the reconciler in Go; this returns the stalest eligible rows.
SELECT *
FROM github_synced_repos
WHERE sync_metadata
  AND sync_state NOT IN ('disabled', 'failed')
  AND (syncing_since IS NULL OR syncing_since < NOW() - INTERVAL '5 minutes')
ORDER BY last_synced_at ASC NULLS FIRST, id
LIMIT sqlc.arg(row_limit)::int;

-- name: ListGitHubSyncedRepos :many
-- The registry feed github-sync reads in place of its static mappings.
SELECT *
FROM github_synced_repos
WHERE sync_state <> 'disabled'
  -- refs_only is github-sync's mirror working set: advertising a row with no
  -- recorded jjhub-side mirror would hand it a repo it cannot push anywhere.
  AND (NOT sqlc.arg(refs_only)::boolean
       OR (sync_refs AND mirror_owner IS NOT NULL AND mirror_repo IS NOT NULL))
ORDER BY owner_login_lower, repo_name_lower;

-- name: SetGitHubSyncedRepoMirror :exec
-- Record which jjhub repo this GitHub source is mirrored into (set by the
-- import/enroll mirror path so github-sync can keep its refs current).
WITH configured AS (
    UPDATE github_synced_repos g
    SET mirror_owner = sqlc.arg(mirror_owner)::text,
        mirror_repo  = sqlc.arg(mirror_repo)::text,
        updated_at   = NOW()
    WHERE g.id = sqlc.arg(id)
    RETURNING g.mirror_owner, g.mirror_repo
)
UPDATE repositories r
SET mirror_status = 'behind',
    last_mirror_error = NULL,
    mirror_behind_refs = 0,
    mirror_failed_refs = 0
FROM owner_namespaces ns, configured c
WHERE ns.lower_slug = LOWER(c.mirror_owner)
  AND r.lower_name = LOWER(c.mirror_repo)
  AND (
      (ns.owner_type = 'user' AND ns.user_id = r.user_id)
      OR
      (ns.owner_type = 'org' AND ns.org_id = r.org_id)
  );

-- name: RecordGitHubMirrorStatus :execrows
-- github-sync reports the start and outcome of each push mirror run. A start
-- marks the repository behind but retains the last completed run and head;
-- success/failure timestamp the completed run. Only an active registry mapping
-- may update a repository, so an obsolete or misspelled worker mapping fails.
UPDATE repositories r
SET mirror_status = sqlc.arg(mirror_status)::text,
    mirror_behind_refs = sqlc.arg(behind_refs)::integer,
    mirror_failed_refs = sqlc.arg(failed_refs)::integer,
    last_mirror_at = CASE
        WHEN sqlc.arg(mirror_status)::text IN ('synced', 'failed') THEN NOW()
        ELSE last_mirror_at
    END,
    last_mirror_error = CASE
        WHEN sqlc.arg(mirror_status)::text = 'failed' THEN sqlc.narg(mirror_error)::text
        ELSE NULL
    END,
    last_mirror_github_head = CASE
        WHEN sqlc.arg(mirror_status)::text = 'synced' THEN sqlc.narg(github_head)::text
        ELSE last_mirror_github_head
    END
FROM owner_namespaces ns
WHERE ns.lower_slug = LOWER(sqlc.arg(mirror_owner)::text)
  AND r.lower_name = LOWER(sqlc.arg(mirror_repo)::text)
  AND (
      (ns.owner_type = 'user' AND ns.user_id = r.user_id)
      OR
      (ns.owner_type = 'org' AND ns.org_id = r.org_id)
  )
  AND EXISTS (
      SELECT 1
      FROM github_synced_repos g
      WHERE g.sync_refs
        AND g.sync_state <> 'disabled'
        AND LOWER(g.mirror_owner) = LOWER(sqlc.arg(mirror_owner)::text)
        AND LOWER(g.mirror_repo) = LOWER(sqlc.arg(mirror_repo)::text)
  );

-- name: ClaimGitHubSyncedRepoSync :execrows
-- Singleflight claim on a backfill/revalidate. Claims older than 5 minutes are
-- considered abandoned (the syncer crashed) and may be taken over.
UPDATE github_synced_repos
SET syncing_since = NOW(),
    sync_state    = 'syncing',
    updated_at    = NOW()
WHERE id = sqlc.arg(id)
  -- Neither an operator-disabled repo nor a hard-failed one may be resurrected
  -- by a background claim ('failed' is the consecutive-failure kill switch).
  AND sync_state NOT IN ('disabled', 'failed')
  AND (syncing_since IS NULL OR syncing_since < NOW() - INTERVAL '5 minutes');

-- name: MarkGitHubSyncedRepoSynced :exec
-- A backfill/revalidate succeeded: clear the error and release the claim.
UPDATE github_synced_repos
SET last_synced_at = NOW(),
    sync_state     = 'ready',
    sync_error     = NULL,
    consecutive_failures = 0,
    syncing_since  = NULL,
    updated_at     = NOW()
WHERE id = sqlc.arg(id);

-- name: SetGitHubSyncedRepoSyncError :exec
-- Record a sync failure WITHOUT touching the stored issues/PRs: the proxy keeps
-- serving last-good rows behind an honest staleness header, and never invents.
-- Counts the consecutive-failure streak and trips the kill switch ('failed')
-- at hard_fail_after back-to-back failures; an operator 'disabled' row stays
-- disabled.
UPDATE github_synced_repos
SET sync_error    = sqlc.arg(sync_error)::text,
    consecutive_failures = consecutive_failures + 1,
    sync_state    = CASE
                      WHEN sync_state = 'disabled' THEN 'disabled'
                      WHEN consecutive_failures + 1 >= sqlc.arg(hard_fail_after)::int THEN 'failed'
                      ELSE 'error'
                    END,
    syncing_since = NULL,
    updated_at    = NOW()
WHERE id = sqlc.arg(id);

-- name: TouchGitHubSyncedRepoWebhook :exec
-- Webhook heartbeat. Proves deliveries are arriving for this repo, which is
-- what makes the store fresh without polling.
UPDATE github_synced_repos
SET last_webhook_at = NOW(),
    updated_at      = NOW()
WHERE id = sqlc.arg(id);

-- name: ListGitHubSyncedIssues :many
-- The proxy's read: one repo + resource, optionally filtered by state.
-- GitHub's DEFAULT order for both collections is created-desc; sort=updated
-- asks for updated-desc. The store reproduces both so a page served from it is
-- ordered identically to the live passthrough.
SELECT *
FROM github_synced_issues
WHERE synced_repo_id = sqlc.arg(synced_repo_id)
  AND resource = sqlc.arg(resource)::text
  AND (sqlc.arg(state)::text = 'all' OR state = sqlc.arg(state)::text)
ORDER BY
  CASE WHEN sqlc.arg(sort_by_updated)::boolean THEN github_updated_at END DESC NULLS LAST,
  github_created_at DESC NULLS LAST,
  number DESC
LIMIT sqlc.arg(row_limit)::int OFFSET sqlc.arg(row_offset)::int;

-- name: CountGitHubSyncedIssues :one
SELECT COUNT(*)
FROM github_synced_issues
WHERE synced_repo_id = sqlc.arg(synced_repo_id)
  AND resource = sqlc.arg(resource)::text
  AND (sqlc.arg(state)::text = 'all' OR state = sqlc.arg(state)::text);

-- name: UpsertGitHubSyncedIssue :exec
INSERT INTO github_synced_issues (
    synced_repo_id, resource, number, github_id, state, title, payload,
    github_created_at, github_updated_at
)
VALUES (
    sqlc.arg(synced_repo_id),
    sqlc.arg(resource)::text,
    sqlc.arg(number),
    sqlc.arg(github_id),
    sqlc.arg(state)::text,
    sqlc.arg(title)::text,
    sqlc.arg(payload),
    sqlc.narg(github_created_at)::timestamptz,
    sqlc.narg(github_updated_at)::timestamptz
)
ON CONFLICT (synced_repo_id, resource, number) DO UPDATE
SET github_id         = EXCLUDED.github_id,
    state             = EXCLUDED.state,
    title             = EXCLUDED.title,
    payload           = EXCLUDED.payload,
    github_created_at = EXCLUDED.github_created_at,
    github_updated_at = EXCLUDED.github_updated_at,
    updated_at        = NOW()
-- Out-of-order webhook deliveries are common; never let an older snapshot
-- overwrite a newer one.
WHERE github_synced_issues.github_updated_at IS NULL
   OR EXCLUDED.github_updated_at IS NULL
   OR EXCLUDED.github_updated_at >= github_synced_issues.github_updated_at;

-- name: DeleteGitHubSyncedIssue :exec
DELETE FROM github_synced_issues
WHERE synced_repo_id = sqlc.arg(synced_repo_id)
  AND resource = sqlc.arg(resource)::text
  AND number = sqlc.arg(number);

-- name: DeleteGitHubSyncedIssuesNotIn :exec
-- Backfill reconcile: drop rows GitHub no longer returns (transferred or
-- deleted issues). Only ever run with the FULL just-fetched number set.
DELETE FROM github_synced_issues
WHERE synced_repo_id = sqlc.arg(synced_repo_id)
  AND resource = sqlc.arg(resource)::text
  AND NOT (number = ANY(sqlc.arg(numbers)::bigint[]));

-- name: ListGitHubSyncedIssueComments :many
SELECT *
FROM github_synced_issue_comments
WHERE synced_repo_id = sqlc.arg(synced_repo_id)
  AND issue_number = sqlc.arg(issue_number)
ORDER BY github_created_at NULLS LAST, github_id
LIMIT sqlc.arg(row_limit)::int OFFSET sqlc.arg(row_offset)::int;

-- name: GetGitHubSyncedIssueCommentCoverage :one
-- The comment store is a complete baseline for one issue only when it holds
-- exactly as many comments as the stored issue advertises. The issue row is
-- refreshed by reconcile and by every issue_comment delivery, so a missed or
-- historical comment shows up as a mismatch. No row: the issue (or its
-- advertised count) is not stored, so there is no baseline at all.
SELECT
    (i.payload->>'comments')::bigint AS advertised,
    (
        SELECT COUNT(*)
        FROM github_synced_issue_comments c
        WHERE c.synced_repo_id = i.synced_repo_id
          AND c.issue_number = i.number
    )::bigint AS stored
FROM github_synced_issues i
WHERE i.synced_repo_id = sqlc.arg(synced_repo_id)
  AND i.resource = 'issues'
  AND i.number = sqlc.arg(issue_number)
  AND jsonb_typeof(i.payload->'comments') = 'number';

-- name: UpsertGitHubSyncedIssueComment :exec
INSERT INTO github_synced_issue_comments (
    synced_repo_id, issue_number, github_id, payload,
    github_created_at, github_updated_at
)
VALUES (
    sqlc.arg(synced_repo_id),
    sqlc.arg(issue_number),
    sqlc.arg(github_id),
    sqlc.arg(payload),
    sqlc.narg(github_created_at)::timestamptz,
    sqlc.narg(github_updated_at)::timestamptz
)
ON CONFLICT (synced_repo_id, github_id) DO UPDATE
SET issue_number      = EXCLUDED.issue_number,
    payload           = EXCLUDED.payload,
    github_created_at = EXCLUDED.github_created_at,
    github_updated_at = EXCLUDED.github_updated_at,
    updated_at        = NOW()
-- Same out-of-order guard as the issues upsert: an older comment snapshot
-- (late-delivered `created` racing an `edited`) never overwrites a newer one.
WHERE github_synced_issue_comments.github_updated_at IS NULL
   OR EXCLUDED.github_updated_at IS NULL
   OR EXCLUDED.github_updated_at >= github_synced_issue_comments.github_updated_at;

-- name: DeleteGitHubSyncedIssueComment :exec
DELETE FROM github_synced_issue_comments
WHERE synced_repo_id = sqlc.arg(synced_repo_id)
  AND github_id = sqlc.arg(github_id);

-- name: DeleteGitHubSyncedIssueCommentsNotIn :exec
-- Comment baseline load: drop an issue's stored comments GitHub no longer
-- returns. Only ever run with the FULL just-fetched comment id set.
DELETE FROM github_synced_issue_comments
WHERE synced_repo_id = sqlc.arg(synced_repo_id)
  AND issue_number = sqlc.arg(issue_number)
  AND NOT (github_id = ANY(sqlc.arg(github_ids)::bigint[]));

-- ---- Per-user read grants (live-read proof gating the shared store) ----

-- name: UpsertGitHubSyncedRepoReadGrant :exec
-- Stamped only after the user's own credential read the repo live from GitHub.
INSERT INTO github_synced_repo_read_grants (user_id, owner_login_lower, repo_name_lower, verified_at)
VALUES (sqlc.arg(user_id)::bigint, LOWER(sqlc.arg(owner_login)::text), LOWER(sqlc.arg(repo_name)::text), NOW())
ON CONFLICT (user_id, owner_login_lower, repo_name_lower) DO UPDATE
SET verified_at = NOW();

-- name: GetGitHubSyncedRepoReadGrant :one
SELECT *
FROM github_synced_repo_read_grants
WHERE user_id = sqlc.arg(user_id)::bigint
  AND owner_login_lower = LOWER(sqlc.arg(owner_login)::text)
  AND repo_name_lower = LOWER(sqlc.arg(repo_name)::text);

-- name: DeleteGitHubSyncedRepoReadGrantsForUser :exec
DELETE FROM github_synced_repo_read_grants
WHERE user_id = sqlc.arg(user_id)::bigint;

-- name: ListGitHubSyncedRepoMirrorBinders :many
-- The user who bound each recorded mirror: the newest ready import that
-- produced exactly that mirror repository from that GitHub source. github-sync
-- may write to the GitHub repo only while this user can push to it.
SELECT g.id AS synced_repo_id, b.user_id
FROM github_synced_repos g
JOIN LATERAL (
    SELECT j.user_id
    FROM import_jobs j
    WHERE LOWER(j.github_owner) = g.owner_login_lower
      AND LOWER(j.github_repo) = g.repo_name_lower
      AND LOWER(j.repo_owner) = LOWER(g.mirror_owner)
      AND LOWER(j.repo_name) = LOWER(g.mirror_repo)
      AND j.status = 'ready'
    ORDER BY j.updated_at DESC, j.created_at DESC
    LIMIT 1
) b ON TRUE
WHERE g.mirror_owner IS NOT NULL
  AND g.mirror_repo IS NOT NULL;
