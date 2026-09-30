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
-- A re-dispatched session gets a fresh provisioning deadline from its run.
SELECT s.* FROM agent_sessions s
LEFT JOIN workflow_runs wr ON wr.id = s.workflow_run_id
WHERE s.status = 'active' AND s.started_at IS NULL
AND s.deleted_at IS NULL AND COALESCE(wr.created_at, s.created_at) < sqlc.arg(cutoff)::timestamptz
ORDER BY COALESCE(wr.created_at, s.created_at), s.id LIMIT 200;


-- name: FailNeverStartedAgentSessionRaw :one
-- Release an abandoned admission and its unfinished work atomically with the
-- session failure; any failed write leaves the session eligible for retry.
WITH failed_session AS (
    UPDATE agent_sessions s SET status = 'failed', finished_at = now(), updated_at = now(),
    metadata = metadata || '{"failure_reason":"never_started"}'::jsonb
    WHERE s.id = sqlc.arg(id) AND s.status = 'active' AND s.started_at IS NULL
    AND s.workflow_run_id IS NOT DISTINCT FROM sqlc.narg(workflow_run_id)::bigint
    AND s.deleted_at IS NULL AND COALESCE(
        (SELECT wr.created_at FROM workflow_runs wr WHERE wr.id = s.workflow_run_id), s.created_at
    ) < sqlc.arg(cutoff)::timestamptz
    RETURNING s.*
), failed_tasks AS (
    UPDATE workflow_tasks wt
    SET status = 'failed', last_error = 'never_started', finished_at = now(), updated_at = now()
    WHERE wt.workflow_run_id IN (SELECT workflow_run_id FROM failed_session)
      AND wt.status IN ('pending', 'assigned', 'running')
), failed_steps AS (
    UPDATE workflow_steps ws SET status = 'failure', completed_at = now(), updated_at = now()
    WHERE ws.workflow_run_id IN (SELECT workflow_run_id FROM failed_session)
      AND ws.status IN ('queued', 'running')
), failed_run AS (
    UPDATE workflow_runs wr SET status = 'failure', completed_at = now(), updated_at = now()
    WHERE wr.id IN (SELECT workflow_run_id FROM failed_session)
      AND wr.status IN ('queued', 'running')
)
SELECT * FROM failed_session;


-- name: AdminGetUserForErasure :one
-- Unlike GetUserByLowerUsername this also finds a suspended user, so an erase
-- interrupted after suspension can resume.
SELECT * FROM users WHERE lower_username = sqlc.arg(lower_username);


-- name: AdminGetUserForSuspension :one
SELECT * FROM users
WHERE lower_username = sqlc.arg(lower_username)
AND deleted_at IS NULL;


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


-- name: AdminScrubUserPushEvents :execrows
UPDATE repo_push_events SET pusher_login = sqlc.arg(tombstone)::text, updated_at = now()
WHERE pusher_id = sqlc.arg(user_id)::bigint AND pusher_login <> sqlc.arg(tombstone)::text;


-- name: AdminScrubUserWikiRevisions :execrows
UPDATE wiki_page_revisions SET author_username = sqlc.arg(tombstone)::text
WHERE author_id = sqlc.arg(user_id)::bigint AND author_username <> sqlc.arg(tombstone)::text;


-- name: AdminExportProfile :one
-- Account export: the profile the user entered and the keys it signs in with.
SELECT to_jsonb(p)::jsonb AS item FROM (
  SELECT u.id, u.username, u.email, u.display_name, u.bio, u.avatar_url, u.wallet_address, u.created_at,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('name', k.name, 'fingerprint', k.fingerprint, 'public_key', k.public_key, 'created_at', k.created_at) ORDER BY k.id)
      FROM ssh_keys k WHERE k.user_id = u.id), '[]'::jsonb) AS ssh_keys
  FROM users u WHERE u.id = sqlc.arg(user_id)::bigint
) p;


-- name: AdminExportRepositories :one
SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.name), '[]'::jsonb)::jsonb AS items FROM (
  SELECT r.id, r.name, r.description, r.is_public, r.default_bookmark, r.created_at, r.updated_at
  FROM repositories r WHERE r.user_id = sqlc.arg(user_id)::bigint
) x;


