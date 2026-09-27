-- name: CreateOrUpdateSecret :one
INSERT INTO repository_secrets (repository_id, name, value_encrypted)
VALUES ($1, $2, $3)
ON CONFLICT (repository_id, name)
DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted, subscription_token_flagged_at = NULL, updated_at = NOW()
RETURNING *;

-- name: ListSecrets :many
SELECT id, repository_id, name, created_at, updated_at, subscription_token_flagged_at
FROM repository_secrets
WHERE repository_id = $1
ORDER BY name;

-- name: ListSecretValuesForRepo :many
SELECT name, value_encrypted
FROM repository_secrets
WHERE repository_id = $1
ORDER BY name;

-- name: ListSecretValues :many
SELECT name, value_encrypted
FROM repository_secrets
WHERE repository_id = $1
ORDER BY name;

-- name: GetSecretValueByName :one
SELECT value_encrypted
FROM repository_secrets
WHERE repository_id = $1
  AND name = $2;

-- name: DeleteSecret :exec
DELETE FROM repository_secrets
WHERE repository_id = $1 AND name = $2;

-- name: CreateOrUpdateOrgSecret :one
INSERT INTO organization_secrets (organization_id, name, value_encrypted)
VALUES ($1, $2, $3)
ON CONFLICT (organization_id, name)
DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted, subscription_token_flagged_at = NULL, updated_at = NOW()
RETURNING *;

-- name: ListOrgSecrets :many
SELECT id, organization_id, name, created_at, updated_at, subscription_token_flagged_at
FROM organization_secrets
WHERE organization_id = $1
ORDER BY name;

-- name: ListOrgSecretValues :many
SELECT name, value_encrypted
FROM organization_secrets
WHERE organization_id = $1
ORDER BY name;

-- name: DeleteOrgSecret :exec
DELETE FROM organization_secrets
WHERE organization_id = $1 AND name = $2;
