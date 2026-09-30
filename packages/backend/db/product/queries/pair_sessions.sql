-- ---- Pair sessions (server-authoritative pairing) ----

-- name: CreatePairSession :one
INSERT INTO pair_sessions (
    id,
    owner_user_id,
    source_workspace_id,
    access_mode,
    status
)
VALUES (
    sqlc.arg(id)::text,
    sqlc.arg(owner_user_id),
    sqlc.arg(source_workspace_id),
    sqlc.arg(access_mode)::text,
    'provisioning'
)
RETURNING *;

-- name: GetPairSession :one
SELECT * FROM pair_sessions WHERE id = $1;

-- name: GetLivePairSessionForSource :one
SELECT * FROM pair_sessions
WHERE source_workspace_id = $1
  AND status NOT IN ('ended', 'failed')
LIMIT 1;

-- name: SetPairSessionForkBound :one
-- Fork landed: bind the fork workspace and flip the session live. The
-- status = 'provisioning' guard prevents a slow fork from resurrecting a
-- session that was concurrently ended (owner) or failed (stale-provisioning
-- sweep) — without it a late bind flips a dead session back to 'active'.
UPDATE pair_sessions
SET workspace_id = sqlc.arg(workspace_id),
    status = 'active',
    updated_at = NOW()
WHERE id = $1
  AND status = 'provisioning'
RETURNING *;

-- name: SetPairSessionStatus :one
UPDATE pair_sessions
SET status = sqlc.arg(status)::text,
    ended_at = CASE WHEN sqlc.arg(status)::text IN ('ended', 'failed') THEN NOW() ELSE ended_at END,
    updated_at = NOW()
WHERE id = $1
RETURNING *;

-- name: EndPairSessionForOwner :one
WITH ended AS (
    UPDATE pair_sessions
    SET status = 'ended',
        ended_at = NOW(),
        updated_at = NOW()
    WHERE id = sqlc.arg(id)::text
      AND pair_sessions.owner_user_id = sqlc.arg(owner_user_id)
      AND status NOT IN ('ended', 'failed')
    RETURNING *
), cleared AS (
    DELETE FROM workspace_shares
    USING ended
    WHERE ended.workspace_id IS NOT NULL
      AND workspace_shares.workspace_id = ended.workspace_id
    RETURNING 1
)
SELECT * FROM ended;

-- name: SetPairSessionAccessMode :one
UPDATE pair_sessions
SET access_mode = sqlc.arg(access_mode)::text,
    updated_at = NOW()
WHERE id = $1
RETURNING *;

-- name: FailStalePairSessions :many
-- Compensation sweep: any session stuck in 'provisioning' past the cutoff is
-- flipped to 'failed' so the one-live-session-per-source index cannot wedge the
-- owner.
UPDATE pair_sessions
SET status = 'failed',
    ended_at = NOW(),
    updated_at = NOW()
WHERE status = 'provisioning'
  AND created_at < sqlc.arg(cutoff)
RETURNING *;

-- ---- Pair session members ----

-- name: UpsertPairSessionMember :one
INSERT INTO pair_session_members (
    session_id,
    user_id,
    role,
    invited_via_invite_id
)
VALUES (
    sqlc.arg(session_id)::text,
    sqlc.arg(user_id),
    sqlc.arg(role)::text,
    sqlc.narg(invited_via_invite_id)
)
ON CONFLICT (session_id, user_id) DO UPDATE
SET role = EXCLUDED.role,
    invited_via_invite_id = COALESCE(EXCLUDED.invited_via_invite_id, pair_session_members.invited_via_invite_id)
-- Never resurrect a removed (revoked) member: a still-live link must not let a
-- revoked user readmit themselves (returns no row instead). Readmission goes
-- through an owner-granted invite (AcceptPairSessionInvite clears removed_at).
WHERE pair_session_members.removed_at IS NULL
RETURNING *;

-- name: GetLivePairSessionMember :one
SELECT * FROM pair_session_members
WHERE session_id = $1
  AND user_id = $2
  AND removed_at IS NULL;

-- name: ListLivePairSessionMembers :many
SELECT * FROM pair_session_members
WHERE session_id = $1
  AND removed_at IS NULL
ORDER BY joined_at ASC;

-- name: ListLivePairSessionMemberProfiles :many
-- Members with their public identity (presence/attribution renders the REAL
-- session user — no client-side nicknames). Public profile fields only.
SELECT m.session_id, m.user_id, m.role, m.joined_at, m.last_seen_at,
       u.username, u.display_name, u.avatar_url
FROM pair_session_members m
JOIN users u ON u.id = m.user_id
WHERE m.session_id = $1
  AND m.removed_at IS NULL
