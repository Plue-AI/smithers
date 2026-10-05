-- Product queries extracted from the transitional Plue source.

-- name: CreateWorkflowDefinition :one
INSERT INTO workflow_definitions (repository_id, name, path, config)
VALUES ($1, $2, $3, $4)
RETURNING *;


-- name: ListTaskStepInfoForRun :many
SELECT wt.id, wt.status, ws.name as step_name
FROM workflow_tasks wt
JOIN workflow_steps ws ON ws.id = wt.workflow_step_id
WHERE wt.workflow_run_id = $1;


-- name: UnblockWorkflowTask :exec
UPDATE workflow_tasks
SET status = 'pending',
    available_at = NOW(),
    updated_at = NOW()
WHERE id = $1
  AND status = 'blocked';


-- name: SkipBlockedWorkflowTask :exec
UPDATE workflow_tasks
SET status = 'skipped',
    finished_at = NOW(),
    updated_at = NOW()
WHERE id = $1
  AND status = 'blocked';


-- name: UpsertWorkflowDefinition :one
INSERT INTO workflow_definitions (repository_id, name, path, config, is_active)
VALUES ($1, $2, $3, $4, TRUE)
ON CONFLICT (repository_id, path) WHERE digest IS NULL
DO UPDATE SET
  name = EXCLUDED.name,
  config = EXCLUDED.config,
  is_active = TRUE,
  updated_at = NOW()
RETURNING *;


-- name: DeactivateWorkflowDefinitionByPath :exec
UPDATE workflow_definitions
SET is_active = FALSE,
    updated_at = NOW()
WHERE repository_id = $1
  AND path = $2
  AND digest IS NULL;


-- name: EnsureWorkflowDefinitionReference :one
INSERT INTO workflow_definitions (repository_id, name, path, config, is_active)
VALUES ($1, $2, $3, $4, FALSE)
ON CONFLICT (repository_id, path) WHERE digest IS NULL
DO UPDATE SET
  updated_at = NOW()
RETURNING *;


-- name: UpsertAgentWorkflowDefinition :one
-- Creates or returns the per-repo agent workflow definition.
-- Uses the legacy UNIQUE(repository_id, path) index for idempotent upserts.
-- The sentinel path '.smithers/agent' identifies agent workflow definitions.
INSERT INTO workflow_definitions (repository_id, name, path, config)
VALUES (sqlc.arg(repository_id), 'Agent', '.smithers/agent', '{"agent": true}'::jsonb)
ON CONFLICT (repository_id, path) WHERE digest IS NULL DO UPDATE SET updated_at = NOW()
RETURNING *;


-- name: GetWorkflowDefinition :one
SELECT *
FROM workflow_definitions
WHERE id = $1
  AND repository_id = $2;


-- name: GetWorkflowDefinitionByPath :one
SELECT *
FROM workflow_definitions
WHERE repository_id = $1
  AND path = $2
  AND digest IS NULL;


-- name: GetWorkflowRun :one
SELECT *
FROM workflow_runs
WHERE id = $1
  AND repository_id = $2;


-- name: GetWorkflowRunByRunID :one
SELECT *
FROM workflow_runs
WHERE id = $1;


-- name: UpdateWorkflowRunCheckRun :one
UPDATE workflow_runs
SET check_run_id = sqlc.arg(check_run_id),
    check_run_url = sqlc.arg(check_run_url),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
RETURNING *;


-- name: ListWorkflowRunsByDefinition :many
SELECT *
FROM workflow_runs
WHERE workflow_definition_id = $1
  AND repository_id = $2
ORDER BY id DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);


-- name: ListWorkflowDefinitionsByRepo :many
-- The legacy definitions; flow versions (digest set) are read by flow_versions.go.
SELECT *
FROM workflow_definitions
WHERE repository_id = $1
  AND digest IS NULL
ORDER BY id DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);


