-- name: GetGithubApp :one
SELECT * FROM github_app WHERE singleton = TRUE;

-- name: CreateGithubApp :execrows
INSERT INTO github_app (
    id, slug, owner_login, owner_kind, client_id,
    pem_sealed, webhook_secret_sealed, client_secret_sealed, installation_id
) VALUES (
    sqlc.arg(id), sqlc.arg(slug), sqlc.arg(owner_login), sqlc.arg(owner_kind), sqlc.arg(client_id),
    sqlc.arg(pem_sealed), sqlc.arg(webhook_secret_sealed), sqlc.arg(client_secret_sealed), sqlc.narg(installation_id)
)
ON CONFLICT DO NOTHING;

-- name: SetGithubAppInstallation :execrows
UPDATE github_app
SET installation_id = sqlc.arg(installation_id)::BIGINT
WHERE singleton = TRUE;

-- name: CreateGithubAppManifestState :one
INSERT INTO github_app_manifest_states (digest, setup_session_digest, owner_login, owner_kind, repository_name, origin, callback_urls, expires_at)
VALUES (sqlc.arg(digest), sqlc.arg(setup_session_digest), sqlc.arg(owner_login), sqlc.arg(owner_kind), sqlc.arg(repository_name), sqlc.arg(origin), sqlc.arg(callback_urls), sqlc.arg(expires_at))
RETURNING *;

-- name: ConsumeGithubAppManifestState :one
UPDATE github_app_manifest_states
SET used_at = NOW()
WHERE digest = sqlc.arg(digest)
  AND setup_session_digest = sqlc.arg(setup_session_digest)
  AND origin = sqlc.arg(origin)
  AND NOT EXISTS (SELECT 1 FROM members WHERE role = 'owner')
  AND EXISTS (
    SELECT 1 FROM install_settings
    WHERE key = 'setup.session.' || sqlc.arg(setup_session_digest)::TEXT
      AND (value->>'expires_at')::TIMESTAMPTZ > NOW()
  )
  AND used_at IS NULL
  AND expires_at > NOW()
  AND EXISTS (
    SELECT 1 FROM install_settings
    WHERE key = 'setup.step.app_manifest'
      AND value->>'status' = 'running'
      AND value->>'digest' = sqlc.arg(digest)::TEXT
  )
RETURNING *;

-- name: GetGithubAppManifestState :one
SELECT * FROM github_app_manifest_states WHERE digest = sqlc.arg(digest);

-- name: DeleteOtherGithubAppManifestStates :exec
DELETE FROM github_app_manifest_states WHERE digest <> sqlc.arg(digest);

-- name: GetInstallSetting :one
SELECT * FROM install_settings WHERE key = sqlc.arg(key);

-- name: UpsertInstallSetting :exec
INSERT INTO install_settings (key, value, sealed, updated_by)
VALUES (sqlc.arg(key), sqlc.arg(value), sqlc.arg(sealed), sqlc.narg(updated_by))
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, sealed = EXCLUDED.sealed,
    updated_by = EXCLUDED.updated_by, updated_at = NOW();
