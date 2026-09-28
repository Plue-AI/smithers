-- Product queries extracted from the transitional Plue source.

-- name: AdminListAgentSessions :many
SELECT sqlc.embed(s), u.username AS username,
       (COALESCE(ru.username, o.name, '') || '/' || r.name)::text AS repository
FROM agent_sessions s JOIN users u ON u.id = s.user_id
JOIN repositories r ON r.id = s.repository_id
LEFT JOIN users ru ON ru.id = r.user_id LEFT JOIN organizations o ON o.id = r.org_id
WHERE s.deleted_at IS NULL AND (sqlc.arg(status)::text = 'all' OR s.status = sqlc.arg(status))
AND (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic)
ORDER BY s.created_at DESC, s.id DESC LIMIT sqlc.arg(row_limit)::int;


-- name: AdminListWorkspaces :many
SELECT sqlc.embed(w), u.username AS owner,
       (COALESCE(ru.username, o.name, '') || '/' || r.name)::text AS repository
FROM workspaces w JOIN users u ON u.id = w.user_id
JOIN repositories r ON r.id = w.repository_id
LEFT JOIN users ru ON ru.id = r.user_id LEFT JOIN organizations o ON o.id = r.org_id
WHERE w.deleted_at IS NULL
AND (sqlc.arg(status)::text = '' OR w.status = sqlc.arg(status))
AND (sqlc.arg(kind)::text = '' OR w.kind = sqlc.arg(kind))
AND (sqlc.arg(owner)::text = '' OR u.lower_username = lower(sqlc.arg(owner)))
AND (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic)
ORDER BY w.created_at DESC, w.id DESC LIMIT sqlc.arg(row_limit)::int;


-- name: AdminListTokens :many
SELECT t.id, t.name, u.username, t.scopes, t.last_used_at, t.expires_at, t.created_at
FROM access_tokens t JOIN users u ON u.id = t.user_id
WHERE (sqlc.arg(unused_days)::int = 0 OR COALESCE(t.last_used_at, t.created_at) < now() - make_interval(days => sqlc.arg(unused_days)::int))
AND (sqlc.arg(scope)::text = '' OR sqlc.arg(scope) = ANY(regexp_split_to_array(t.scopes, '[,[:space:]]+')))
AND (sqlc.arg(expiring_days)::int = 0 OR (t.expires_at >= now() AND t.expires_at <= now() + make_interval(days => sqlc.arg(expiring_days)::int)))
ORDER BY t.created_at DESC, t.id DESC LIMIT sqlc.arg(row_limit)::int;


-- name: ListNeverStartedAgentSessions :many
SELECT * FROM agent_sessions WHERE status = 'active' AND started_at IS NULL
AND deleted_at IS NULL AND created_at < sqlc.arg(cutoff)::timestamptz
ORDER BY created_at, id LIMIT 200;


-- name: FailNeverStartedAgentSession :one
UPDATE agent_sessions SET status = 'failed', finished_at = now(), updated_at = now(),
metadata = metadata || '{"failure_reason":"never_started"}'::jsonb
WHERE id = sqlc.arg(id) AND status = 'active' AND started_at IS NULL
AND deleted_at IS NULL AND created_at < sqlc.arg(cutoff)::timestamptz
RETURNING *;


-- name: AdminGetUserForErasure :one
-- Unlike GetUserByLowerUsername this also finds a suspended user, so an erase
-- interrupted after suspension can resume.
SELECT * FROM users WHERE lower_username = sqlc.arg(lower_username);


-- name: AdminFindErasedUser :one
-- The newest tombstone for a username whose account existed before the
-- deletion request, so a retry never resolves to a later holder of the name.
SELECT * FROM users
WHERE lower_username LIKE sqlc.arg(tombstone_prefix)::text || '%'
AND deleted_at IS NOT NULL AND NOT is_active
AND created_at < sqlc.arg(created_before)::timestamptz
ORDER BY id DESC LIMIT 1;


-- name: AdminBlockUserLoginForErasure :execrows
-- Blocks sign-in and every authenticated request (middleware checks
-- prohibit_login) while the erase tears down owned resources; the account
-- stays active so repository services still resolve it. The final sweep
-- deletes its sessions.
UPDATE users SET prohibit_login = true, updated_at = now()
WHERE id = sqlc.arg(user_id)::bigint AND NOT prohibit_login;


-- name: AdminListErasureWorkspaces :many
-- Live workspaces owned by the user or running inside the user's repositories.
SELECT w.id, w.repository_id, w.user_id FROM workspaces w
WHERE w.deleted_at IS NULL
AND (w.user_id = sqlc.arg(user_id)::bigint OR w.repository_id IN (SELECT r.id FROM repositories r WHERE r.user_id = sqlc.arg(user_id)::bigint))
ORDER BY w.created_at, w.id;