ORDER BY m.joined_at ASC;

-- name: SetPairSessionMemberRole :one
UPDATE pair_session_members
SET role = sqlc.arg(role)::text
WHERE session_id = $1
  AND user_id = $2
  AND removed_at IS NULL
RETURNING *;

-- name: RevokePairSessionMember :one
UPDATE pair_session_members
SET removed_at = NOW()
WHERE session_id = $1
  AND user_id = $2
  AND removed_at IS NULL
  AND role <> 'owner'
RETURNING *;

-- name: UpdatePairSessionMemberPresence :one
-- 80ms cursor/caret beat writes ONLY this member's row, and only while the
-- member and the session are both live, so a beat racing a removal or an end
-- cannot write after it.
UPDATE pair_session_members
SET presence = sqlc.arg(presence),
    presence_updated_at = NOW(),
    last_seen_at = NOW()
WHERE session_id = $1
  AND user_id = $2
  AND removed_at IS NULL
  AND EXISTS (
    SELECT 1 FROM pair_sessions
    WHERE pair_sessions.id = pair_session_members.session_id
      AND pair_sessions.status NOT IN ('ended', 'failed')
  )
RETURNING *;

-- name: TouchPairSessionMemberSeen :exec
UPDATE pair_session_members
SET last_seen_at = NOW()
WHERE session_id = $1
  AND user_id = $2
  AND removed_at IS NULL;

-- ---- Pair prompt queue (serial FIFO + executor election) ----

