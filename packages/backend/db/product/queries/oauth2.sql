-- name: CreateOAuth2Application :one
INSERT INTO oauth2_applications (
    client_id,
    client_secret_hash,
    name,
    redirect_uris,
    scopes,
    owner_id,
    confidential
)
VALUES (
    sqlc.arg(client_id),
    sqlc.arg(client_secret_hash),
    sqlc.arg(name),
    sqlc.arg(redirect_uris),
    sqlc.arg(scopes),
    sqlc.arg(owner_id),
    sqlc.arg(confidential)
)
RETURNING *;

-- name: GetOAuth2ApplicationByClientID :one
SELECT *
FROM oauth2_applications
WHERE client_id = $1;

-- name: CreateOAuth2AuthorizationCode :exec
INSERT INTO oauth2_authorization_codes (
    code_hash,
    app_id,
    user_id,
    scopes,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    expires_at,
    source_access_token_id
)
VALUES (
    sqlc.arg(code_hash),
    sqlc.arg(app_id),
    sqlc.arg(user_id),
    sqlc.arg(scopes),
    sqlc.arg(redirect_uri),
    sqlc.arg(code_challenge),
    sqlc.arg(code_challenge_method),
    sqlc.arg(expires_at),
    sqlc.narg(source_access_token_id)
);

-- name: ConsumeOAuth2AuthorizationCode :one
UPDATE oauth2_authorization_codes
SET used_at = NOW()
WHERE code_hash = sqlc.arg(code_hash)
  AND used_at IS NULL
  AND expires_at > NOW()
RETURNING *;

-- name: DeleteExpiredOAuth2AuthorizationCodes :exec
DELETE FROM oauth2_authorization_codes
WHERE expires_at < NOW();

-- name: CreateOAuth2AccessToken :one
INSERT INTO oauth2_access_tokens (
    token_hash,
    app_id,
    user_id,
    scopes,
    expires_at,
    source_access_token_id
)
VALUES (
    sqlc.arg(token_hash),
    sqlc.arg(app_id),
    sqlc.arg(user_id),
    sqlc.arg(scopes),
    sqlc.arg(expires_at),
    sqlc.narg(source_access_token_id)
)
RETURNING *;

-- name: GetOAuth2AccessTokenByHash :one
SELECT *
FROM oauth2_access_tokens
WHERE token_hash = $1
  AND expires_at > NOW();

-- name: GetFirstPartyOAuth2AccessTokenByHash :one
-- Existing hosted-application tokens remain stored and revocable, but only
-- the deployment's first-party client authenticates product requests.
SELECT t.*
FROM oauth2_access_tokens t
JOIN oauth2_applications a ON a.id = t.app_id
WHERE t.token_hash = $1
  AND t.expires_at > NOW()
  AND a.client_id = 'smithers_first_party_apps';

-- name: DeleteOAuth2AccessTokensByAppAndUser :exec
DELETE FROM oauth2_access_tokens
WHERE app_id = sqlc.arg(app_id)
  AND user_id = sqlc.arg(user_id);

-- name: DeleteOAuth2AccessTokenByHash :execrows
DELETE FROM oauth2_access_tokens
WHERE token_hash = $1;

-- name: DeleteExpiredOAuth2AccessTokens :many
DELETE FROM oauth2_access_tokens
WHERE expires_at < NOW()
RETURNING *;

-- name: CreateOAuth2RefreshToken :one
INSERT INTO oauth2_refresh_tokens (
    token_hash,
    app_id,
    user_id,
    scopes,
    expires_at,
    source_access_token_id
)
VALUES (
    sqlc.arg(token_hash),
    sqlc.arg(app_id),
    sqlc.arg(user_id),
    sqlc.arg(scopes),
    sqlc.arg(expires_at),
    sqlc.narg(source_access_token_id)
)
RETURNING *;

-- name: GetOAuth2RefreshTokenByHash :one
SELECT *
FROM oauth2_refresh_tokens
WHERE token_hash = $1
  AND expires_at > NOW();

-- name: ConsumeOAuth2RefreshToken :one
DELETE FROM oauth2_refresh_tokens
WHERE token_hash = $1
  AND expires_at > NOW()
RETURNING *;

-- name: DeleteOAuth2RefreshTokenByHash :execrows
DELETE FROM oauth2_refresh_tokens
WHERE token_hash = $1;

-- name: DeleteOAuth2RefreshTokensByAppAndUser :exec
DELETE FROM oauth2_refresh_tokens
WHERE app_id = sqlc.arg(app_id)
  AND user_id = sqlc.arg(user_id);

-- name: DeleteExpiredOAuth2RefreshTokens :exec
DELETE FROM oauth2_refresh_tokens
WHERE expires_at < NOW();

-- name: ListOAuth2AccessTokensByUser :many
SELECT t.*, a.name AS app_name, a.client_id AS app_client_id
FROM oauth2_access_tokens t
JOIN oauth2_applications a ON a.id = t.app_id
WHERE t.user_id = $1
  AND t.expires_at > NOW()
ORDER BY t.created_at DESC;

-- name: GetOAuth2AuthorizationCodeByHash :one
-- Inspect the complete grant without consuming it. Client/redirect/PKCE are
-- validated before the atomic consume-and-issue transaction.
SELECT * FROM oauth2_authorization_codes
WHERE code_hash = $1 AND used_at IS NULL AND expires_at > NOW();
