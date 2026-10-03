-- name: GetInstallCapacity :one
SELECT COALESCE((SELECT user_id FROM members WHERE role = 'owner'), 0)::bigint AS owner_id,
       (SELECT value FROM install_settings WHERE key = 'capacity')::jsonb AS capacity;

-- name: SetInstallCapacity :execrows
INSERT INTO install_settings (key, value, updated_by)
SELECT 'capacity', sqlc.arg(value)::jsonb, user_id
FROM members WHERE role = 'owner' AND user_id = sqlc.arg(actor_id)::bigint
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW();