-- name: EnqueuePairPrompt :one
-- Serial FIFO seq assignment (decision #3): seq is MAX+1 per session. Under
-- concurrent multi-user submission two enqueues can compute the same MAX and
-- collide on UNIQUE(session_id, seq); the service wraps this call in a
-- unique-violation retry loop so the loser recomputes and retries rather than
-- 500ing. (A single-statement advisory lock cannot fix this: READ COMMITTED
-- fixes the snapshot before the lock is acquired, so MAX would still read stale.)
INSERT INTO pair_prompt_queue (
    session_id,
    seq,
    author_user_id,
    source,
    body
)
VALUES (
    sqlc.arg(session_id)::text,
    (SELECT COALESCE(MAX(seq), 0) + 1 FROM pair_prompt_queue WHERE session_id = sqlc.arg(session_id)::text),
    sqlc.arg(author_user_id),
    sqlc.arg(source)::text,
    sqlc.arg(body)
)
RETURNING *;

-- name: ListPairPromptQueue :many
SELECT * FROM pair_prompt_queue
WHERE session_id = $1
ORDER BY seq ASC;

-- name: GetPairPrompt :one
SELECT * FROM pair_prompt_queue WHERE id = $1;

-- name: ClaimPairPrompt :one
-- Atomic CAS: first-claim OR expired-lease takeover in one statement. The
-- partial-unique one-active index rejects any concurrent second winner.
UPDATE pair_prompt_queue
SET status = 'claimed',
    executor_client_id = sqlc.arg(executor_client_id)::text,
    claim_expires_at = sqlc.arg(claim_expires_at)
WHERE id = sqlc.arg(id)
  AND session_id = sqlc.arg(session_id)::text
  AND (
    status = 'queued'
    OR (status = 'claimed' AND claim_expires_at < NOW() AND run_id IS NULL)
  )
RETURNING *;

-- name: StartPairPrompt :one
-- Start CAS: write run_id + flip to running BEFORE streaming. Failure = abort
-- without dispatch (the claim was cancelled/taken over). session_id is part of
-- the CAS so a role check against one session can never mutate another's row.
UPDATE pair_prompt_queue
SET status = 'running',
    run_id = sqlc.arg(run_id)::text,
    started_at = NOW()
WHERE id = sqlc.arg(id)
  AND session_id = sqlc.arg(session_id)::text
  AND status = 'claimed'
  AND executor_client_id = sqlc.arg(executor_client_id)::text
RETURNING *;

-- name: RenewPairPromptLease :one
UPDATE pair_prompt_queue
SET claim_expires_at = sqlc.arg(claim_expires_at)
WHERE id = sqlc.arg(id)
  AND session_id = sqlc.arg(session_id)::text
  AND executor_client_id = sqlc.arg(executor_client_id)::text
  AND status IN ('claimed', 'running')
RETURNING *;

-- name: FinishPairPrompt :one
-- Executor-only finalization of its own running row (done/failed/canceled).
UPDATE pair_prompt_queue
SET status = sqlc.arg(status)::text,
    finished_at = NOW()
WHERE id = sqlc.arg(id)
  AND session_id = sqlc.arg(session_id)::text
  AND executor_client_id = sqlc.arg(executor_client_id)::text
  AND status = 'running'
RETURNING *;

-- name: CancelOwnQueuedPairPrompt :one
-- Author cancels their OWN queued row.
UPDATE pair_prompt_queue
SET status = 'canceled',
    canceled_by = sqlc.arg(canceled_by),
    finished_at = NOW()
WHERE id = sqlc.arg(id)
  AND session_id = sqlc.arg(session_id)::text
  AND author_user_id = sqlc.arg(canceled_by)
  AND status = 'queued'
RETURNING *;

-- name: CancelAnyPendingPairPrompt :one
-- Owner cancels ANY queued/claimed row (the executor's subsequent start-CAS
-- then fails and aborts cleanly). 'running' rows route through the real
-- run-cancel seam, not this query.
UPDATE pair_prompt_queue
SET status = 'canceled',
    canceled_by = sqlc.arg(canceled_by),
    finished_at = NOW()
WHERE id = sqlc.arg(id)
  AND session_id = sqlc.arg(session_id)::text
  AND status IN ('queued', 'claimed')
RETURNING *;

-- name: SweepStalePairPromptClaims :many
-- Server sweep: revert expired 'claimed' rows WITHOUT a run_id back to 'queued'.
-- Rows WITH a run_id are never reverted — run_id is the never-re-dispatch marker.
UPDATE pair_prompt_queue
SET status = 'queued',
    executor_client_id = NULL,
    claim_expires_at = NULL
WHERE status = 'claimed'
  AND run_id IS NULL
  AND claim_expires_at < NOW()
RETURNING *;

-- name: FailStaleRunningPairPrompts :many
-- Recovery sweep: a 'running' prompt whose executor died stops renewing its
-- lease, and the pair_prompt_queue_one_active index then blocks EVERY future
-- claim in that session — wedging the queue forever with no operator-reachable
-- recovery. Past a grace window beyond the expired lease, mark it 'failed' so the
-- one-active slot releases and the queue can advance. A live executor keeps
-- claim_expires_at in the future via RenewPairPromptLease, so it is never touched.
UPDATE pair_prompt_queue
SET status = 'failed',
    finished_at = NOW()
WHERE status = 'running'
  AND claim_expires_at IS NOT NULL
  AND claim_expires_at < NOW() - make_interval(secs => sqlc.arg(grace_secs)::int)
RETURNING *;

-- ---- Pair session invites ----

-- name: CreatePairSessionInvite :one
-- At least one of lower_email / lower_github_username must be set (enforced by
-- the pair_session_invites_join_key_present CHECK from migration 000094).
INSERT INTO pair_session_invites (
    session_id,
    lower_email,
    lower_github_username,
    role,
    token_hash,
    invited_by,
    expires_at
)
VALUES (
    sqlc.arg(session_id)::text,
    sqlc.narg(lower_email)::text,
    sqlc.narg(lower_github_username)::text,
    sqlc.arg(role)::text,
    sqlc.arg(token_hash)::text,
    sqlc.arg(invited_by),
    sqlc.arg(expires_at)
)
RETURNING *;

-- name: GetLivePairSessionInviteForEmail :one
SELECT * FROM pair_session_invites
WHERE session_id = $1
  AND lower_email = sqlc.arg(lower_email)::text
  AND revoked_at IS NULL
  AND accepted_at IS NULL
  AND expires_at > NOW()
ORDER BY created_at DESC
LIMIT 1;

-- name: GetLivePairSessionInviteForUsername :one
-- Username invites match the signed-in visitor's login (plue usernames are
-- GitHub logins), mirroring the email path.
SELECT * FROM pair_session_invites
WHERE session_id = $1
  AND lower_github_username = sqlc.arg(lower_github_username)::text
  AND revoked_at IS NULL
  AND accepted_at IS NULL
  AND expires_at > NOW()
ORDER BY created_at DESC
LIMIT 1;

-- name: GetPairSessionInviteByTokenHash :one
SELECT * FROM pair_session_invites
WHERE token_hash = sqlc.arg(token_hash)::text
  AND revoked_at IS NULL
  AND accepted_at IS NULL
  AND expires_at > NOW();

-- name: GetPairSessionInvite :one
SELECT * FROM pair_session_invites
WHERE id = sqlc.arg(id)
  AND session_id = sqlc.arg(session_id)::text;

-- name: ListPairSessionInvites :many
SELECT * FROM pair_session_invites
WHERE session_id = $1
  AND revoked_at IS NULL
ORDER BY created_at DESC;

