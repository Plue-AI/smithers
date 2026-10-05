-- Ticket 0110: approvals flow queries.
--
-- Emission path: guest-agent -> plue host -> CreateApproval.
-- Decide path: client -> POST /decide -> DecideApproval (state='pending' guard
-- enforces idempotency + conflict detection at the SQL level).
-- Read path: GetApproval for the decide route preflight; ListApprovalsByRepo
-- for repo-scoped inbox clients; ListApprovalsBySession for admin/debug.

-- name: CreateApproval :one
-- Insert a fresh pending-state approval. Caller supplies repository_id from
-- the session context (NOT NULL: realtime stream auth requires it).
INSERT INTO approvals (
    id, session_id, repository_id, state, kind, title, description, expires_at, payload
)
VALUES (
    $1, $2, $3, 'pending', $4, $5, $6, $7, $8
)
RETURNING *;

-- name: GetApproval :one
-- Returns a single approval row. Does NOT filter on repository_id; the route
-- layer enforces repo scoping using the row's repository_id value.
SELECT * FROM approvals WHERE id = $1 AND kind NOT IN ('one_click', 'review_merge');

-- name: ListApprovalsByRepo :many
-- Repo-scoped approval inbox. Empty state_filter returns all approvals.
SELECT * FROM approvals
WHERE repository_id = $1
  AND kind NOT IN ('one_click', 'review_merge')
  AND (sqlc.arg(state)::text = '' OR state = sqlc.arg(state))
ORDER BY created_at DESC
LIMIT sqlc.arg(page_size) OFFSET sqlc.arg(page_offset);

-- name: DecideApproval :one
-- Transitions a pending approval to 'approved' or 'rejected'. The
-- `state = 'pending'` guard is the idempotency / conflict detection gate:
--   - If the caller tries to transition a non-pending row, zero rows match
--     and sqlc returns ErrNoRows. The service layer then re-reads the row
--     and decides "idempotent same decision" vs "409 conflict" based on the
--     persisted state.
-- repository_id predicate scopes the update to the route's repo context so
-- a malicious caller can't flip an approval in a different repo by ID.
UPDATE approvals
SET state       = $2,
    decided_at  = NOW(),
    decided_by  = $3
WHERE id = $1
  AND repository_id = $4
  AND state = 'pending'
  AND kind NOT IN ('one_click', 'review_merge')
RETURNING *;

-- name: ListPendingApprovalsBySession :many
-- Admin / debug helper; not on the hot path. realtime stream is the
-- production read path for connected clients.
SELECT * FROM approvals
WHERE repository_id = $1 AND session_id = $2 AND state = 'pending'
  AND kind NOT IN ('one_click', 'review_merge')
ORDER BY created_at DESC;
