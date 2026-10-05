-- Product queries extracted from the transitional Plue source.

-- name: CreateWorkspace :one
INSERT INTO workspaces (
    id,
    source_commit,
    repository_id,
    user_id,
    name,
    is_fork,
    parent_workspace_id,
    target_bookmark,
    source_snapshot_id,
    kind,
    environment_source,
    environment_revision,
    environment_closure_hash,
    status,
    agent_session_id,
    idle_timeout_secs,
    vcpu_count,
    memory_mb,
    disk_mb,
    forked_from_item,
    forked_from_base
)
VALUES (
    COALESCE(sqlc.narg(id)::uuid, gen_random_uuid()),
    sqlc.arg(source_commit)::text,
    $1, $2, $3, $4, $5,
    COALESCE(NULLIF(sqlc.arg(target_bookmark)::text, ''), 'main'),
    $6,
    COALESCE(NULLIF(sqlc.arg(kind)::text, ''), 'container'),
    COALESCE(NULLIF(sqlc.arg(environment_source)::text, ''), '.smithers/environment.nix'),
    sqlc.arg(environment_revision)::text,
    sqlc.arg(environment_closure_hash)::text,
    sqlc.arg(status)::text,
    sqlc.narg(agent_session_id)::uuid,
    COALESCE(sqlc.narg(idle_timeout_secs)::integer, 1800),
    sqlc.narg(vcpu_count)::integer,
    sqlc.narg(memory_mb)::integer,
    sqlc.narg(disk_mb)::integer,
    sqlc.narg(forked_from_item)::uuid,
    sqlc.arg(forked_from_base)::text
)
RETURNING *;


-- name: GetWorkspaceByAgentSession :one
-- RFD-004: the workspace an agent run executes in.
SELECT *
FROM workspaces
WHERE id = (SELECT workspace_id FROM agent_sessions WHERE id = sqlc.arg(agent_session_id)::uuid)
  AND deleted_at IS NULL
LIMIT 1;


-- name: SetWorkspaceHeadPushTokenID :exec
-- RFD-004: records (or clears) the scoped token the guest head reporter
-- pushes with, so suspend/destroy can revoke it.
UPDATE workspaces
SET head_push_token_id = sqlc.narg(head_push_token_id)::bigint,
    updated_at = NOW()
WHERE id = sqlc.arg(id);


-- name: ListRunningWorkspacesForUserRepoBookmark :many
-- RFD-004: fork-source candidates for an agent workspace: the user's running
-- non-agent workspaces on the same bookmark, most recently active first. A
-- workspace checked out from a pushed ref holds unlanded work; it is no source.
SELECT *
FROM workspaces
WHERE repository_id = sqlc.arg(repository_id)
  AND user_id = sqlc.arg(user_id)
  AND target_bookmark = sqlc.arg(target_bookmark)::text
  AND kind <> 'agent'
  AND source_commit = ''
  AND status = 'running'
  AND vm_id <> ''
  AND deleted_at IS NULL
ORDER BY last_activity_at DESC
LIMIT 5;


-- name: GetWorkspace :one
-- Tombstoned workspaces (deleted_at IS NOT NULL) are invisible to passive
-- reads per ticket 0105. Use GetWorkspaceIncludingDeleted for internal
-- reconciliation paths that must see tombstones.
SELECT *
FROM workspaces
WHERE id = $1
  AND deleted_at IS NULL;


-- name: GetWorkspaceIncludingDeleted :one
SELECT *
FROM workspaces
WHERE id = $1;


-- name: GetWorkspaceForUserRepo :one
SELECT *
FROM workspaces
WHERE id = sqlc.arg(id)
  AND repository_id = sqlc.arg(repository_id)
  AND user_id = sqlc.arg(user_id)
  AND deleted_at IS NULL;


