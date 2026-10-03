-- name: GetInstallCapacity :one
SELECT COALESCE((SELECT user_id FROM self_host_owners WHERE singleton), 0)::bigint AS owner_id,
       (SELECT value FROM install_settings WHERE key = 'capacity')::jsonb AS capacity;

-- name: SetInstallCapacity :execrows
INSERT INTO install_settings (key, value, updated_by)
SELECT 'capacity', sqlc.arg(value)::jsonb, user_id
FROM self_host_owners WHERE singleton AND user_id = sqlc.arg(actor_id)::bigint
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW();
