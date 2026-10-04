-- name: CreateAgentSession :one
INSERT INTO agent_sessions (id, repository_id, user_id, title, status, metadata)
VALUES ($1, $2, $3, $4, $5, COALESCE(sqlc.narg(metadata)::jsonb, '{}'::jsonb))
RETURNING *;

-- name: GetAgentSession :one
-- Returns a non-tombstoned session. Callers that need to inspect tombstoned
-- rows for admin/debug should use GetAgentSessionAnyState instead (ticket 0114).
SELECT *
FROM agent_sessions
WHERE id = $1 AND deleted_at IS NULL;

-- name: GetAgentSessionAnyState :one
-- Returns a session regardless of tombstone state. For admin/debug only; do
-- NOT expose through the public repo-scoped API (ticket 0114).
SELECT *
FROM agent_sessions
WHERE id = $1;

-- name: ListAgentSessionsByRepo :many
SELECT *
FROM agent_sessions
WHERE repository_id = $1 AND deleted_at IS NULL
ORDER BY created_at DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: CountAgentSessionsByRepo :one
SELECT COUNT(*) FROM agent_sessions
WHERE repository_id = $1 AND deleted_at IS NULL;

-- name: UpdateAgentSessionStatus :one
UPDATE agent_sessions
SET status = $2, updated_at = NOW()
WHERE id = $1 AND deleted_at IS NULL
RETURNING *;

-- name: PrepareAgentSessionForTurn :one
-- A completed author session can be resumed for reviewer feedback. Refuse to
-- reactivate it while its previous run is still queued/running.
UPDATE agent_sessions AS session
SET status = 'active',
    finished_at = NULL,
    updated_at = NOW()
WHERE session.id = sqlc.arg(session_id)
  AND session.deleted_at IS NULL
  AND NOT EXISTS (
      SELECT 1
      FROM workflow_runs AS run
      WHERE run.id = session.workflow_run_id
        AND run.status IN ('queued', 'running')
  )
RETURNING session.*;

-- name: UpdateAgentSessionStartedAt :one
UPDATE agent_sessions
SET started_at = COALESCE(started_at, $2), updated_at = NOW()
WHERE id = $1 AND deleted_at IS NULL
RETURNING *;

-- name: UpdateAgentSessionTerminalStatus :one
-- Dispatch cleanup must still own the session's run. A NULL expected run is
-- reserved for session-scoped completion/cancellation, which targets the session.
UPDATE agent_sessions
SET status = $2, finished_at = $3, updated_at = NOW()
WHERE id = $1 AND status = 'active' AND deleted_at IS NULL
  AND (sqlc.narg(expected_workflow_run_id)::bigint IS NULL
       OR workflow_run_id = sqlc.narg(expected_workflow_run_id)::bigint)
RETURNING *;

-- name: GetAgentSessionForFlowProjection :one
SELECT session.*
FROM agent_sessions AS session
JOIN workflow_tasks AS task
  ON task.id = sqlc.arg(workflow_task_id)
 AND task.workflow_run_id = sqlc.arg(workflow_run_id)
WHERE session.id = sqlc.arg(session_id)
  AND session.workflow_run_id = sqlc.arg(workflow_run_id)
  AND session.deleted_at IS NULL;

-- name: UpdateAgentSessionTerminalStatusForFlow :one
-- The session row lock acquired by UPDATE serializes this check with the next
-- turn's workflow_run_id assignment. A replay for an older run/task gets no row.
UPDATE agent_sessions AS session
SET status = sqlc.arg(status),
    finished_at = sqlc.arg(finished_at),
    updated_at = NOW()
WHERE session.id = sqlc.arg(session_id)
  AND session.workflow_run_id = sqlc.arg(workflow_run_id)
  AND session.status = 'active'
  AND session.deleted_at IS NULL
  AND EXISTS (
      SELECT 1 FROM workflow_tasks AS task
      WHERE task.id = sqlc.arg(workflow_task_id)
        AND task.workflow_run_id = sqlc.arg(workflow_run_id)
  )
RETURNING session.*;

-- name: UpdateAgentSessionTimedOut :one
UPDATE agent_sessions
SET status = 'timed_out', finished_at = $2, updated_at = NOW()
WHERE id = $1 AND status = 'active' AND deleted_at IS NULL
RETURNING *;