-- GetFlowWorkspaceForUserRepo is the box a person's flow calls reach: their
-- own, or a branch machine the install's machine service owns whose only
-- write share is theirs (a TODO's lane). The flow host's lease checks the
-- same predicate under its lock (flowhost/store.go).
-- name: GetFlowWorkspaceForUserRepo :one
SELECT *
FROM workspaces w
WHERE w.id = sqlc.arg(id)
  AND w.repository_id = sqlc.arg(repository_id)
  AND w.deleted_at IS NULL
  AND (w.user_id = sqlc.arg(user_id) OR (
        w.user_id IN (
          SELECT u.id FROM users u WHERE u.lower_username = 'smithers-machines'
            AND u.user_type = 'service' AND u.prohibit_login AND u.deleted_at IS NULL)
        AND EXISTS (
          SELECT 1 FROM workspace_shares s WHERE s.workspace_id = w.id AND s.level = 'write'
            AND s.grantee_user_id = sqlc.arg(user_id))
        AND NOT EXISTS (
          SELECT 1 FROM workspace_shares s WHERE s.workspace_id = w.id AND s.level = 'write'
            AND s.grantee_user_id <> sqlc.arg(user_id))));


-- name: ListWorkspacesByRepo :many
SELECT *
FROM workspaces
WHERE repository_id = sqlc.arg(repository_id)
  AND user_id = sqlc.arg(user_id)
  AND deleted_at IS NULL
ORDER BY created_at DESC
LIMIT sqlc.arg(page_size) OFFSET sqlc.arg(page_offset);


-- name: CountWorkspacesByRepo :one
SELECT COUNT(*)
FROM workspaces
WHERE repository_id = sqlc.arg(repository_id)
  AND user_id = sqlc.arg(user_id)
  AND deleted_at IS NULL;


-- name: CountActiveWorkspacesByUser :one
-- Ticket 0105: per-user quota count. Uses idx_workspaces_user_active
-- (partial WHERE deleted_at IS NULL). Failed workspaces are excluded:
-- a provisioning failure (e.g. a VM that never came up) must not
-- permanently consume quota and drive retries into quota_exceeded. Child
-- workspaces (#2802) have their own plan limit.
SELECT COUNT(*)
FROM workspaces w
WHERE w.user_id = sqlc.arg(user_id)
  AND w.deleted_at IS NULL
  AND w.status <> 'failed'
  AND NOT EXISTS (SELECT 1 FROM workspace_children c WHERE c.workspace_id = w.id);


-- name: GetActiveWorkspaceForUserRepo :one
-- Returns an active primary workspace candidate for flows such as forking.
-- Permanently missing runtimes are retained as failed rows for recovery and
-- excluded here. The service must inspect candidates before reusing them.
SELECT *
FROM workspaces
WHERE repository_id = $1
  AND user_id = $2
  AND is_fork = FALSE
  AND deleted_at IS NULL
  AND (
    status IN ('running', 'suspended')
    OR (status = 'starting' AND vm_id <> '')
  )
ORDER BY last_activity_at DESC
LIMIT 1;


-- name: GetActiveWorkspaceForUserRepoKind :one
-- Returns a primary workspace candidate for source selection, not create reuse.
-- Running/suspended rows still require a runtime liveness check in the service;
-- permanently missing runtimes are retained as failed rows, never deleted.
SELECT *
FROM workspaces
WHERE repository_id = sqlc.arg(repository_id)
  AND user_id = sqlc.arg(user_id)
  AND kind = sqlc.arg(kind)::text
  AND is_fork = FALSE
  AND deleted_at IS NULL
  AND (
    status IN ('running', 'suspended')
    OR (status = 'starting' AND vm_id <> '')
  )
LIMIT 1;


-- name: GetActiveWorkspaceForIdentity :one
-- A bookmark create reuses exactly its name, bookmark, kind, and owner. Pending
-- rows reserve the identity before runtime provisioning starts.
SELECT *
FROM workspaces
WHERE repository_id = sqlc.arg(repository_id)
  AND user_id = sqlc.arg(user_id)
  AND kind = sqlc.arg(kind)::text
  AND name = sqlc.arg(name)::text
  AND target_bookmark = sqlc.arg(target_bookmark)::text
  AND parent_workspace_id IS NULL
  AND source_snapshot_id IS NULL
  AND agent_session_id IS NULL
  AND source_commit = ''
  AND deleted_at IS NULL
  AND status IN ('pending', 'starting', 'running', 'suspended')
LIMIT 1;


-- name: UpdateWorkspaceStatus :one
UPDATE workspaces
SET status = sqlc.arg(status)::text,
    started_at = CASE
        WHEN sqlc.arg(status)::text = 'running' THEN COALESCE(started_at, NOW())
        ELSE started_at
    END,
    suspended_at = CASE
        WHEN sqlc.arg(status)::text = 'suspended' THEN NOW()
        WHEN sqlc.arg(status)::text = 'running' THEN NULL::timestamptz
        ELSE suspended_at
    END,
    updated_at = NOW()
WHERE id = $1
  AND deleted_at IS NULL
RETURNING *;


-- name: FailWorkspaceIfUnchanged :one
-- Stale-cleanup decisions are made from a previously listed row. Fence the
-- failure transition on every execution-bearing field so a provisioner that
-- registered a VM or advanced the row after that read cannot be overwritten.
UPDATE workspaces
SET status = 'failed',
    failure_code = sqlc.arg(failure_code)::text,
    failure_message = sqlc.arg(failure_message)::text,
    updated_at = NOW()
WHERE id = sqlc.arg(id)::uuid
  AND status = sqlc.arg(expected_status)::text
  AND vm_id = sqlc.arg(expected_vm_id)::text
  AND updated_at = sqlc.arg(expected_updated_at)::timestamptz
  AND deleted_at IS NULL
RETURNING *;


-- name: FailProvisioningWorkspaceIfCurrent :one
-- Provisioning error paths may update provisioning_stage (and therefore
-- updated_at) before reporting an error. Bind them to the observed state and
-- VM instead: a concurrently completed running workspace never matches. An
-- attempt that has not registered a VM has no generation identifier, so its
-- original updated_at additionally fences row-reuse ABA.
UPDATE workspaces
SET status = 'failed',
    failure_code = sqlc.arg(failure_code)::text,
    failure_message = sqlc.arg(failure_message)::text,
    updated_at = NOW()
WHERE id = sqlc.arg(id)::uuid
  AND status = sqlc.arg(expected_status)::text
  AND status IN ('pending', 'starting')
  AND vm_id = sqlc.arg(expected_vm_id)::text
  AND (
      sqlc.arg(expected_vm_id)::text <> ''
      OR updated_at = sqlc.arg(expected_updated_at)::timestamptz
  )
  AND deleted_at IS NULL
RETURNING *;


-- name: UpdateWorkspaceProvisioningStage :one
UPDATE workspaces
SET provisioning_stage = sqlc.arg(provisioning_stage)::text,
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND deleted_at IS NULL
RETURNING *;


-- name: SuspendRunningWorkspace :one
-- CAS on the running->suspended transition. Only the caller that actually flips
-- a 'running' row gets it back (a concurrent suspend, or a non-running row such
-- as a 'failed' workspace whose VM was already reclaimed, matches no rows), so
-- the active-VM gauge -1 pairs exactly one-to-one with the +1 recorded when the
-- row entered 'running'.
UPDATE workspaces
SET status = 'suspended',
    suspended_at = NOW(),
    updated_at = NOW()
WHERE id = $1
  AND status = 'running'
  AND deleted_at IS NULL
RETURNING *;


-- name: UpdateWorkspaceTargetBookmark :one
UPDATE workspaces
SET target_bookmark = sqlc.arg(target_bookmark)::text,
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND deleted_at IS NULL
RETURNING *;


-- name: RegisterWorkspaceVM :one
-- Claims an UNCLAIMED row (vm_id = '') for a freshly booted VM. 'failed' is
-- claimable on purpose: find-or-create reuses failed rows, and a concurrent
-- provisioner can mark the row failed between our boot and our claim — in both
-- cases the healthy replacement VM must win, or the row stays failed forever
-- and every subsequent open of the bookmark dies with "store sandbox vm
-- info: no rows in result set".
UPDATE workspaces
SET vm_id = $2,
    status = sqlc.arg(status)::text,
    started_at = CASE
        WHEN sqlc.arg(status)::text = 'running' THEN COALESCE(started_at, NOW())
        ELSE started_at
    END,
    suspended_at = CASE
        WHEN sqlc.arg(status)::text = 'suspended' THEN NOW()
        WHEN sqlc.arg(status)::text = 'running' THEN NULL::timestamptz
        ELSE suspended_at
    END,
    updated_at = NOW()
WHERE id = $1
  AND vm_id = ''
  AND status IN ('pending', 'starting', 'failed')
  AND deleted_at IS NULL
RETURNING *;


-- name: UpdateWorkspaceExecutionInfo :one
UPDATE workspaces
SET vm_id = $2,
    status = sqlc.arg(status)::text,
    started_at = CASE
        WHEN sqlc.arg(status)::text = 'running' THEN COALESCE(started_at, NOW())
        ELSE started_at
    END,
    suspended_at = CASE
        WHEN sqlc.arg(status)::text = 'suspended' THEN NOW()
        WHEN sqlc.arg(status)::text = 'running' THEN NULL::timestamptz
        ELSE suspended_at
    END,
    updated_at = NOW()
WHERE id = $1
  AND deleted_at IS NULL
RETURNING *;


-- name: ResetWorkspaceForReprovision :one
-- Reset a workspace whose VM is gone so a replacement can be created and
-- registered, and open a NEW provisioning generation in the same statement.
--
-- vm_id must be cleared: RegisterWorkspaceVM only binds a replacement while
-- vm_id = '' AND status IN ('pending','starting','failed'), so a row that kept
-- the dead id reads as "already claimed" and the fresh VM is reaped as an
-- orphan. provisioning_generation must advance in the SAME write: it seeds the
-- sandbox Idempotency-Key, and reusing the previous attempt's key with a
-- different request body is a controller 409 idempotency_conflict.
UPDATE workspaces
SET vm_id = '',
    status = 'starting',
    provisioning_generation = provisioning_generation + 1,
    updated_at = NOW()
WHERE id = $1
  AND deleted_at IS NULL
RETURNING *;


-- name: MarkWorkspaceResumed :exec
UPDATE workspaces
SET started_at = COALESCE(started_at, sqlc.arg(resumed_at)::timestamptz),
    resumed_at = sqlc.arg(resumed_at)::timestamptz,
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND status = 'running'
  AND deleted_at IS NULL;


-- name: UpdateWorkspaceHead :one
UPDATE workspaces
SET head_change_id = sqlc.arg(head_change_id)::text,
    head_commit_id = sqlc.arg(head_commit_id)::text,
    ahead = sqlc.arg(ahead)::integer,
    behind = sqlc.arg(behind)::integer,
    last_activity_at = NOW(),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND deleted_at IS NULL
RETURNING *;


-- name: SoftDeleteWorkspace :one
-- Ticket 0105: tombstones a workspace. Sets deleted_at = NOW() and forces
-- status to 'stopped' so that any lingering readers see a terminal state. All
-- active sessions are stopped by trg_workspaces_stop_sessions_on_tombstone in
-- this same transaction. Session creation locks the workspace row first, so a
-- concurrent creator either commits before this update (and the trigger stops
-- it) or observes the tombstone.
UPDATE workspaces
SET deleted_at = COALESCE(deleted_at, NOW()),
    status = 'stopped',
    updated_at = NOW()
WHERE id = $1
RETURNING *;


-- name: UpdateWorkspaceSessionSSHConnectionInfo :one
UPDATE workspace_sessions
SET ssh_connection_info = $2,
    updated_at = NOW()
WHERE id = $1
RETURNING *;

-- ---- Workspace snapshots ----


-- name: CreateWorkspaceSnapshot :one
INSERT INTO workspace_snapshots (
    repository_id,
    user_id,
    workspace_id,
    name,
    snapshot_id
)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;


-- name: GetWorkspaceByRepo :one
-- Loads a workspace by id + repository_id without user scoping.
-- Used by RequireWorkspaceAccess to load the row for ownership/share check.
SELECT *
FROM workspaces
WHERE id = sqlc.arg(id)
  AND repository_id = sqlc.arg(repository_id)
  AND deleted_at IS NULL;


-- name: GetWorkspaceSessionByRepo :one
-- Loads a session by id + repository_id without user scoping.
-- Used by RequireWorkspaceAccess to load the row for ownership/share check.
SELECT *
FROM workspace_sessions
WHERE id = sqlc.arg(id)
  AND repository_id = sqlc.arg(repository_id);


-- name: GetWorkspaceSnapshotByRepo :one
-- Loads a snapshot by id + repository_id without user scoping.
-- Used by RequireWorkspaceAccess to load the row for ownership/share check.
SELECT *
FROM workspace_snapshots
WHERE id = sqlc.arg(id)
  AND repository_id = sqlc.arg(repository_id);


-- name: GetWorkspaceSnapshot :one
SELECT *
FROM workspace_snapshots
WHERE id = $1;


-- name: GetWorkspaceSnapshotForUserRepo :one
SELECT *
FROM workspace_snapshots
WHERE id = sqlc.arg(id)
  AND repository_id = sqlc.arg(repository_id)
  AND user_id = sqlc.arg(user_id);


-- name: ListWorkspaceSnapshotsByRepo :many
SELECT *
FROM workspace_snapshots
WHERE repository_id = sqlc.arg(repository_id)
  AND user_id = sqlc.arg(user_id)
ORDER BY created_at DESC
LIMIT sqlc.arg(page_size) OFFSET sqlc.arg(page_offset);


-- name: CountWorkspaceSnapshotsByRepo :one
SELECT COUNT(*)
FROM workspace_snapshots
WHERE repository_id = sqlc.arg(repository_id)
  AND user_id = sqlc.arg(user_id);


-- name: DeleteWorkspaceSnapshot :exec
DELETE FROM workspace_snapshots
WHERE id = $1;

-- ---- PG NOTIFY ----


-- name: NotifyWorkspaceStatus :exec
-- Notifies SSE listeners of session status changes.
-- Channel: workspace_status_{session_id_no_dashes}
SELECT pg_notify(
    'workspace_status_' || replace(sqlc.arg(session_id)::text, '-', ''),
    sqlc.arg(payload)::text
);

-- ---- Workflow Integration ----


-- name: UpsertWorkspaceWorkflowDefinition :one
-- Creates or returns the per-repo workspace workflow definition.
-- Uses the legacy UNIQUE(repository_id, path) index for idempotent upserts.
INSERT INTO workflow_definitions (repository_id, name, path, config)
VALUES (sqlc.arg(repository_id), 'Workspace', '.smithers/workspace', '{"workspace": true}'::jsonb)
ON CONFLICT (repository_id, path) WHERE digest IS NULL DO UPDATE SET updated_at = NOW()
RETURNING *;

-- ---- Session (PTY) lifecycle ----


-- name: CreateWorkspaceSession :one
WITH live_workspace AS MATERIALIZED (
    SELECT workspace.id
    FROM workspaces AS workspace
    WHERE workspace.id = sqlc.arg(workspace_id)
      AND workspace.repository_id = sqlc.arg(repository_id)
      AND workspace.deleted_at IS NULL
    FOR UPDATE
)
INSERT INTO workspace_sessions (workspace_id, repository_id, user_id, cols, rows)
SELECT live_workspace.id,
       sqlc.arg(repository_id),
       sqlc.arg(user_id),
       sqlc.arg(cols),
       sqlc.arg(rows)
FROM live_workspace
RETURNING *;


-- name: CreateWorkspaceLSPSession :one
-- LSP relay (#505): same live-parent fence as CreateWorkspaceSession, with the
-- session kind, its language, and the 10-minute idle budget the relay enforces.
WITH live_workspace AS MATERIALIZED (
    SELECT workspace.id
    FROM workspaces AS workspace
    WHERE workspace.id = sqlc.arg(workspace_id)
      AND workspace.repository_id = sqlc.arg(repository_id)
      AND workspace.deleted_at IS NULL
    FOR UPDATE
)
INSERT INTO workspace_sessions (workspace_id, repository_id, user_id, cols, rows, kind, language, idle_timeout_secs)
SELECT live_workspace.id,
       sqlc.arg(repository_id),
       sqlc.arg(user_id),
       sqlc.arg(cols),
       sqlc.arg(rows),
       'lsp',
       sqlc.arg(language),
       sqlc.arg(idle_timeout_secs)
FROM live_workspace
RETURNING *;


-- name: GetActiveWorkspaceLSPSession :one
-- The one live language-server session for a workspace and language, if any.
SELECT *
FROM workspace_sessions
WHERE workspace_id = sqlc.arg(workspace_id)
  AND kind = 'lsp'
  AND language = sqlc.arg(language)
  AND status IN ('pending', 'starting', 'running')
ORDER BY created_at DESC
LIMIT 1;


-- name: GetWorkspaceSession :one
SELECT *
FROM workspace_sessions
WHERE id = $1;


-- name: GetWorkspaceSessionForUserRepo :one
SELECT *
FROM workspace_sessions
WHERE id = sqlc.arg(id)
  AND repository_id = sqlc.arg(repository_id)
  AND user_id = sqlc.arg(user_id);


-- name: ListWorkspaceSessionsByRepo :many
SELECT *
FROM workspace_sessions
WHERE repository_id = sqlc.arg(repository_id)
  AND user_id = sqlc.arg(user_id)
ORDER BY created_at DESC
LIMIT sqlc.arg(page_size) OFFSET sqlc.arg(page_offset);


-- name: CountWorkspaceSessionsByRepo :one
SELECT COUNT(*)
FROM workspace_sessions
WHERE repository_id = sqlc.arg(repository_id)
  AND user_id = sqlc.arg(user_id);


-- name: UpdateWorkspaceSessionStatus :one
UPDATE workspace_sessions
SET status = $2, updated_at = NOW()
WHERE id = $1
RETURNING *;


-- name: TouchWorkspaceSessionActivity :exec
UPDATE workspace_sessions
SET last_activity_at = NOW(), updated_at = NOW()
WHERE id = $1;

-- ---- Activity Tracking ----


-- name: TouchWorkspaceActivity :exec
UPDATE workspaces
SET last_activity_at = NOW(), updated_at = NOW()
WHERE id = $1
  AND deleted_at IS NULL;


-- name: TouchWorkspaceLastAccessed :exec
-- Ticket 0136: bumps the switcher-recency signal when the user enters the
-- workspace via a real attach flow (CreateSession, session SSH info, or
-- workspace SSH info). Distinct from last_activity_at, which continues to
-- drive idle/suspend policy. MUST NOT be called from list/detail reads,
-- shape polling, SSE reconnects, or generic prefetches.
UPDATE workspaces
SET last_accessed_at = NOW(), updated_at = NOW()
WHERE id = $1
  AND deleted_at IS NULL;


-- name: ListUserWorkspacesAcrossRepos :many
-- Ticket 0135: cross-repo switcher listing for the current user.
-- Only owner-scoped rows (workspaces.user_id = $1) are returned and repos
-- the user can no longer read are excluded. Readability matches the
-- canonical resolveRepoPermission semantics: owner repo, org-owner,
-- team permission, direct collaborator, or public repo. Tombstoned
-- workspaces (deleted_at IS NOT NULL) are invisible per ticket 0105.
-- Ordering uses COALESCE so the endpoint behaves correctly before and
-- during 0136 rollout.
SELECT
    w.id                            AS workspace_id,
    w.repository_id                 AS repository_id,
    COALESCE(u.username, o.name, '')::text AS repository_owner,
    r.name                          AS repository_name,
    COALESCE(NULLIF(w.name, ''), r.name) AS workspace_title,
    w.status                        AS status,
    w.failure_code                  AS failure_code,
    w.failure_message               AS failure_message,
    w.target_bookmark               AS target_bookmark,
    w.provisioning_stage            AS provisioning_stage,
    w.suspended_at                  AS suspended_at,
    w.kind                          AS kind,
    w.head_change_id                AS head_change_id,
    w.head_commit_id                AS head_commit_id,
    w.ahead                         AS ahead,
    w.behind                        AS behind,
    w.started_at                    AS started_at,
    w.last_accessed_at              AS last_accessed_at,
    w.last_activity_at              AS last_activity_at,
    w.created_at                    AS created_at,
    COALESCE(w.last_accessed_at, w.last_activity_at, w.created_at) AS sort_timestamp
FROM workspaces w
JOIN repositories r ON r.id = w.repository_id
LEFT JOIN users u ON u.id = r.user_id
LEFT JOIN organizations o ON o.id = r.org_id
WHERE w.user_id = sqlc.arg(user_id)::bigint
  AND w.deleted_at IS NULL
  AND (
        (r.user_id IS NOT NULL AND r.user_id = sqlc.arg(user_id)::bigint)
     OR (r.org_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM org_members om
            WHERE om.organization_id = r.org_id
              AND om.user_id = sqlc.arg(user_id)::bigint
              AND om.role = 'owner'
        ))
     OR (r.org_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM team_repos tr
            JOIN teams t ON t.id = tr.team_id
            JOIN team_members tm ON tm.team_id = t.id
            JOIN org_members om
              ON om.organization_id = t.organization_id
             AND om.user_id = tm.user_id
            WHERE tr.repository_id = r.id
              AND tm.user_id = sqlc.arg(user_id)::bigint
              AND t.organization_id = r.org_id
        ))
     OR EXISTS (
            SELECT 1 FROM collaborators c
            WHERE c.repository_id = r.id
              AND c.user_id = sqlc.arg(user_id)::bigint
        )
     OR r.is_public
      )
ORDER BY COALESCE(w.last_accessed_at, w.last_activity_at, w.created_at) DESC, w.id DESC
LIMIT sqlc.arg(page_size) OFFSET sqlc.arg(page_offset);


-- name: CountUserWorkspacesAcrossRepos :one
SELECT COUNT(*)
FROM workspaces w
JOIN repositories r ON r.id = w.repository_id
WHERE w.user_id = sqlc.arg(user_id)::bigint
  AND w.deleted_at IS NULL
  AND (
        (r.user_id IS NOT NULL AND r.user_id = sqlc.arg(user_id)::bigint)
     OR (r.org_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM org_members om
            WHERE om.organization_id = r.org_id
              AND om.user_id = sqlc.arg(user_id)::bigint
              AND om.role = 'owner'
        ))
     OR (r.org_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM team_repos tr
            JOIN teams t ON t.id = tr.team_id
            JOIN team_members tm ON tm.team_id = t.id
            JOIN org_members om
              ON om.organization_id = t.organization_id
             AND om.user_id = tm.user_id
            WHERE tr.repository_id = r.id
              AND tm.user_id = sqlc.arg(user_id)::bigint
              AND t.organization_id = r.org_id
        ))
     OR EXISTS (
            SELECT 1 FROM collaborators c
            WHERE c.repository_id = r.id
              AND c.user_id = sqlc.arg(user_id)::bigint
        )
     OR r.is_public
      );


