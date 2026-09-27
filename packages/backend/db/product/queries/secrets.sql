-- name: CreateOrUpdateSecret :one
-- A new secret is main-only only when asked; replacing a value keeps its
-- scope unless the write names one.
INSERT INTO repository_secrets (repository_id, name, value_encrypted, main_only)
VALUES ($1, $2, $3, COALESCE(sqlc.narg(main_only)::boolean, false))
ON CONFLICT (repository_id, name)
DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted, subscription_token_flagged_at = NULL,
    main_only = COALESCE(sqlc.narg(main_only)::boolean, repository_secrets.main_only), updated_at = NOW()
RETURNING *;

-- name: SetSecretMainOnly :one
UPDATE repository_secrets
SET main_only = sqlc.arg(main_only), updated_at = NOW()
WHERE repository_id = sqlc.arg(repository_id) AND name = sqlc.arg(name)
RETURNING *;

-- name: ListSecrets :many
SELECT id, repository_id, name, created_at, updated_at, subscription_token_flagged_at, main_only
FROM repository_secrets
WHERE repository_id = $1
ORDER BY name;

-- name: ListSecretValuesForRepo :many
-- An agent run's secrets: never a main-only one.
SELECT name, value_encrypted
FROM repository_secrets
WHERE repository_id = $1
  AND NOT main_only
ORDER BY name;

-- name: ListSecretValues :many
SELECT name, value_encrypted, main_only
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