-- name: AdminListErasureSnapshots :many
-- Stored snapshots owned by the user or kept inside the user's repositories.
SELECT s.id, s.repository_id, s.user_id FROM workspace_snapshots s
WHERE s.user_id = sqlc.arg(user_id)::bigint OR s.repository_id IN (SELECT r.id FROM repositories r WHERE r.user_id = sqlc.arg(user_id)::bigint)
ORDER BY s.created_at, s.id;


-- name: AdminListUserRepositories :many
SELECT id, name FROM repositories WHERE user_id = sqlc.arg(user_id)::bigint ORDER BY id;


-- name: AdminCountUserLiveResources :one
SELECT
  (SELECT count(*) FROM repositories r WHERE r.user_id = sqlc.arg(user_id)::bigint)::bigint AS repositories,
  (SELECT count(*) FROM workspaces w WHERE w.user_id = sqlc.arg(user_id)::bigint AND w.deleted_at IS NULL)::bigint AS workspaces;


-- name: AdminTombstoneUser :execrows
UPDATE users SET
  username = sqlc.arg(tombstone)::text, lower_username = sqlc.arg(tombstone)::text,
  email = NULL, lower_email = NULL, display_name = 'Deleted user', bio = '',
  avatar_url = '', wallet_address = NULL, is_active = false, is_admin = false,
  prohibit_login = true, email_notifications_enabled = false, last_login_at = NULL,
  deleted_at = COALESCE(deleted_at, now()), updated_at = now()
WHERE id = sqlc.arg(user_id)::bigint;


-- name: AdminListUserCascadeReferences :many
-- Every single-column foreign key that deletes its row with the user: the
-- data the schema declares the user owns.
SELECT c.conrelid::regclass::text AS table_name, a.attname::text AS column_name
FROM pg_catalog.pg_constraint c
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
WHERE c.contype = 'f' AND c.confrelid = 'public.users'::regclass
AND c.confdeltype = 'c' AND cardinality(c.conkey) = 1
ORDER BY 1, 2;


-- name: AdminDeleteUserChatTurns :execrows
DELETE FROM chat_turns WHERE user_id = sqlc.arg(user_id)::bigint OR repository_id = ANY(sqlc.arg(repository_ids)::bigint[]);


-- name: AdminDeleteUserNotificationFacts :execrows
DELETE FROM notification_facts WHERE user_id = sqlc.arg(user_id)::bigint;


-- name: AdminDeleteUserIssueStateFacts :execrows
DELETE FROM issue_state_facts WHERE audience_user_id = sqlc.arg(user_id)::bigint;


-- name: AdminScrubUserAuditActor :execrows
UPDATE audit_log SET actor_name = sqlc.arg(tombstone)::text
WHERE actor_id = sqlc.arg(user_id)::bigint AND actor_name <> sqlc.arg(tombstone)::text;


-- name: AdminScrubUserAuditTarget :execrows
UPDATE audit_log SET target_name = sqlc.arg(tombstone)::text
WHERE target_type = 'user' AND target_id = sqlc.arg(user_id)::bigint AND target_name <> sqlc.arg(tombstone)::text;


-- name: AdminScrubUserAuditDetail :execrows
-- Retained audit rows keep their ids, event types and timestamps; the
-- metadata (usernames, emails) and the user's own address go. Erase receipts
-- carry only the operator and request date and are kept whole.
UPDATE audit_log SET
  metadata = '{}'::jsonb,
  ip_address = CASE WHEN actor_id = sqlc.arg(user_id)::bigint THEN '' ELSE ip_address END
WHERE (actor_id = sqlc.arg(user_id)::bigint OR (target_type = 'user' AND target_id = sqlc.arg(user_id)::bigint))
AND event_type NOT LIKE 'admin.user.erase%'
AND (metadata <> '{}'::jsonb OR (actor_id = sqlc.arg(user_id)::bigint AND ip_address <> ''));


-- name: AdminScrubUserBillingIdentity :execrows
-- Billing accounts stay for tax and invoices; the Stripe customer id is the
-- key, the cached name and email are identity.
UPDATE billing_accounts SET stripe_customer_email = '', stripe_customer_name = '', updated_at = now()
WHERE owner_type = 'user' AND owner_id = sqlc.arg(user_id)::bigint
AND (stripe_customer_email <> '' OR stripe_customer_name <> '');


-- name: AdminDeleteUserWaitlistEntries :execrows
DELETE FROM alpha_waitlist_entries WHERE lower_email = sqlc.arg(lower_email)::text;


-- name: AdminScrubUserPushEvents :execrows
UPDATE repo_push_events SET pusher_login = sqlc.arg(tombstone)::text, updated_at = now()
WHERE pusher_id = sqlc.arg(user_id)::bigint AND pusher_login <> sqlc.arg(tombstone)::text;


-- name: AdminScrubUserWikiRevisions :execrows
UPDATE wiki_page_revisions SET author_username = sqlc.arg(tombstone)::text
WHERE author_id = sqlc.arg(user_id)::bigint AND author_username <> sqlc.arg(tombstone)::text;