-- name: ListPendingSessionsForWorkspace :many
SELECT *
FROM workspace_sessions
WHERE workspace_id = $1
  AND status IN ('pending', 'starting');

-- ---- Workspace Sharing ----


-- name: GetWorkspaceShare :one
-- Returns the sharing grant for a specific workspace+grantee pair.
-- Returns pgx.ErrNoRows if no explicit share exists.
SELECT *
FROM workspace_shares
WHERE workspace_id = sqlc.arg(workspace_id)::uuid
  AND grantee_user_id = sqlc.arg(grantee_user_id)::bigint;


-- name: UpsertWorkspaceShare :one
-- Grants (or updates the level of) a workspace share so a grantee passes
-- requireWorkspaceAccess on a shared workspace. Idempotent on
-- (workspace_id, grantee_user_id) — re-granting only adjusts the level, which is
-- how persisted read/write grants track member roles.
INSERT INTO workspace_shares (workspace_id, owner_user_id, grantee_user_id, level)
VALUES (
    sqlc.arg(workspace_id)::uuid,
    sqlc.arg(owner_user_id)::bigint,
    sqlc.arg(grantee_user_id)::bigint,
    sqlc.arg(level)::varchar
)
ON CONFLICT (workspace_id, grantee_user_id)
DO UPDATE SET level = EXCLUDED.level
RETURNING *;


