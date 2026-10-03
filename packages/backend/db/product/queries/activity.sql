-- Branch activity (spec §3, §7.2; services/activity.go is the only writer).

-- name: LockBranchForActivity :one
-- Serializes a branch's activity writers, so seq is gap-free in commit order.
SELECT branch_id::text AS id FROM todos WHERE branch_id = sqlc.arg(id)::uuid FOR UPDATE;

-- name: NextActivitySeq :one
SELECT (COALESCE(MAX(seq), 0) + 1)::bigint AS seq FROM activity WHERE branch_id = $1;

-- name: GetActivityBySourceKey :one
SELECT * FROM activity WHERE branch_id = $1 AND source_key = $2;

-- name: InsertActivity :one
INSERT INTO activity (branch_id, seq, actor, asked_by, kind, summary, source_key)
VALUES (sqlc.arg(branch_id), sqlc.arg(seq), sqlc.arg(actor), sqlc.narg(asked_by), sqlc.arg(kind), sqlc.arg(summary), sqlc.narg(source_key))
RETURNING *;

-- name: ListBranchActivity :many
-- The branch's newest entries, oldest first.
SELECT * FROM (
    SELECT * FROM activity WHERE branch_id = sqlc.arg(branch_id) ORDER BY seq DESC LIMIT sqlc.arg(row_limit)
) newest
ORDER BY seq;
