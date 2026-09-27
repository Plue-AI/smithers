-- #2206: the one-time scan for subscription tokens stored before the hosted
-- refusal (services.ScanStoredSubscriptionTokens).

-- name: TryLockStoredSubscriptionTokenScan :one
SELECT pg_try_advisory_xact_lock(2206)::boolean AS locked;

-- name: StoredSubscriptionTokenScanCompleted :one
SELECT EXISTS (SELECT 1 FROM stored_subscription_token_scan)::boolean AS completed;

-- name: RecordStoredSubscriptionTokenScan :exec
INSERT INTO stored_subscription_token_scan (counts)
VALUES (sqlc.arg(counts))
ON CONFLICT (id) DO NOTHING;

-- name: ListRepositorySecretValuesAfter :many
SELECT id, repository_id, name, value_encrypted
FROM repository_secrets
WHERE id > sqlc.arg(after_id)
ORDER BY id
LIMIT sqlc.arg(page_size);

-- name: FlagRepositorySecretSubscriptionToken :execrows
-- The value must still be the one the scan read: a secret replaced since
-- then passed the write-path refusal and is not flagged.
UPDATE repository_secrets
SET subscription_token_flagged_at = COALESCE(subscription_token_flagged_at, NOW())
WHERE id = sqlc.arg(id)
  AND value_encrypted = sqlc.arg(value_encrypted);

-- name: ListOrgSecretValuesAfter :many
SELECT id, organization_id, name, value_encrypted
FROM organization_secrets
WHERE id > sqlc.arg(after_id)
ORDER BY id
LIMIT sqlc.arg(page_size);

-- name: FlagOrgSecretSubscriptionToken :execrows
UPDATE organization_secrets
SET subscription_token_flagged_at = COALESCE(subscription_token_flagged_at, NOW())
WHERE id = sqlc.arg(id)
  AND value_encrypted = sqlc.arg(value_encrypted);

-- name: ListAgentEnvironmentSecretValuesAfter :many
SELECT repository_id, name, value_encrypted
FROM repository_agent_environment_secrets
WHERE (repository_id, name) > (sqlc.arg(after_repository_id)::bigint, sqlc.arg(after_name)::text)
ORDER BY repository_id, name
LIMIT sqlc.arg(page_size);

-- name: FlagAgentEnvironmentSecretSubscriptionToken :execrows
UPDATE repository_agent_environment_secrets
SET subscription_token_flagged_at = COALESCE(subscription_token_flagged_at, NOW())
WHERE repository_id = sqlc.arg(repository_id)
  AND name = sqlc.arg(name)
  AND value_encrypted = sqlc.arg(value_encrypted);

-- name: ListAgentEnvironmentsAfter :many
SELECT repository_id, setup_script, environment_variables
FROM repository_agent_environments
WHERE repository_id > sqlc.arg(after_repository_id)
ORDER BY repository_id
LIMIT sqlc.arg(page_size);

-- name: MarkRepositoryWorkspacesRebuildRequired :execrows
-- Every live workspace of the repository may hold what its setup delivered.
UPDATE workspaces
SET rebuild_required_at = NOW()
WHERE repository_id = sqlc.arg(repository_id)
  AND deleted_at IS NULL
  AND rebuild_required_at IS NULL;

-- name: MarkRepositorySnapshotsRebuildRequired :execrows
UPDATE workspace_snapshots
SET rebuild_required_at = NOW()
WHERE repository_id = sqlc.arg(repository_id)
  AND rebuild_required_at IS NULL;

-- name: ListOrganizationRepositoryIDs :many
SELECT id
FROM repositories
WHERE org_id = sqlc.arg(organization_id)::bigint
ORDER BY id;