-- name: DeleteWorkspaceShare :exec
-- Revokes a single grantee's share on a workspace (member revoke). A no-op when
-- no share exists.
DELETE FROM workspace_shares
WHERE workspace_id = sqlc.arg(workspace_id)::uuid
  AND grantee_user_id = sqlc.arg(grantee_user_id)::bigint;


-- name: DeleteWorkspaceSharesForWorkspace :exec
-- Revokes every share on a workspace (session end). The forked session workspace
-- is single-purpose, so clearing all its shares cleanly de-authorizes members.
DELETE FROM workspace_shares
WHERE workspace_id = sqlc.arg(workspace_id)::uuid;

-- ---- Idle Tracking ----


-- name: CountActiveSessionsForWorkspace :one
SELECT COUNT(*)
FROM workspace_sessions
WHERE workspace_id = $1
  AND status IN ('pending', 'starting', 'running');


-- name: CountActiveSessionsForUser :one
SELECT COUNT(*)
FROM workspace_sessions
WHERE user_id = $1
  AND status IN ('pending', 'starting', 'running');


-- name: ListStalePendingWorkspaces :many
-- Finds pending/starting workspaces with no VM assignment that have been stale past the threshold.
SELECT *
FROM workspaces
WHERE status IN ('pending', 'starting')
  AND vm_id = ''
  AND deleted_at IS NULL
  AND updated_at < NOW() - make_interval(secs => sqlc.arg(stale_after_secs)::int)
