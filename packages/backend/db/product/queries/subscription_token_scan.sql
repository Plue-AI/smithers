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

-- #2777: the scan removes every Claude subscription token on every start.
-- Each removal applies only while the value is still the one the scan read;
-- a value replaced since then is checked again on the next start.

-- name: ListProviderConnectionTokensAfter :many
SELECT id, owner_type, COALESCE(user_id, org_id)::bigint AS owner_id, provider, label,
       access_token_encrypted, refresh_token_encrypted
FROM provider_connections
WHERE id > sqlc.arg(after_id)::uuid
ORDER BY id
LIMIT sqlc.arg(page_size);

-- name: DeleteProviderConnectionSubscriptionToken :execrows
DELETE FROM provider_connections
WHERE id = sqlc.arg(id)
  AND access_token_encrypted = sqlc.arg(access_token_encrypted);

-- name: DeleteRepositorySecretSubscriptionToken :execrows
DELETE FROM repository_secrets
WHERE id = sqlc.arg(id)
  AND value_encrypted = sqlc.arg(value_encrypted);

-- name: DeleteOrgSecretSubscriptionToken :execrows
DELETE FROM organization_secrets
WHERE id = sqlc.arg(id)
  AND value_encrypted = sqlc.arg(value_encrypted);

-- name: DeleteAgentEnvironmentSecretSubscriptionToken :execrows
DELETE FROM repository_agent_environment_secrets
WHERE repository_id = sqlc.arg(repository_id)
  AND name = sqlc.arg(name)
  AND value_encrypted = sqlc.arg(value_encrypted);

-- name: DeleteRepositoryVariableSubscriptionToken :execrows
DELETE FROM repository_variables
WHERE id = sqlc.arg(id)
  AND value = sqlc.arg(value);

-- name: DeleteOrgVariableSubscriptionToken :execrows
DELETE FROM organization_variables
WHERE id = sqlc.arg(id)
  AND value = sqlc.arg(value);

-- name: ClearOwnerModelCredentialSubscriptionToken :execrows
-- A removed model credential keeps its row with no value, as a user's own
-- removal does.
UPDATE owner_model_credentials
SET value_encrypted = NULL
WHERE user_id = sqlc.arg(user_id)
  AND name = sqlc.arg(name)
  AND value_encrypted = sqlc.arg(value_encrypted)::text;

-- name: ReplaceAgentEnvironmentSubscriptionToken :execrows
UPDATE repository_agent_environments
SET setup_script = sqlc.arg(setup_script),
    environment_variables = sqlc.arg(environment_variables),
    updated_at = NOW()
WHERE repository_id = sqlc.arg(repository_id)
  AND setup_script = sqlc.arg(stored_setup_script)
  AND environment_variables = sqlc.arg(stored_environment_variables);

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

-- name: ListRepositoryVariablesAfter :many
SELECT id, repository_id, name, value
FROM repository_variables
WHERE id > sqlc.arg(after_id)
ORDER BY id
LIMIT sqlc.arg(page_size);

-- name: ListOrgVariablesAfter :many
SELECT id, organization_id, name, value
FROM organization_variables
WHERE id > sqlc.arg(after_id)
ORDER BY id
LIMIT sqlc.arg(page_size);

-- name: ListOwnerModelCredentialValuesAfter :many
SELECT user_id, name, value_encrypted::text AS value_encrypted
FROM owner_model_credentials
WHERE value_encrypted IS NOT NULL
  AND (user_id, name) > (sqlc.arg(after_user_id)::bigint, sqlc.arg(after_name)::text)
ORDER BY user_id, name
LIMIT sqlc.arg(page_size);
