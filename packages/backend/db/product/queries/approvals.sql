-- Ticket 0110: approvals flow queries.
--
-- Emission path: guest-agent -> plue host -> CreateApproval.
-- Decide path: client -> POST /decide -> DecideApproval (state='pending' guard
-- enforces idempotency + conflict detection at the SQL level).
-- Read path: GetApproval for the decide route preflight; ListApprovalsByRepo
-- for repo-scoped inbox clients; ListApprovalsBySession for admin/debug.
--
-- A person confirmation (spec §5.4) is a member's row (member_id set, no
-- session): only the Confirmation queries below read or decide it, so the
-- repo-scoped inbox and its decide never show or settle another member's.

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
SELECT * FROM approvals WHERE id = $1 AND member_id IS NULL;

-- name: ListApprovalsByRepo :many
-- Repo-scoped approval inbox. Empty state_filter returns all approvals.
SELECT * FROM approvals
WHERE repository_id = $1
  AND member_id IS NULL
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
  AND member_id IS NULL
  AND state = 'pending'
RETURNING *;

-- name: ListPendingApprovalsBySession :many
-- Admin / debug helper; not on the hot path. realtime stream is the
-- production read path for connected clients.
SELECT * FROM approvals
WHERE repository_id = $1 AND session_id = $2 AND state = 'pending'
ORDER BY created_at DESC;

-- name: CreateConfirmation :one
-- A delegated credential's command waiting for its member's press (spec
-- §5.4). The same credential's request again (credential_id, request_key)
-- inserts nothing and answers no row; the caller then reads that row.
INSERT INTO approvals (
    id, repository_id, member_id, credential_id, request_key, state, kind, title, expires_at, payload
)
VALUES (
    $1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9
)
ON CONFLICT (credential_id, request_key) WHERE request_key IS NOT NULL DO NOTHING
RETURNING *;

-- name: GetConfirmationByRequest :one
-- The confirmation one credential's Idempotency-Key created.
SELECT * FROM approvals WHERE credential_id = $1 AND request_key = $2;

-- name: GetConfirmation :one
-- One person confirmation; the caller checks it is the caller's own.
SELECT * FROM approvals WHERE id = $1 AND member_id IS NOT NULL;

-- name: ExpireMemberConfirmations :exec
-- A member's pending confirmations past their expiry read as expired.
UPDATE approvals
SET state = 'expired'
WHERE member_id = $1
  AND state = 'pending'
  AND expires_at < NOW();

-- name: ListMemberConfirmations :many
-- A member's own confirmations on the repository, newest first.
SELECT * FROM approvals
WHERE repository_id = $1 AND member_id = $2
ORDER BY created_at DESC
LIMIT 50;

-- name: DecideConfirmation :one
-- The member's press: pending to approved or rejected, once, before its
-- expiry; result is merged into the payload (the TODO an approve filed).
-- No row means it was decided, expired or is not this member's.
UPDATE approvals
SET state      = sqlc.arg(state),
    decided_at = NOW(),
    decided_by = sqlc.arg(member_id),
    payload    = payload || sqlc.arg(result)::jsonb
WHERE id = sqlc.arg(id)
  AND member_id = sqlc.arg(member_id)
  AND state = 'pending'
  AND (expires_at IS NULL OR expires_at > NOW())
RETURNING *;