ORDER BY updated_at ASC;


-- name: ListIdleWorkspaceSessions :many
-- Finds sessions with status=running whose last_activity_at > idle_timeout_secs ago.
SELECT s.*
FROM workspace_sessions s
WHERE s.status = 'running'
  AND NOW() > s.last_activity_at + make_interval(secs => s.idle_timeout_secs);


-- name: GetRepoOwnerSlugAndNameByID :one
-- RFD-004: the owner slug + repository name a workspace's guest head
-- reporter needs to address the repository over git smart HTTP and the API.
SELECT r.name AS repo_name,
       COALESCE(o.name, u.username, '')::text AS owner_slug
FROM repositories r
LEFT JOIN users u ON u.id = r.user_id
LEFT JOIN organizations o ON o.id = r.org_id
WHERE r.id = sqlc.arg(repository_id);


-- name: SetWorkspaceEnvironmentImage :exec
-- Records the resolved NixOS environment (kind vm/desktop) a workspace boots from.
UPDATE workspaces
SET environment_revision = sqlc.arg(environment_revision)::text,
    environment_closure_hash = sqlc.arg(environment_closure_hash)::text,
    environment_image = sqlc.arg(environment_image)::text,
    updated_at = NOW()
WHERE id = $1;


-- name: SetWorkspaceDesktopSession :exec
-- Replaces the desktop stream session. Only the token's SHA-256 is stored.
UPDATE workspaces
SET desktop_session_id = sqlc.arg(desktop_session_id)::text,
    desktop_session_token_hash = sqlc.arg(desktop_session_token_hash)::text,
    desktop_session_expires_at = sqlc.narg(desktop_session_expires_at)::timestamptz,
    updated_at = NOW()
