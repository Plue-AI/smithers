-- name: GetSelfHostOwner :one
SELECT u.*
FROM self_host_owners o
JOIN users u ON u.id = o.user_id
WHERE o.singleton = TRUE
  AND u.is_active = TRUE
  AND u.deleted_at IS NULL;