-- name: CreateWorkflowRun :one
-- execution_plane defaults to 'sandbox' when the caller passes an empty string;
-- it is immutable afterwards.
INSERT INTO workflow_runs (repository_id, workflow_definition_id, status, trigger_event, trigger_ref, trigger_commit_sha, dispatch_inputs, execution_plane)
SELECT
    sqlc.arg(repository_id),
    sqlc.arg(workflow_definition_id),
    sqlc.arg(status),
    sqlc.arg(trigger_event),
    sqlc.arg(trigger_ref),
    sqlc.arg(trigger_commit_sha),
    sqlc.arg(dispatch_inputs),
    COALESCE(NULLIF(sqlc.arg(execution_plane)::varchar, ''), 'sandbox')
WHERE EXISTS (
    SELECT 1
    FROM workflow_definitions AS wd
    WHERE wd.id = sqlc.arg(workflow_definition_id)
      AND wd.repository_id = sqlc.arg(repository_id)
)
RETURNING *;


-- name: ListWorkflowRunsByRepo :many
SELECT *
FROM workflow_runs
WHERE repository_id = $1
ORDER BY id DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);


-- name: CreateWorkflowStep :one
INSERT INTO workflow_steps (workflow_run_id, name, position, status)
VALUES ($1, $2, $3, $4)
RETURNING *;


-- name: CreateWorkflowTask :one
INSERT INTO workflow_tasks (workflow_run_id, workflow_step_id, repository_id, status, priority, payload, available_at, vm_id)
SELECT
    sqlc.arg(workflow_run_id),
    sqlc.arg(workflow_step_id),
    sqlc.arg(repository_id),
    sqlc.arg(status),
    sqlc.arg(priority),
    sqlc.arg(payload),
    sqlc.arg(available_at),
    sqlc.arg(vm_id)
WHERE EXISTS (
    SELECT 1
    FROM workflow_steps AS ws
    JOIN workflow_runs AS wr ON wr.id = ws.workflow_run_id
    WHERE ws.id = sqlc.arg(workflow_step_id)
      AND ws.workflow_run_id = sqlc.arg(workflow_run_id)
      AND ws.repository_id = sqlc.arg(repository_id)
      AND wr.repository_id = sqlc.arg(repository_id)
)
RETURNING *;


-- name: MarkWorkflowTaskVMRunning :execrows
UPDATE workflow_tasks
SET status = 'running',
    vm_id = sqlc.arg(vm_id),
    started_at = COALESCE(started_at, NOW()),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND status IN ('pending', 'assigned');


-- name: UpdateWorkflowStepStatusRunning :execrows
UPDATE workflow_steps
SET status = 'running',
    started_at = COALESCE(workflow_steps.started_at, NOW()),
    updated_at = NOW()
WHERE workflow_steps.id = @step_id;


-- name: UpdateWorkflowStepStatusTerminal :execrows
UPDATE workflow_steps
SET status = @status,
    completed_at = NOW(),
    updated_at = NOW()
WHERE workflow_steps.id = @step_id;


-- name: MarkWorkflowTaskTerminalByID :one
UPDATE workflow_tasks
SET status = sqlc.arg(status),
    last_error = sqlc.arg(last_error),
    finished_at = NOW(),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND status IN ('pending', 'assigned', 'running')
  AND sqlc.arg(status) IN ('done', 'failed', 'cancelled')
RETURNING workflow_run_id;


-- name: GetWorkflowTaskByRunID :one
SELECT *
FROM workflow_tasks
WHERE workflow_run_id = $1
ORDER BY id DESC
LIMIT 1;