WHERE id = $1;


-- name: StopWorkspaceRetainingRow :one
-- Stop the retained workspace and its live sessions atomically. The owner has
-- already been checked by WorkspaceService. Deletion remains a separate action.
WITH stopped AS (
    UPDATE workspaces w SET status = 'stopped', updated_at = now()
    WHERE w.id = $1 AND w.deleted_at IS NULL
    RETURNING w.*
), stopped_sessions AS (
    UPDATE workspace_sessions s SET status = 'stopped', updated_at = now()
    WHERE s.workspace_id IN (SELECT stopped.id FROM stopped)
      AND s.status IN ('pending', 'starting', 'running')
)
SELECT * FROM stopped;


-- name: SetWorkspaceIdleTimeout :one
UPDATE workspaces
SET idle_timeout_secs = sqlc.arg(idle_timeout_secs), updated_at = NOW()
WHERE id = sqlc.arg(id) AND deleted_at IS NULL
RETURNING *;

-- name: ListRunningWorkspaces :many
-- Daily runtime limits apply even while a workspace or its sessions are active.
SELECT * FROM workspaces
WHERE status = 'running' AND deleted_at IS NULL
ORDER BY user_id, id;

-- name: ListIdleWorkspaces :many
-- Finds workspaces with status=running whose last_activity_at > idle_timeout_secs ago.
-- Excludes workspaces that still have a LIVE (non-idle) running session: terminal
-- WebSocket traffic bumps only the session's last_activity_at (not the
-- workspace's), so without this exclusion the idle sweeper would suspend a VM out
-- from under an actively-used terminal.
SELECT w.*
FROM workspaces w
WHERE w.status = 'running'
  AND w.deleted_at IS NULL
  AND w.idle_timeout_secs > 0
  AND NOW() > w.last_activity_at + make_interval(secs => w.idle_timeout_secs)
  AND NOT EXISTS (
    SELECT 1
    FROM workspace_sessions s
    WHERE s.workspace_id = w.id
      AND s.status IN ('pending', 'starting', 'running')
      AND NOW() <= s.last_activity_at + make_interval(secs => s.idle_timeout_secs)
  );


