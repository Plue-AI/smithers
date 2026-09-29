-- name: DeleteWorkflowLogsOlderThan :execrows
-- Lock the parent before log rows, matching insertion and cascading deletion.
WITH run_lock AS MATERIALIZED (
 SELECT r.id FROM workflow_runs r
 WHERE r.completed_at < sqlc.arg(cutoff)::timestamptz
   AND r.status IN ('success', 'failure', 'cancelled')
   AND EXISTS (SELECT 1 FROM workflow_logs l WHERE l.workflow_run_id = r.id AND l.created_at < sqlc.arg(cutoff)::timestamptz)
 ORDER BY r.completed_at, r.id
 LIMIT 1
 FOR UPDATE OF r SKIP LOCKED
)
DELETE FROM workflow_logs
WHERE id IN (
 SELECT l.id FROM workflow_logs l JOIN run_lock r ON r.id = l.workflow_run_id
 WHERE l.created_at < sqlc.arg(cutoff)::timestamptz
 ORDER BY l.created_at, l.id
 LIMIT LEAST(GREATEST(sqlc.arg(batch_limit)::int, 0), 1000)
);

-- name: DeleteWorkflowRunLogsOlderThan :execrows
-- Lock the parent before log rows, matching insertion and cascading deletion.
WITH run_lock AS MATERIALIZED (
 SELECT r.id FROM workflow_runs r
 WHERE r.completed_at < sqlc.arg(cutoff)::timestamptz
   AND r.status IN ('success', 'failure', 'cancelled')
   AND EXISTS (SELECT 1 FROM workflow_run_logs l WHERE l.workflow_run_id = r.id AND l.created_at < sqlc.arg(cutoff)::timestamptz)
 ORDER BY r.completed_at, r.id
 LIMIT 1
 FOR UPDATE OF r SKIP LOCKED
)
DELETE FROM workflow_run_logs
WHERE id IN (
 SELECT l.id FROM workflow_run_logs l JOIN run_lock r ON r.id = l.workflow_run_id
 WHERE l.created_at < sqlc.arg(cutoff)::timestamptz
 ORDER BY l.created_at, l.id
 LIMIT LEAST(GREATEST(sqlc.arg(batch_limit)::int, 0), 1000)
);

