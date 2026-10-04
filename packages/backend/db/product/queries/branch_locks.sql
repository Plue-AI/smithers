-- name: GetBranchLockJoinRequest :one
SELECT * FROM branch_lock_join_requests
WHERE id = $1;