-- name: SuspendRunningWorkspaceIfSessionless :one
-- CAS from running to suspended while the workspace has no active session.
-- The NOT EXISTS gate runs in the same statement as the status flip, so a
-- session created concurrently with a last-session destroy is never stranded
-- on a workspace this call suspends. Hosted deploymentdb adds a gateway fence.
UPDATE workspaces w
SET status = 'suspended',
    suspended_at = NOW(),
    updated_at = NOW()
WHERE w.id = $1
  AND w.status = 'running'
  AND w.deleted_at IS NULL
  AND NOT EXISTS (
      SELECT 1
      FROM workspace_sessions s
      WHERE s.workspace_id = w.id
        AND s.status IN ('pending', 'starting', 'running')
  )
RETURNING w.*;

-- name: ResumeWorkspaceToRunning :one
-- CAS into running from any non-running, non-deleted state. Exactly one of N
-- concurrent resumes wins, so the active-VM gauge +1 pairs one-to-one with the
-- row entering running.
UPDATE workspaces
SET status = 'running',
    suspended_at = NULL,
    updated_at = NOW()
WHERE id = $1
  AND status <> 'running'
  AND deleted_at IS NULL
RETURNING *;

-- name: ListStaleStartingWorkspacesWithVM :many
-- Workspaces stranded in 'starting' with a registered VM past the threshold,
-- the rows a mid-provision API crash leaves behind. ListStalePendingWorkspaces
-- requires vm_id = '', so no other reaper sees these rows.
SELECT *
FROM workspaces
WHERE status = 'starting'
  AND vm_id <> ''
  AND deleted_at IS NULL
  AND updated_at < NOW() - make_interval(secs => sqlc.arg(stale_after_secs)::int)
