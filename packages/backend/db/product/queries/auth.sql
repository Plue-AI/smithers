-- name: CreateAuthSession :one
INSERT INTO auth_sessions (session_key, user_id, username, is_admin, expires_at)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: GetAuthSessionBySessionKey :one
SELECT *
FROM auth_sessions
WHERE session_key = $1;

-- name: DeleteAuthSession :exec
DELETE FROM auth_sessions
WHERE session_key = $1;

-- name: CreateAuthNonce :one
INSERT INTO auth_nonces (nonce_key, expires_at)
VALUES (sqlc.arg(nonce), sqlc.arg(expires_at))
RETURNING *;

-- name: ConsumeAuthNonce :execrows
UPDATE auth_nonces
SET used_at = NOW(), wallet_address = sqlc.arg(wallet_address)
WHERE nonce_key = sqlc.arg(nonce)
  AND used_at IS NULL
  AND expires_at > NOW();

-- name: CreateOAuthState :one
INSERT INTO oauth_states (state_key, context_hash, requested_scopes, expires_at)
VALUES (sqlc.arg(state), sqlc.arg(context_hash), sqlc.arg(requested_scopes), sqlc.arg(expires_at))
RETURNING *;

-- name: ConsumeOAuthState :execrows
UPDATE oauth_states
SET used_at = NOW()
WHERE state_key = sqlc.arg(state)
  AND context_hash = sqlc.arg(context_hash)
  AND used_at IS NULL
  AND expires_at > NOW();

-- name: ConsumeOAuthStateWithScopes :one
UPDATE oauth_states
SET used_at = NOW()
WHERE state_key = sqlc.arg(state)
  AND context_hash = sqlc.arg(context_hash)
  AND used_at IS NULL
  AND expires_at > NOW()
RETURNING requested_scopes;

-- name: DeleteExpiredOAuthStates :exec
DELETE FROM oauth_states
WHERE expires_at < NOW();

-- name: UpsertEmailAddress :one
WITH unset_primary AS (
    UPDATE email_addresses AS ea
    SET is_primary = FALSE,
        updated_at = NOW()
	    WHERE ea.user_id = sqlc.arg(user_id)
	      AND ea.is_primary = TRUE
	      AND ea.lower_email <> sqlc.arg(lower_email)
	      AND sqlc.arg(is_primary)::boolean = TRUE
	    RETURNING ea.id
),
upserted AS (
    INSERT INTO email_addresses (user_id, email, lower_email, is_activated, is_primary)
    SELECT
        sqlc.arg(user_id),
        sqlc.arg(email),
        sqlc.arg(lower_email),
        sqlc.arg(is_activated),
        sqlc.arg(is_primary)::boolean
    FROM (SELECT 1) AS force_cte
    LEFT JOIN unset_primary ON TRUE
    ON CONFLICT (user_id, lower_email)
    DO UPDATE SET
        email = EXCLUDED.email,
        is_activated = EXCLUDED.is_activated,
        is_primary = EXCLUDED.is_primary,
        updated_at = NOW()
    RETURNING *
)
SELECT * FROM upserted;

-- name: ListUserSessions :many
SELECT *
FROM auth_sessions
WHERE user_id = $1
ORDER BY created_at DESC;

-- name: DeleteExpiredSessions :exec
DELETE FROM auth_sessions
WHERE expires_at < NOW();

-- name: DeleteUserSessions :exec
DELETE FROM auth_sessions
WHERE user_id = $1;

-- name: UpdateSessionExpiry :exec
UPDATE auth_sessions
SET expires_at = sqlc.arg(expires_at),
    updated_at = NOW()
WHERE session_key = sqlc.arg(session_key);

-- name: RefreshAuthSession :one
UPDATE auth_sessions
SET expires_at = sqlc.arg(expires_at),
    updated_at = NOW()
WHERE session_key = sqlc.arg(session_key)
RETURNING *;

-- name: CreateAccessToken :one
INSERT INTO access_tokens (user_id, name, token_hash, token_last_eight, scopes, expires_at, system_issued)
VALUES (
    sqlc.arg(user_id),
    sqlc.arg(name),
    sqlc.arg(token_hash),
    sqlc.arg(token_last_eight),
    sqlc.arg(scopes),
    sqlc.arg(expires_at),
    sqlc.arg(system_issued)
)
RETURNING *;

-- name: ListUserAccessTokens :many
SELECT *
FROM access_tokens
WHERE user_id = $1
ORDER BY created_at DESC;

-- name: ListAccessTokensByUserID :many
SELECT *
FROM access_tokens
WHERE user_id = $1
ORDER BY created_at DESC;

-- name: GetAccessTokenByID :one
SELECT *
FROM access_tokens
WHERE id = $1;

