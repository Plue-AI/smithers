-- name: CreateOrUpdateSecret :one
-- A new secret is main-only only when asked; replacing a value keeps its
-- scope and its host binding unless the write names them.
INSERT INTO repository_secrets (repository_id, name, value_encrypted, main_only, hosts, match_headers)
VALUES ($1, $2, $3, COALESCE(sqlc.narg(main_only)::boolean, false),
    COALESCE(sqlc.narg(hosts)::text[], '{}'::text[]), COALESCE(sqlc.narg(match_headers)::text[], '{}'::text[]))
ON CONFLICT (repository_id, name)
DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted, subscription_token_flagged_at = NULL,
    main_only = COALESCE(sqlc.narg(main_only)::boolean, repository_secrets.main_only),
    hosts = COALESCE(sqlc.narg(hosts)::text[], repository_secrets.hosts),
    match_headers = COALESCE(sqlc.narg(match_headers)::text[], repository_secrets.match_headers),
    updated_at = NOW()
RETURNING *;

-- name: SetSecretMainOnly :one
UPDATE repository_secrets
SET main_only = sqlc.arg(main_only), updated_at = NOW()
WHERE repository_id = sqlc.arg(repository_id) AND name = sqlc.arg(name)
RETURNING *;

-- name: SetSecretBinding :one
-- The hosts and request headers a secret may be sent to, without its value.
-- Empty on both sides unbinds it.
UPDATE repository_secrets
SET hosts = sqlc.arg(hosts)::text[], match_headers = sqlc.arg(match_headers)::text[], updated_at = NOW()
WHERE repository_id = sqlc.arg(repository_id) AND name = sqlc.arg(name)
RETURNING *;

-- name: ListSecrets :many
SELECT id, repository_id, name, created_at, updated_at, subscription_token_flagged_at, main_only, hosts, match_headers
FROM repository_secrets
WHERE repository_id = $1
ORDER BY name;

-- name: ListSecretValuesForRepo :many
-- An agent run's secrets: never a main-only one, and never one bound to
-- hosts, which reaches a guest only through its egress proxy.
SELECT name, value_encrypted
FROM repository_secrets
WHERE repository_id = $1
  AND NOT main_only
  AND cardinality(hosts) = 0
ORDER BY name;

-- name: ListSecretValues :many
SELECT name, value_encrypted, main_only, hosts, match_headers
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
-- Replacing a value keeps its host binding unless the write names one.
INSERT INTO organization_secrets (organization_id, name, value_encrypted, hosts, match_headers)
VALUES ($1, $2, $3, COALESCE(sqlc.narg(hosts)::text[], '{}'::text[]), COALESCE(sqlc.narg(match_headers)::text[], '{}'::text[]))
ON CONFLICT (organization_id, name)
DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted, subscription_token_flagged_at = NULL,
    hosts = COALESCE(sqlc.narg(hosts)::text[], organization_secrets.hosts),
    match_headers = COALESCE(sqlc.narg(match_headers)::text[], organization_secrets.match_headers),
    updated_at = NOW()
RETURNING *;

-- name: ListOrgSecrets :many
SELECT id, organization_id, name, created_at, updated_at, subscription_token_flagged_at, hosts, match_headers
FROM organization_secrets
WHERE organization_id = $1
ORDER BY name;

-- name: ListOrgSecretValues :many
SELECT name, value_encrypted, hosts, match_headers
FROM organization_secrets
WHERE organization_id = $1
ORDER BY name;

-- name: DeleteOrgSecret :exec
DELETE FROM organization_secrets
WHERE organization_id = $1 AND name = $2;