-- name: AcceptPairSessionInvite :one
WITH accepted_invite AS (
    UPDATE pair_session_invites
    SET accepted_by_user_id = sqlc.arg(accepted_by_user_id),
        accepted_at = NOW()
    WHERE id = sqlc.arg(id)
      AND session_id = sqlc.arg(session_id)::text
      AND revoked_at IS NULL
      AND accepted_at IS NULL
      AND expires_at > NOW()
    RETURNING id, session_id, role
)
INSERT INTO pair_session_members (
    session_id,
    user_id,
    role,
    invited_via_invite_id
)
SELECT
    session_id,
    sqlc.arg(user_id),
    role,
    id
FROM accepted_invite
ON CONFLICT (session_id, user_id) DO UPDATE
SET role = EXCLUDED.role,
    removed_at = NULL,
    invited_via_invite_id = EXCLUDED.invited_via_invite_id
RETURNING *;

-- name: MarkPairSessionInviteAccepted :one
UPDATE pair_session_invites
SET accepted_by_user_id = sqlc.arg(accepted_by_user_id),
    accepted_at = NOW()
WHERE id = $1
  AND revoked_at IS NULL
  AND accepted_at IS NULL
RETURNING *;

-- name: RevokePairSessionInvite :one
UPDATE pair_session_invites
SET revoked_at = NOW()
WHERE session_id = $1
  AND lower_email = sqlc.arg(lower_email)::text
  AND revoked_at IS NULL
RETURNING *;

-- name: RevokePairSessionInviteByUsername :one
UPDATE pair_session_invites
SET revoked_at = NOW()
WHERE session_id = $1
  AND lower_github_username = sqlc.arg(lower_github_username)::text
  AND revoked_at IS NULL
RETURNING *;

-- ---- Pair session draft (co-compose) ----

-- name: UpsertPairSessionDraft :one
-- Version-gated apply: only advance when the incoming version strictly exceeds
-- the stored version (stale writes are rejected by leaving the row unchanged
-- and returning nothing via the WHERE guard on conflict).
INSERT INTO pair_session_draft (session_id, content, version, updated_by, updated_at)
VALUES (sqlc.arg(session_id)::text, sqlc.arg(content), sqlc.arg(version), sqlc.arg(updated_by), NOW())
ON CONFLICT (session_id) DO UPDATE
SET content = EXCLUDED.content,
    version = EXCLUDED.version,
    updated_by = EXCLUDED.updated_by,
    updated_at = NOW()
WHERE EXCLUDED.version > pair_session_draft.version
RETURNING *;

-- name: GetPairSessionDraft :one
SELECT * FROM pair_session_draft WHERE session_id = $1;

-- name: ClearPairSessionDraft :one
-- Version-gated clear: only clears when the stored version still equals the
-- version read at submit time. A mismatch means a concurrent PutDraft landed
-- between the read and the clear; the UPDATE then matches no row (:one returns
-- no rows) and the caller aborts the submit rather than clobbering that write.
UPDATE pair_session_draft
SET content = '',
    version = version + 1,
    updated_by = sqlc.arg(updated_by),
    updated_at = NOW()
WHERE session_id = $1
  AND version = sqlc.arg(expected_version)
RETURNING *;

-- ---- Pair session links (per-link anyone-with-link slugs, amendment A) ----

-- name: CreatePairSessionLink :one
INSERT INTO pair_session_links (session_id, slug, role, created_by)
VALUES (sqlc.arg(session_id)::text, sqlc.arg(slug)::text, sqlc.arg(role)::text, sqlc.arg(created_by))
RETURNING *;

-- name: GetLivePairSessionLinkBySlug :one
SELECT * FROM pair_session_links
WHERE slug = sqlc.arg(slug)::text
  AND revoked_at IS NULL;

-- name: ListLivePairSessionLinks :many
SELECT * FROM pair_session_links
WHERE session_id = $1
  AND revoked_at IS NULL
ORDER BY created_at ASC;

-- name: RevokePairSessionLink :one
UPDATE pair_session_links
SET revoked_at = NOW()
WHERE id = sqlc.arg(id)
  AND session_id = sqlc.arg(session_id)::text
  AND revoked_at IS NULL
RETURNING *;

-- name: RevokeLivePairSessionLinksForRole :exec
-- Rotating a link: revoke any existing live link of this role before minting a
-- fresh one so the one-live-per-role partial-unique index never collides.
UPDATE pair_session_links
SET revoked_at = NOW()
WHERE session_id = sqlc.arg(session_id)::text
  AND role = sqlc.arg(role)::text
  AND revoked_at IS NULL;

