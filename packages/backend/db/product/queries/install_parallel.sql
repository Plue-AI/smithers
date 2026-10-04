-- name: GetInstallParallel :one
SELECT (SELECT value FROM install_settings WHERE key = 'parallel')::jsonb AS parallel;

-- name: SetInstallParallel :execrows
INSERT INTO install_settings (key, value, updated_by)
SELECT 'parallel', sqlc.arg(value)::jsonb, user_id
FROM self_host_owners WHERE singleton AND user_id = sqlc.arg(actor_id)::bigint
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW();
