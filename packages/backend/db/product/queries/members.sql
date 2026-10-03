-- name: InstallHasOwner :one
SELECT EXISTS (SELECT 1 FROM members WHERE role = 'owner');

-- name: GetSignInMember :one
-- The roster row a GitHub account signs in as: present and not removed.
SELECT * FROM members
WHERE github_user_id = sqlc.arg(github_user_id)
  AND removed_at IS NULL;

-- name: AuthorizeMemberUser :one
-- Whether a credential's user is on the roster: present, not removed and not
-- suspended, with an active account.
SELECT EXISTS (
    SELECT 1
    FROM members m
    JOIN users u ON u.id = m.user_id
    WHERE m.user_id = sqlc.arg(user_id)
      AND m.removed_at IS NULL
      AND m.suspended_at IS NULL
      AND u.is_active = TRUE
      AND u.deleted_at IS NULL
);

-- name: GetInstallOwnerUser :one
SELECT u.*
FROM members m
JOIN users u ON u.id = m.user_id
WHERE m.role = 'owner';

-- name: CreateOwnerUser :one
INSERT INTO users (username, lower_username, email, lower_email, display_name, is_admin)
VALUES (sqlc.arg(username), sqlc.arg(lower_username), sqlc.narg(email), sqlc.narg(lower_email), sqlc.arg(display_name), TRUE)
RETURNING *;

-- name: CreateOwnerMember :one
INSERT INTO members (user_id, github_user_id, login, role)
VALUES (sqlc.arg(user_id), sqlc.arg(github_user_id), sqlc.arg(login), 'owner')
RETURNING *;

-- name: GetInstallSetting :one
SELECT value FROM install_settings WHERE key = sqlc.arg(key);

-- name: LockInstallSetting :one
SELECT value FROM install_settings WHERE key = sqlc.arg(key) FOR UPDATE;

-- name: PutInstallSetting :exec
INSERT INTO install_settings (key, value, updated_at)
VALUES (sqlc.arg(key), sqlc.arg(value), NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

-- name: DeleteInstallSetting :execrows
DELETE FROM install_settings WHERE key = sqlc.arg(key);
