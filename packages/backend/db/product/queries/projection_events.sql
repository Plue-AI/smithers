-- Projection events (spec §3.1, §3.3; services/projection.go is the only
-- writer, the live channel of T-COL-02 the reader).

-- name: NextProjectionSeq :one
-- Takes the topic's next seq and holds its row locked until commit, so seq
-- order is commit order and a rollback gives the seq back.
INSERT INTO projection_topics (repository_id, topic, last_seq) VALUES (sqlc.arg(repository_id), sqlc.arg(topic), 1)
ON CONFLICT (repository_id, topic) DO UPDATE SET last_seq = projection_topics.last_seq + 1
RETURNING last_seq;

-- name: InsertProjectionEvent :one
INSERT INTO projection_events (repository_id, topic, seq, payload) VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: NotifyLive :exec
-- Queued with the transaction: PostgreSQL delivers it only at commit.
SELECT pg_notify('live', sqlc.arg(topic)::text);

-- name: ListProjectionEvents :many
SELECT * FROM projection_events
WHERE repository_id = sqlc.arg(repository_id) AND topic = sqlc.arg(topic) AND seq > sqlc.arg(after_seq)::bigint
ORDER BY seq
LIMIT sqlc.arg(row_limit);

-- name: PruneProjectionEvents :execrows
-- Deletes a topic's rows that are both older than cutoff and outside its
-- newest keep rows: retention keeps the larger of the two windows (§3.3).
DELETE FROM projection_events e
USING projection_topics t
WHERE e.repository_id = t.repository_id AND e.topic = t.topic
  AND e.at < sqlc.arg(cutoff)
  AND e.seq <= t.last_seq - sqlc.arg(keep)::bigint;