-- name: AdminExportIssues :one
-- Issues the user wrote anywhere, and every issue in the user's repositories.
SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb)::jsonb AS items FROM (
  SELECT i.id, COALESCE(ou.username, o.name) || '/' || r.name AS repository, i.number, i.title, i.body, i.state,
    i.author_id = sqlc.arg(user_id)::bigint AS authored, i.created_at, i.updated_at, i.closed_at
  FROM issues i
  JOIN repositories r ON r.id = i.repository_id
  LEFT JOIN users ou ON ou.id = r.user_id
  LEFT JOIN organizations o ON o.id = r.org_id
  WHERE i.author_id = sqlc.arg(user_id)::bigint OR r.user_id = sqlc.arg(user_id)::bigint
) x;


-- name: AdminExportComments :one
-- Comments the user wrote on issues and landing requests.
SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.created_at, x.id), '[]'::jsonb)::jsonb AS items FROM (
  SELECT c.id, 'issue' AS parent, COALESCE(ou.username, o.name) || '/' || r.name AS repository, i.number,
    '' AS path, 0::bigint AS line, c.body, c.created_at, c.updated_at
  FROM issue_comments c
  JOIN issues i ON i.id = c.issue_id
  JOIN repositories r ON r.id = i.repository_id
  LEFT JOIN users ou ON ou.id = r.user_id
  LEFT JOIN organizations o ON o.id = r.org_id
  WHERE c.user_id = sqlc.arg(user_id)::bigint
  UNION ALL
  SELECT c.id, 'landing_request', COALESCE(ou.username, o.name) || '/' || r.name, l.number,
    c.path, c.line, c.body, c.created_at, c.updated_at
  FROM landing_request_comments c
  JOIN landing_requests l ON l.id = c.landing_request_id
  JOIN repositories r ON r.id = l.repository_id
  LEFT JOIN users ou ON ou.id = r.user_id
  LEFT JOIN organizations o ON o.id = r.org_id
  WHERE c.user_id = sqlc.arg(user_id)::bigint
) x;


-- name: AdminExportLandingRequests :one
-- Landing requests the user opened anywhere, and every one in the user's repositories.
SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb)::jsonb AS items FROM (
  SELECT l.id, COALESCE(ou.username, o.name) || '/' || r.name AS repository, l.number, l.title, l.body, l.state,
    l.target_bookmark, l.source_bookmark, l.author_id = sqlc.arg(user_id)::bigint AS authored,
    l.created_at, l.updated_at, l.closed_at, l.merged_at
  FROM landing_requests l
  JOIN repositories r ON r.id = l.repository_id
  LEFT JOIN users ou ON ou.id = r.user_id
  LEFT JOIN organizations o ON o.id = r.org_id
  WHERE l.author_id = sqlc.arg(user_id)::bigint OR r.user_id = sqlc.arg(user_id)::bigint
) x;


-- name: AdminExportRuns :one
-- Run metadata: workflow runs in the user's repositories and the user's
-- agent sessions. Logs and tokens are not part of the metadata.
SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.created_at, x.id), '[]'::jsonb)::jsonb AS items FROM (
  SELECT w.id::text AS id, 'workflow_run' AS kind, r.name AS repository, d.name AS title, w.status::text AS status,
    w.trigger_event::text AS trigger_event, w.trigger_ref::text AS trigger_ref, w.trigger_commit_sha::text AS commit_sha,
    w.created_at, w.started_at, w.completed_at AS finished_at
  FROM workflow_runs w
  JOIN repositories r ON r.id = w.repository_id
  JOIN workflow_definitions d ON d.id = w.workflow_definition_id
  WHERE r.user_id = sqlc.arg(user_id)::bigint
  UNION ALL
  SELECT s.id::text, 'agent_session', COALESCE(ou.username, o.name) || '/' || r.name, s.title::text, s.status::text,
    '', '', '', s.created_at, s.started_at, s.finished_at
  FROM agent_sessions s
  JOIN repositories r ON r.id = s.repository_id
  LEFT JOIN users ou ON ou.id = r.user_id
  LEFT JOIN organizations o ON o.id = r.org_id
  WHERE s.user_id = sqlc.arg(user_id)::bigint AND s.deleted_at IS NULL
) x;