-- name: UpdateWorkflowRunStatusBasedOnTasks :one
-- Derive aggregate run status from its tasks and update workflow_runs.
-- Returns the new status. Returns no rows if no matching run exists.
WITH task_summary AS (
    SELECT
        workflow_run_id,
        COUNT(*) FILTER (WHERE status IN ('pending', 'assigned', 'running', 'blocked')) AS active,
        COUNT(*) FILTER (WHERE status = 'failed')                            AS failed,
        COUNT(*) FILTER (WHERE status = 'cancelled')                         AS cancelled,
        COUNT(*) FILTER (WHERE status IN ('done', 'skipped'))                AS done,
        COUNT(*)                                                              AS total
    FROM workflow_tasks
    WHERE workflow_run_id = sqlc.arg(workflow_run_id)
    GROUP BY workflow_run_id
),
derived AS (
    SELECT
        CASE
            WHEN active > 0                   THEN 'running'
            WHEN failed > 0                   THEN 'failure'
            WHEN cancelled > 0 AND done = 0   THEN 'cancelled'
            WHEN done = total AND total > 0    THEN 'success'
            ELSE 'failure'
        END AS new_status
    FROM task_summary
),
-- The status trigger in migration 20260718000000 rejects an unmarked queued->running
-- transition for runner/agent runs. This transaction-local, exact-run marker
-- lets this aggregate transition through without allowing a legacy broad
-- UPDATE to claim any other run on the same connection.
status_transition_guard AS MATERIALIZED (
    SELECT set_config(
        'smithers.workflow_run_status_id',
        sqlc.arg(workflow_run_id)::text,
        true
    ) AS workflow_run_id
)
UPDATE workflow_runs wr
SET status       = derived.new_status,
    completed_at = CASE WHEN derived.new_status IN ('success', 'failure', 'cancelled') THEN NOW() ELSE completed_at END,
    started_at   = COALESCE(started_at, NOW()),
    updated_at   = NOW()
FROM derived
CROSS JOIN status_transition_guard
WHERE wr.id = sqlc.arg(workflow_run_id)
RETURNING wr.status;


-- name: NotifyWorkflowRunEvent :exec
SELECT pg_notify(
    'workflow_run_events_' || sqlc.arg(run_id)::bigint::text,
    sqlc.arg(payload)::text
);


-- name: GetWorkflowTask :one
SELECT *
FROM workflow_tasks
WHERE id = sqlc.arg(id)
  AND repository_id = sqlc.arg(repository_id);


-- name: FailWorkflowRun :exec
-- Mark a run failed directly. Used when dispatch failed before any task was
-- created, so UpdateWorkflowRunStatusBasedOnTasks (which derives status from
-- tasks) would otherwise leave the run queued forever.
UPDATE workflow_runs
SET status = 'failure',
    completed_at = NOW(),
    updated_at = NOW()
WHERE id = $1
  AND status NOT IN ('success', 'failure', 'cancelled');


-- name: CancelWorkflowRun :exec
UPDATE workflow_runs
SET status = 'cancelled',
    completed_at = NOW(),
    updated_at = NOW()
WHERE id = $1
  AND status NOT IN ('success', 'failure', 'cancelled');


-- name: ListSupersededWorkflowRuns :many
-- Older non-terminal runs of the same workflow on the same ref, which a newly
-- created run supersedes. Ordered oldest-first so cancellation is deterministic.
SELECT id
FROM workflow_runs
WHERE repository_id = sqlc.arg(repository_id)
  AND workflow_definition_id = sqlc.arg(workflow_definition_id)
  AND trigger_ref = sqlc.arg(trigger_ref)
  AND trigger_event = sqlc.arg(trigger_event)
  AND id < sqlc.arg(newer_run_id)
  AND status IN ('queued', 'running')
ORDER BY id ASC;


-- name: MarkWorkflowRunSuperseded :exec
-- Records WHY a run was cancelled. Guarded on status = 'cancelled' so a run
-- that reached success/failure in the race window between the supersede scan
-- and the cancel is never mislabelled, and on an empty cancel_reason so the
-- first writer wins.
UPDATE workflow_runs
SET cancel_reason = sqlc.arg(cancel_reason),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND status = 'cancelled'
  AND cancel_reason = '';


-- name: CancelWorkflowTasks :exec
UPDATE workflow_tasks
SET status = 'cancelled',
    finished_at = NOW(),
    updated_at = NOW()
WHERE workflow_run_id = $1
  AND status IN ('pending', 'assigned', 'running', 'blocked');


-- name: ResumeWorkflowRun :exec
UPDATE workflow_runs
SET status = 'queued',
    completed_at = NULL,
    updated_at = NOW()
WHERE id = $1
  AND status IN ('cancelled', 'failure');


-- name: ResumeWorkflowTasks :exec
UPDATE workflow_tasks
SET status = 'pending',
    runner_id = NULL,
    assigned_at = NULL,
    started_at = NULL,
    finished_at = NULL,
    last_error = NULL,
    available_at = NOW(),
    updated_at = NOW()