-- name: LockAgentSessionForAppend :one
-- Locks an active, live agent session row for update to prevent race conditions.
-- Terminal and tombstoned sessions are invisible here; message append will fail
-- with ErrNoRows. The lock serializes the final append with the terminal status
-- transition so transcript archiving observes a stable high-water mark.
-- Returns repository_id so the append path can populate the denormalized
-- repository_id on agent_messages / agent_parts without a second round-trip
-- (tickets 0115, 0118).
SELECT id, repository_id FROM agent_sessions
WHERE id = $1 AND status = 'active' AND deleted_at IS NULL
FOR UPDATE;

-- name: UpdateAgentSessionWorkflowRun :one
-- Updates the workflow_run_id on an agent session.
UPDATE agent_sessions
SET workflow_run_id = $1, updated_at = NOW()
WHERE id = $2 AND deleted_at IS NULL
RETURNING *;

-- name: DeleteAgentSession :exec
-- Tombstone (soft-delete) an agent session. Idempotent: re-deleting an
-- already-tombstoned row is a no-op. Ticket 0114 keeps the row so clients
-- subscribers observe a visible->hidden transition via where-clause filtering
-- (deleted_at IS NULL) on the shape.
UPDATE agent_sessions
SET deleted_at = COALESCE(deleted_at, NOW()), updated_at = NOW()
WHERE id = $1 AND user_id = $2;

-- name: CreateAgentMessage :one
-- Ticket 0115: callers must supply repository_id (from the parent session)
-- so the realtime stream filter `repository_id IN (...) AND session_id IN
-- (...)` lines up with a populated column on every insert.
WITH session_lock AS (
    SELECT agent_sessions.id FROM agent_sessions WHERE agent_sessions.id = sqlc.arg(session_id) FOR UPDATE
)
INSERT INTO agent_messages (session_id, repository_id, role, sequence)
SELECT session_lock.id, sqlc.arg(repository_id), sqlc.arg(role), sqlc.arg(sequence)
FROM session_lock
RETURNING *;

-- name: GetNextAgentMessageSequence :one
SELECT COALESCE(MAX(sequence), -1) + 1 AS next_seq
FROM agent_messages
WHERE session_id = $1;

-- name: CreateAgentMessageWithNextSequence :one
-- Atomically locks the session row, computes the next sequence, and inserts the message.
-- This prevents race conditions when concurrent appends target the same session.
-- Ticket 0115: the denormalized repository_id is taken directly from the
-- locked parent session row, so it cannot drift from the session.
WITH locked_session AS (
    SELECT agent_sessions.id, agent_sessions.repository_id
    FROM agent_sessions
    WHERE agent_sessions.id = sqlc.arg(session_id)
      AND agent_sessions.deleted_at IS NULL
    FOR UPDATE
)
INSERT INTO agent_messages (session_id, repository_id, role, sequence)
SELECT
    ls.id,
    ls.repository_id,
    sqlc.arg(role),
    COALESCE((SELECT MAX(sequence) FROM agent_messages WHERE session_id = ls.id), -1) + 1
FROM locked_session ls
RETURNING *;