-- name: DeleteAccessToken :exec
DELETE FROM access_tokens
WHERE id = sqlc.arg(id)
  AND user_id = sqlc.arg(user_id);

-- name: DeleteAccessTokenByIDAndUserID :execrows
DELETE FROM access_tokens
WHERE id = sqlc.arg(id)
  AND user_id = sqlc.arg(user_id);

-- name: UpdateAccessTokenLastUsed :exec
-- Throttled to one write per five minutes per token: agents poll with their
-- tokens, and an unthrottled stamp rewrote the row on every request.
UPDATE access_tokens
SET last_used_at = NOW(),
    updated_at = NOW()
WHERE id = $1
  AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '5 minutes');

-- name: DeleteExpiredAccessTokens :execrows
-- Prune expired personal access tokens after a 1-day grace window. Expired
-- tokens are already rejected at auth time by GetAuthInfoByTokenHash — the
-- grace only keeps the rows around briefly for debugging/audit. Bounded so a
-- single sweep never deletes an unbounded backlog in one transaction; the
-- periodic cleaner drains any remainder on subsequent ticks.
DELETE FROM access_tokens
WHERE id IN (
    SELECT id
    FROM access_tokens
    WHERE expires_at IS NOT NULL
      AND expires_at < NOW() - INTERVAL '1 day'
    ORDER BY expires_at
    LIMIT 1000
);

-- name: ListUserEmails :many
SELECT *
FROM email_addresses
WHERE user_id = $1
ORDER BY is_primary DESC, created_at ASC;

-- name: GetEmailByID :one
SELECT *
FROM email_addresses
WHERE id = $1;

-- name: DeleteEmail :exec
DELETE FROM email_addresses
WHERE id = sqlc.arg(id)
  AND user_id = sqlc.arg(user_id);

-- name: ActivateEmail :exec
UPDATE email_addresses
SET is_activated = true,
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND user_id = sqlc.arg(user_id);

-- name: GetPrimaryEmail :one
SELECT *
FROM email_addresses
WHERE user_id = $1
  AND is_primary = true;

-- name: CreateEmailVerificationToken :one
INSERT INTO email_verification_tokens (user_id, email, token_hash, token_type, expires_at)
VALUES (
    sqlc.arg(user_id),
    sqlc.arg(email),
    sqlc.arg(token_hash),
    sqlc.arg(token_type),
    sqlc.arg(expires_at)
)
RETURNING *;

-- name: ConsumeEmailVerificationToken :execrows
UPDATE email_verification_tokens
SET used_at = NOW()
WHERE token_hash = $1
  AND used_at IS NULL
  AND expires_at > NOW();

-- name: DeleteExpiredVerificationTokens :exec
DELETE FROM email_verification_tokens
WHERE expires_at < NOW();

-- name: DeleteExpiredNonces :exec
DELETE FROM auth_nonces
WHERE expires_at < NOW();

-- name: CreateOAuthAccount :one
INSERT INTO oauth_accounts (
    user_id,
    provider,
    provider_user_id,
    access_token_encrypted,
    refresh_token_encrypted,
    profile_data
)
VALUES (
    sqlc.arg(user_id),
    sqlc.arg(provider),
    sqlc.arg(provider_user_id),
    sqlc.arg(access_token_encrypted),
    sqlc.arg(refresh_token_encrypted),
    sqlc.arg(profile_data)
)
RETURNING *;

-- name: GetOAuthAccountByProvider :one
SELECT *
FROM oauth_accounts
WHERE provider = sqlc.arg(provider)
  AND provider_user_id = sqlc.arg(provider_user_id);

-- name: GetOAuthAccountByProviderUserID :one
SELECT *
FROM oauth_accounts
WHERE provider = sqlc.arg(provider)
  AND provider_user_id = sqlc.arg(provider_user_id);

-- name: UpsertOAuthAccount :one
INSERT INTO oauth_accounts (
    user_id,
    provider,
    provider_user_id,
    access_token_encrypted,
    refresh_token_encrypted,
    expires_at,
    profile_data
)
VALUES (
    sqlc.arg(user_id),
    sqlc.arg(provider),
    sqlc.arg(provider_user_id),
    sqlc.arg(access_token_encrypted),
    sqlc.arg(refresh_token_encrypted),
    sqlc.narg(expires_at),
    sqlc.arg(profile_data)
)
ON CONFLICT (provider, provider_user_id)
DO UPDATE SET
    user_id = EXCLUDED.user_id,
    access_token_encrypted = EXCLUDED.access_token_encrypted,
    refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
    expires_at = EXCLUDED.expires_at,
    profile_data = EXCLUDED.profile_data,
    updated_at = NOW()
RETURNING *;

