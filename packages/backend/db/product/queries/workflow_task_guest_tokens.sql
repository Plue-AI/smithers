-- name: IssueWorkflowTaskGuestToken :execrows
-- Mints (or replaces) the job credential for a task that is about to run or
-- is running: it is minted before the task's guest boots so it can travel in
-- the guest's egress policy. A finished or blocked task, or one that belongs
-- to another run or repository, gets no credential. The credential
-- authenticates only while its task is running (GetWorkflowRunByTaskGuestToken
-- callers check task_status).
INSERT INTO workflow_task_guest_tokens (workflow_task_id, token_hash, expires_at)
SELECT wt.id, sqlc.arg(token_hash), sqlc.arg(expires_at)
FROM workflow_tasks AS wt
WHERE wt.id = sqlc.arg(workflow_task_id)
  AND wt.workflow_run_id = sqlc.arg(workflow_run_id)
  AND wt.repository_id = sqlc.arg(repository_id)
  AND wt.status IN ('pending', 'assigned', 'running')
ON CONFLICT (workflow_task_id) DO UPDATE
SET token_hash = EXCLUDED.token_hash,
    expires_at = EXCLUDED.expires_at,
    created_at = NOW();

-- name: RevokeWorkflowTaskGuestToken :exec
DELETE FROM workflow_task_guest_tokens
WHERE workflow_task_id = sqlc.arg(workflow_task_id);

-- name: RevokeWorkflowRunGuestTokens :exec
DELETE FROM workflow_task_guest_tokens AS gt
USING workflow_tasks AS wt
WHERE wt.id = gt.workflow_task_id
  AND wt.workflow_run_id = sqlc.arg(workflow_run_id);

-- name: GetWorkflowRunByTaskGuestToken :one
-- Resolves a job credential to its run. The caller still checks expiry, the
-- task's status and the run's status; the join pins the run and the task to
-- the same repository.
SELECT sqlc.embed(wr),
       wt.id AS workflow_task_id,
       wt.status AS task_status,
       gt.expires_at AS token_expires_at
FROM workflow_task_guest_tokens AS gt
JOIN workflow_tasks AS wt ON wt.id = gt.workflow_task_id
JOIN workflow_runs AS wr ON wr.id = wt.workflow_run_id AND wr.repository_id = wt.repository_id
WHERE gt.token_hash = sqlc.arg(token_hash);