-- name: CreateAgentPart :one
-- Ticket 0118: callers must supply repository_id + session_id (from the
-- parent message's session). The values are the same as the parent
-- agent_messages row's; the realtime stream filter
-- `repository_id IN (...) AND session_id IN (...)` is evaluated purely
-- against agent_parts columns to avoid a join.
INSERT INTO agent_parts (message_id, repository_id, session_id, part_index, part_type, content)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: ListAgentMessageParts :many
SELECT *
FROM agent_parts
WHERE message_id = $1
ORDER BY part_index ASC;

-- name: ListAgentMessages :many
SELECT *
FROM agent_messages
WHERE session_id = $1
ORDER BY sequence ASC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: GetAgentSessionWorkflowRunID :one
SELECT workflow_run_id FROM agent_sessions
WHERE id = $1 AND deleted_at IS NULL;

-- name: ListStaleActiveSessions :many
-- Reaper query: only scan live sessions. Tombstoned rows are by definition
-- no longer running, so skip them.
SELECT *
FROM agent_sessions
WHERE status = 'active'
  AND deleted_at IS NULL
  AND started_at IS NOT NULL
  AND started_at < $1
ORDER BY started_at ASC;

-- name: NotifyAgentMessage :exec
-- Sends a pg_notify on the agent_session_{session_id_no_dashes} channel.
-- Called after inserting an agent message so SSE subscribers receive the event.
SELECT pg_notify(
    'agent_session_' || replace(sqlc.arg(session_id)::text, '-', ''),
    sqlc.arg(payload)::text
);

-- name: CountAgentMessagesBySession :one
SELECT COUNT(*) FROM agent_messages WHERE session_id = $1;

-- name: ListAgentSessionsByRepoWithMessageCount :many
-- Lists sessions enriched with message_count for list/detail views.
-- Excludes tombstoned rows (ticket 0114).
SELECT
    s.id,
    s.repository_id,
    s.user_id,
    s.workflow_run_id,
    s.title,
    s.status,
    s.metadata,
    s.started_at,
    s.finished_at,
    s.created_at,
    s.updated_at,
    s.workspace_id,
    COALESCE(mc.cnt, 0)::bigint AS message_count
FROM agent_sessions s
LEFT JOIN (
    SELECT session_id, COUNT(*) AS cnt
    FROM agent_messages
    GROUP BY session_id
) mc ON mc.session_id = s.id
WHERE s.repository_id = $1 AND s.deleted_at IS NULL
ORDER BY s.created_at DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: GetAgentSessionWithMessageCount :one
-- Returns a single session enriched with message_count.
-- Excludes tombstoned rows (ticket 0114).
SELECT
    s.id,
    s.repository_id,
    s.user_id,
    s.workflow_run_id,
    s.title,
    s.status,
    s.metadata,
    s.started_at,
    s.finished_at,
    s.created_at,
    s.updated_at,
    s.workspace_id,
    COALESCE(mc.cnt, 0)::bigint AS message_count
FROM agent_sessions s
LEFT JOIN (
    SELECT session_id, COUNT(*) AS cnt
    FROM agent_messages
    GROUP BY session_id
) mc ON mc.session_id = s.id
WHERE s.id = $1 AND s.deleted_at IS NULL;

-- name: NotifyAgentSession :exec
-- Sends a pg_notify on the agent_session_{session_id} channel for session-level events.
-- session_id must already have dashes stripped by the caller.
SELECT pg_notify(
    'agent_session_' || sqlc.arg(session_id)::text,
    sqlc.arg(payload)::text
);

-- name: ListAgentMessagesAfterID :many
-- Returns messages with id > after_id for a given session, ordered ascending.
-- Used by the SSE handler to replay missed events on reconnection.
SELECT id, session_id, repository_id, role, sequence, created_at
FROM agent_messages
WHERE session_id = $1 AND id > @after_id
ORDER BY id ASC
LIMIT @max_results;

-- name: SetAgentSessionWorkspace :exec
-- RFD-004: links a run to the workspace it executes in.
UPDATE agent_sessions
SET workspace_id = sqlc.narg(workspace_id)::uuid,
    updated_at = NOW()
WHERE id = $1;

-- name: TouchWorkspaceActivityByAgentSession :exec
-- RFD-004: an agent run's activity keeps its workspace out of idle suspend.
UPDATE workspaces
SET last_activity_at = NOW()
WHERE id = (SELECT workspace_id FROM agent_sessions WHERE id = sqlc.arg(agent_session_id)::uuid)
  AND deleted_at IS NULL;

-- name: GetAgentMessageStreamHead :one
WITH session_lock AS (
    SELECT agent_sessions.id FROM agent_sessions WHERE agent_sessions.id = sqlc.arg(session_id) FOR UPDATE
)
SELECT COALESCE(MAX(m.id), 0)::bigint AS head
FROM session_lock LEFT JOIN agent_messages m ON m.session_id = session_lock.id;

-- name: CountActiveAgentSessions :one
-- Runtime gauge: sessions still holding an agent run.
SELECT COUNT(*)::bigint AS active_sessions
FROM agent_sessions
WHERE status = 'active';

-- name: GetActiveAgentSessionOldestAgeSeconds :one
-- Runtime gauge: age of the oldest active session; zero when none is active.
SELECT COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(created_at)), 0)::double precision AS oldest_age_seconds
FROM agent_sessions
WHERE status = 'active';