-- name: UpsertOAuthAccountPreserveRefresh :one
INSERT INTO oauth_accounts (
    user_id,
    provider,
    provider_user_id,
    access_token_encrypted,
    expires_at,
    profile_data
)
VALUES (
    sqlc.arg(user_id),
    sqlc.arg(provider),
    sqlc.arg(provider_user_id),
    sqlc.arg(access_token_encrypted),
    sqlc.narg(expires_at),
    sqlc.arg(profile_data)
)
ON CONFLICT (provider, provider_user_id)
DO UPDATE SET
    user_id = EXCLUDED.user_id,
    access_token_encrypted = EXCLUDED.access_token_encrypted,
    expires_at = EXCLUDED.expires_at,
    profile_data = EXCLUDED.profile_data,
    updated_at = NOW()
RETURNING *;

-- name: RotateOAuthAccountTokensCAS :execrows
UPDATE oauth_accounts
SET access_token_encrypted = sqlc.arg(access_token_encrypted),
    refresh_token_encrypted = sqlc.arg(refresh_token_encrypted),
    expires_at = sqlc.narg(expires_at),
    updated_at = NOW()
WHERE provider = sqlc.arg(provider)
  AND provider_user_id = sqlc.arg(provider_user_id)
  AND access_token_encrypted IS NOT DISTINCT FROM sqlc.arg(old_access_token_encrypted)
  AND refresh_token_encrypted IS NOT DISTINCT FROM sqlc.arg(old_refresh_token_encrypted);

-- RotateOAuthAccountTokensByAccessCAS is the RACE-HEALING rotation. It keys ONLY
-- on the old access-token ciphertext, deliberately ignoring the refresh column.
--
-- Why it exists: GitHub App refresh tokens are single-use. When two API replicas
-- refresh the same account concurrently, one wins and one gets bad_refresh_token.
-- The loser's ClearOAuthAccountRefreshTokenCAS can land BEFORE the winner's
-- RotateOAuthAccountTokensCAS, NULLing refresh_token_encrypted — which makes the
-- winner's refresh-keyed CAS match zero rows and silently discard the freshly
-- minted, still-valid refresh token. The account is then permanently stuck in
-- "reconnect" despite a healthy grant. The winner holds the newest credential by
-- construction, so it re-asserts over a concurrently-cleared refresh column.
-- name: RotateOAuthAccountTokensByAccessCAS :execrows
UPDATE oauth_accounts
SET access_token_encrypted = sqlc.arg(access_token_encrypted),
    refresh_token_encrypted = sqlc.arg(refresh_token_encrypted),
    expires_at = sqlc.narg(expires_at),
    updated_at = NOW()
WHERE provider = sqlc.arg(provider)
  AND provider_user_id = sqlc.arg(provider_user_id)
  AND access_token_encrypted IS NOT DISTINCT FROM sqlc.arg(old_access_token_encrypted);

-- name: ClearOAuthAccountRefreshTokenCAS :execrows
UPDATE oauth_accounts
SET refresh_token_encrypted = NULL,
    updated_at = NOW()
WHERE provider = sqlc.arg(provider)
  AND provider_user_id = sqlc.arg(provider_user_id)
  AND access_token_encrypted IS NOT DISTINCT FROM sqlc.arg(old_access_token_encrypted)
  AND refresh_token_encrypted IS NOT DISTINCT FROM sqlc.arg(old_refresh_token_encrypted);

-- name: ListUserOAuthAccounts :many
SELECT *
FROM oauth_accounts
WHERE user_id = $1
ORDER BY id ASC;

-- name: DeleteOAuthAccount :exec
DELETE FROM oauth_accounts
WHERE id = sqlc.arg(id)
  AND user_id = sqlc.arg(user_id);

-- name: GetEmailVerificationTokenByHash :one
SELECT *
FROM email_verification_tokens
WHERE token_hash = $1;

-- name: CreateAdminCLIAccessToken :one
-- The PAT and its audit event commit together; no credential is returned if
-- audit persistence fails. Scopes and lifetime are validated by AuthService.
WITH token AS (
    INSERT INTO access_tokens (user_id, name, token_hash, token_last_eight, scopes, expires_at)
    VALUES (@user_id, 'smithers-cli-admin', @token_hash, @token_last_eight, @scopes, @expires_at)
    RETURNING *
), audit AS (
    INSERT INTO audit_log (event_type, actor_id, actor_name, target_type, target_id, target_name, action, metadata, ip_address)
    SELECT 'auth.cli_admin_login', token.user_id, @actor_name, 'access_token', token.id,
           'smithers-cli-admin', 'login', @metadata::jsonb, @ip_address
    FROM token
    RETURNING id
)
SELECT token.* FROM token CROSS JOIN audit;

-- name: GetAccessTokenForOAuthGrant :one
SELECT * FROM access_tokens WHERE id = $1 FOR SHARE;
