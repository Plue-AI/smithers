-- name: CreateRepositoryTransferRequest :one
INSERT INTO repository_transfer_requests
    (repository_id, sender_id, recipient_id, source_user_id, source_org_id, source_owner, source_name)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: GetRepositoryTransferRequest :one
SELECT * FROM repository_transfer_requests WHERE id = $1;

-- name: GetPendingRepositoryTransferRequest :one
SELECT * FROM repository_transfer_requests WHERE repository_id = $1 AND status = 'pending';

-- name: ListRepositoryTransferRequests :many
SELECT request.* FROM repository_transfer_requests request
JOIN repositories repo ON repo.id = request.repository_id
WHERE request.status = 'pending' AND request.expires_at > clock_timestamp()
  AND (request.recipient_id = sqlc.arg(user_id) OR repo.user_id = sqlc.arg(user_id)
       OR EXISTS (SELECT 1 FROM org_members member
                  WHERE member.organization_id = repo.org_id
                    AND member.user_id = sqlc.arg(user_id) AND member.role = 'owner'))
ORDER BY request.id;

-- name: ExpireRepositoryTransferRequests :exec
UPDATE repository_transfer_requests SET status = 'expired', resolved_at = clock_timestamp()
WHERE repository_id = $1 AND status = 'pending' AND expires_at <= clock_timestamp();

-- name: ResolveRepositoryTransferRequest :one
UPDATE repository_transfer_requests SET status = $2, resolved_at = clock_timestamp()
WHERE id = $1 AND status = 'pending' AND expires_at > clock_timestamp()
RETURNING *;
