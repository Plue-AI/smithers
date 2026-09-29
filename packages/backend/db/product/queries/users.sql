-- name: CreateUser :one
INSERT INTO users (username, lower_username, email, lower_email, display_name)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: CreateUserWithWallet :one
INSERT INTO users (username, lower_username, display_name, wallet_address)
VALUES (sqlc.arg(username), sqlc.arg(lower_username), sqlc.arg(display_name), sqlc.arg(wallet_address))
RETURNING *;

-- name: GetAuthInfoByTokenHash :one
SELECT
    u.*,
    t.id AS token_id,
    t.scopes AS token_scopes,
    t.system_issued AS token_system_issued
FROM access_tokens t
JOIN users u ON t.user_id = u.id
WHERE t.token_hash = $1
  AND (t.expires_at IS NULL OR t.expires_at > NOW())
  AND u.is_active = true
  AND u.prohibit_login = false;

-- name: GetUserByID :one
SELECT *
FROM users
WHERE id = $1;

-- name: GetUserByIDNotDeleted :one
SELECT *
FROM users
WHERE id = $1
  AND deleted_at IS NULL;

-- name: GetUserByLowerUsername :one
SELECT *
FROM users
WHERE lower_username = $1
  AND is_active = true
  AND deleted_at IS NULL;

-- name: GetUserByWalletAddress :one
SELECT *
FROM users
WHERE wallet_address = $1
  AND is_active = true
  AND prohibit_login = false;

-- name: GetUserByLowerEmail :one
SELECT *
FROM users
WHERE lower_email = $1
  AND is_active = true;

-- name: UpdateUser :one
UPDATE users
SET display_name = sqlc.arg(display_name),
    bio = sqlc.arg(bio),
    avatar_url = sqlc.arg(avatar_url),
    email = sqlc.arg(email),
    lower_email = sqlc.arg(lower_email),
    updated_at = NOW()
WHERE id = sqlc.arg(user_id)
RETURNING *;

-- name: UpdateUserLastLogin :exec
UPDATE users
SET last_login_at = NOW(),
    updated_at = NOW()
WHERE id = $1;

-- name: ListUsers :many
SELECT *
FROM users
WHERE is_active = true
  AND deleted_at IS NULL
ORDER BY id ASC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: SearchUsers :many
SELECT *
FROM users
WHERE is_active = true
  AND deleted_at IS NULL
  AND (
    lower_username LIKE sqlc.arg(search_query)
    OR LOWER(display_name) LIKE sqlc.arg(search_query)
  )
ORDER BY id ASC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: DeactivateUser :exec
UPDATE users
SET is_active = false,
    updated_at = NOW()
WHERE id = $1;

-- name: SetUserAdmin :exec
UPDATE users
SET is_admin = sqlc.arg(is_admin),
    updated_at = NOW()
WHERE id = sqlc.arg(user_id);

-- name: CountUsers :one
SELECT COUNT(*)
FROM users
WHERE is_active = true
  AND deleted_at IS NULL;

-- name: UpdateUserNotificationPreferences :one
UPDATE users
SET email_notifications_enabled = sqlc.arg(email_notifications_enabled),
    updated_at = NOW()
WHERE id = sqlc.arg(user_id)
RETURNING *;

-- name: GetUserNotificationPreferences :one
SELECT id, email_notifications_enabled
FROM users
WHERE id = $1;

-- name: SuspendUser :exec
UPDATE users
SET is_active = false,
    prohibit_login = true,
    deleted_at = COALESCE(deleted_at, NOW()),
    updated_at = NOW()
WHERE id = $1;

-- name: SetUserSuspended :one
-- Toggles login suspension without permanently deleting the user.
-- When suspended=true: prohibit_login=true, is_active=false.
-- When suspended=false: prohibit_login=false, is_active=true.
-- deleted_at is intentionally not modified so this is reversible for live users.
UPDATE users
SET prohibit_login = sqlc.arg(suspended),
    is_active      = NOT sqlc.arg(suspended)::boolean,
    updated_at     = NOW()
WHERE id = sqlc.arg(user_id)
  AND deleted_at IS NULL
RETURNING *;
