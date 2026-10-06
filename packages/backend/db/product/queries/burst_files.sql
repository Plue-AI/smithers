-- name: GetBurstFile :one
SELECT path, change, renamed_to, before_blob, after_blob, after_digest
FROM burst_files WHERE branch_id = $1 AND burst_id = $2 AND path = $3;

-- name: ListBurstFiles :many
SELECT path, change, renamed_to, before_blob, after_blob, after_digest
FROM burst_files WHERE branch_id = $1 AND burst_id = $2 ORDER BY path;