WHERE workflow_run_id = $1
  AND status IN ('cancelled', 'failed');


-- name: ResumeWorkflowSteps :exec
UPDATE workflow_steps
SET status = 'queued',
    started_at = NULL,
    completed_at = NULL,
    updated_at = NOW()
WHERE workflow_run_id = $1
  AND status IN ('cancelled', 'failure');


-- name: CreateCommitStatus :one
INSERT INTO commit_statuses (
    repository_id,
    change_id,
    commit_sha,
    context,
    status,
    description,
    target_url,
    workflow_run_id,
    targets_affected,
    targets_ran,
    targets_cached,
    duration_ms,
    workspace_id
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
RETURNING *;


-- name: UpdateLatestCommitStatusByWorkflowRunID :one
UPDATE commit_statuses
SET status = $2,
    description = $3,
    target_url = $4,
    updated_at = NOW()
WHERE id = (
  SELECT cs.id
  FROM commit_statuses cs
  WHERE cs.workflow_run_id = $1
  ORDER BY cs.id DESC
  LIMIT 1
)
RETURNING *;


-- name: ListCommitStatusesByRef :many
SELECT *
FROM commit_statuses
WHERE repository_id = $1
  AND (change_id = sqlc.arg(ref) OR commit_sha = sqlc.arg(ref))
ORDER BY created_at DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);


-- name: ListCommitStatusesBySHA :many
SELECT *
FROM commit_statuses
WHERE repository_id = $1
  AND commit_sha = $2
ORDER BY created_at DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);


-- name: CountCommitStatusesByRef :one
SELECT COUNT(*)
FROM commit_statuses
WHERE repository_id = $1
  AND (change_id = sqlc.arg(ref) OR commit_sha = sqlc.arg(ref));


-- name: GetLatestCommitStatusBySHA :one
SELECT *
FROM commit_statuses
WHERE repository_id = $1
  AND commit_sha = $2
ORDER BY created_at DESC
LIMIT 1;


-- name: GetLatestCommitStatusesByChangeIDsAndContexts :many
-- Returns the latest commit status per context for a set of change IDs.
-- Used to enforce required status checks before landing.
SELECT DISTINCT ON (cs.context)
    cs.context,
    cs.status,
    cs.created_at
FROM commit_statuses cs
WHERE cs.repository_id = @repository_id
  AND cs.change_id = ANY(@change_ids::text[])
  AND cs.context = ANY(@contexts::text[])
ORDER BY cs.context, cs.created_at DESC;


-- name: ListLatestCommitStatusesByChangeIDsAndContexts :many
-- Returns the latest commit status for each (change, context) pair so landing
-- readiness can explain which row of a stack is blocked.
SELECT DISTINCT ON (cs.change_id, cs.context)
    COALESCE(cs.change_id, '')::text AS change_id,
    cs.context,
    cs.status
FROM commit_statuses cs
WHERE cs.repository_id = sqlc.arg(repository_id)
  AND cs.change_id = ANY(sqlc.arg(change_ids)::text[])
  AND cs.context = ANY(sqlc.arg(contexts)::text[])
ORDER BY cs.change_id, cs.context, cs.created_at DESC, cs.id DESC;


-- name: ListFailingLandingRevisionChecks :many
-- A required context must succeed on EVERY immutable revision in the stack.
-- Missing statuses and success on an older rewrite never authorize landing.
SELECT requested.context::text AS context
FROM jsonb_each_text(sqlc.arg(revisions)::jsonb) AS revision
CROSS JOIN unnest(sqlc.arg(contexts)::text[]) AS requested(context)
LEFT JOIN LATERAL (
    SELECT cs.status
    FROM commit_statuses cs
    WHERE cs.repository_id = sqlc.arg(repository_id)
      AND cs.commit_sha = revision.value
      AND (cs.change_id = revision.key OR cs.change_id IS NULL)
      AND cs.context = requested.context
    ORDER BY cs.created_at DESC, cs.id DESC
    LIMIT 1
) AS latest ON true
GROUP BY requested.context
HAVING NOT bool_and(COALESCE(latest.status = 'success', false))
ORDER BY requested.context;

