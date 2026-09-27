-- name: GetRepositoryAgentEnvironment :one
SELECT *
FROM repository_agent_environments
WHERE repository_id = $1;

-- name: UpsertRepositoryAgentEnvironment :one
INSERT INTO repository_agent_environments (
    repository_id,
    setup_script,
    environment_variables
)
VALUES (
    sqlc.arg(repository_id),
    sqlc.arg(setup_script),
    sqlc.arg(environment_variables)
)
ON CONFLICT (repository_id)
DO UPDATE SET
    setup_script = EXCLUDED.setup_script,
    environment_variables = EXCLUDED.environment_variables,
    updated_at = NOW()
RETURNING *;

-- name: ListRepositoryAgentEnvironmentSecrets :many
SELECT repository_id, name, hosts, match_headers, created_at, updated_at, subscription_token_flagged_at
FROM repository_agent_environment_secrets
WHERE repository_id = $1
ORDER BY name;

-- name: ListRepositoryAgentEnvironmentSecretValues :many
SELECT name, value_encrypted, hosts, match_headers
FROM repository_agent_environment_secrets
WHERE repository_id = $1
ORDER BY name;

-- name: UpsertRepositoryAgentEnvironmentSecret :one
INSERT INTO repository_agent_environment_secrets (
    repository_id,
    name,
    value_encrypted,
    hosts,
    match_headers
)
VALUES (
    sqlc.arg(repository_id),
    sqlc.arg(name),
    sqlc.arg(value_encrypted),
    sqlc.arg(hosts),
    sqlc.arg(match_headers)
)
ON CONFLICT (repository_id, name)
DO UPDATE SET
    value_encrypted = EXCLUDED.value_encrypted,
    hosts = EXCLUDED.hosts,
    match_headers = EXCLUDED.match_headers,
    subscription_token_flagged_at = NULL,
    updated_at = NOW()
RETURNING repository_id, name, hosts, match_headers, created_at, updated_at;

-- name: DeleteRepositoryAgentEnvironmentSecret :exec
DELETE FROM repository_agent_environment_secrets
WHERE repository_id = sqlc.arg(repository_id)
  AND name = sqlc.arg(name);