ORDER BY updated_at ASC;

-- name: FailStaleStartingWorkspace :one
-- CAS a stranded 'starting' workspace to 'failed', re-checking staleness in the
-- same statement so a provision that completed after the reaper listed it is
-- left untouched.
UPDATE workspaces
SET status = 'failed',
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND status = 'starting'
  AND deleted_at IS NULL
  AND updated_at < NOW() - make_interval(secs => sqlc.arg(stale_after_secs)::int)
RETURNING *;

-- name: SetWorkspaceClientLease :one
-- #2457: starts or clears a workspace's client lease. A NULL lease clears it.
-- updated_at is left alone: stale-provision reapers read it.
UPDATE workspaces
SET client_lease_secs = sqlc.narg(lease_secs)::integer,
    client_lease_expires_at = NOW() + make_interval(secs => sqlc.narg(lease_secs)::integer)
WHERE id = sqlc.arg(id) AND deleted_at IS NULL
RETURNING *;

-- name: RenewWorkspaceClientLease :one
-- #2457: extends a leased workspace by its own lease length.
UPDATE workspaces
SET client_lease_expires_at = NOW() + make_interval(secs => client_lease_secs)
WHERE id = $1 AND deleted_at IS NULL AND client_lease_secs IS NOT NULL
RETURNING *;

-- name: ListLapsedLeaseWorkspaces :many
-- #2457: workspaces whose client stopped renewing, oldest lapse first.
-- Leaseless workspaces have a NULL expiry and never match.
SELECT *
FROM workspaces
WHERE client_lease_expires_at < NOW()
  AND deleted_at IS NULL
ORDER BY client_lease_expires_at ASC
LIMIT sqlc.arg(max_rows)::integer;

-- name: GetBranchWorkspace :one
-- Includes excluded-index sources and retained failures; none permit replacement.
SELECT * FROM workspaces
WHERE repository_id = sqlc.arg(repository_id)
  AND target_bookmark = sqlc.arg(target_bookmark)::text
  AND deleted_at IS NULL
FOR UPDATE;

-- name: GetBranchMachineOwner :one
SELECT id FROM users WHERE lower_username = 'smithers-machines'
  AND user_type = 'service' AND prohibit_login AND deleted_at IS NULL;
