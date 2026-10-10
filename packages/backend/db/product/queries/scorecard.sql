-- Table presence is necessary but never sufficient for lifecycle coverage.
-- Probe names as data before reading sources: absent relations must not abort
-- the repeatable-read snapshot used by the available measures.
-- name: ScorecardSourceRelations :many
SELECT source.name::text AS name,
       (to_regclass('public.' || source.name) IS NOT NULL
        AND (source.name <> 'mythical_items' OR
             (SELECT count(*) = 2 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'mythical_items'
                AND column_name IN ('owner_id', 'created_by')))
        AND (source.name <> 'approvals' OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='approvals' AND column_name='member_id'))
        AND (source.name <> 'chat_turns' OR EXISTS(
             SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND table_name = 'chat_turns' AND column_name = 'conversation_id'))
        AND (source.name <> 'workflow_definitions' OR EXISTS(
             SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND table_name = 'workflow_definitions' AND column_name = 'digest')))::boolean AS present
FROM unnest(ARRAY['install_settings', 'mythical_items', 'product_job_events',
                 'chat_turns', 'chat_turn_batches', 'burst_files', 'audit_log',
                 'workflow_definitions', 'flow_loads', 'memory_notes', 'approvals']) AS source(name);

-- Creation receipts, not row creation times, establish stack acceptance.
-- Deduplicate repeated deliveries by the TODO identity.
-- name: ScorecardTODOs :many
SELECT i.repository_id::text AS repository_id, i.id::text AS id, COALESCE(i.owner_id, i.created_by, 0)::bigint AS owner,
       i.state::text AS state, i.checks, i.paused_at,
       (SELECT COALESCE(jsonb_object_agg(receipt.state, receipt.since), '{}'::jsonb)
        FROM (SELECT DISTINCT ON (transition.state) transition.state, transition.recorded_at AS since
          FROM (SELECT state, recorded_at, sequence, lag(state) OVER (ORDER BY sequence) AS previous
            FROM product_job_events WHERE tenant_id = i.repository_id::text
              AND principal_id = 'todo:' || i.id::text AND event_type LIKE 'todo.%') AS transition
          WHERE transition.previous IS DISTINCT FROM transition.state
          ORDER BY transition.state, transition.sequence DESC) AS receipt)::jsonb AS state_times,
       COALESCE(min(e.recorded_at), 'epoch'::timestamptz)::timestamptz AS accepted,
       (count(e.event_id) > 0)::boolean AS covered
FROM mythical_items i
LEFT JOIN product_job_events e ON e.tenant_id = i.repository_id::text
 AND e.principal_id = 'todo:' || i.id::text
 AND e.event_type = 'todo.created' AND e.data->>'item' = i.id::text
WHERE i.source = 'todo' OR i.checks->>'todo' = 'true'
GROUP BY i.id;

-- The shared app journal's first persisted answer text. Frames are data:
-- malformed arrays and reasoning/tool frames cannot count as an answer.
-- name: ScorecardFirstAnswer :one
SELECT COALESCE(min(b.created_at), 'epoch'::timestamptz)::timestamptz AS answered_at,
       (count(*) > 0)::boolean AS covered
FROM chat_turns t JOIN chat_turn_batches b ON b.turn_id = t.id
WHERE t.repository_id > 0 AND t.conversation_id IS NOT NULL AND t.conversation_id <> ''
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(
   CASE WHEN jsonb_typeof(b.frames) = 'array' THEN b.frames ELSE '[]'::jsonb END
 ) AS f(frame) WHERE frame->>'type' = 'delta' AND frame->>'kind' = 'text'
   AND jsonb_typeof(frame->'text') = 'string' AND frame->>'text' <> '');

-- Merge settlement is covered independently from the missing main-commit
-- inventory. Both app merges and direct GitHub merges settle through this
-- existing synced-store writer; repeated delivery is not another merge.
-- name: ScorecardMergeCoverage :one
SELECT (count(*) > 0 AND bool_and(COALESCE(
  receipt.event_type = 'todo.github_merged' AND receipt.data->>'source' = 'github', false)))::boolean AS covered
FROM mythical_items i
LEFT JOIN LATERAL (
  SELECT transition.event_type, transition.data
  FROM (SELECT event_type, data, state, sequence,
          lag(state) OVER (ORDER BY sequence) AS previous
        FROM product_job_events WHERE tenant_id = i.repository_id::text
          AND principal_id = 'todo:' || i.id::text AND event_type LIKE 'todo.%') AS transition
  WHERE transition.state = 'merged' AND transition.previous IS DISTINCT FROM transition.state
  ORDER BY transition.sequence DESC LIMIT 1
) AS receipt ON true
WHERE i.state = 'landed' AND (i.source = 'todo' OR i.checks->>'todo' = 'true');

-- T-COL-06's completed continuous visits. Keep metadata as data: parsing in
-- the reader lets malformed legacy receipts fail coverage without aborting
-- the snapshot. An audit row is the session identity, not a socket identity.
-- name: ScorecardPresence :many
SELECT id::text AS id, actor_id, target_name, metadata
FROM audit_log
WHERE event_type = 'presence' AND target_type = 'branch' AND action = 'visit';

-- Immutable setup initialization receipt; never install_settings.updated_at.
-- name: ScorecardInstallStart :many
SELECT value FROM install_settings WHERE key = 'setup.started_at';

-- One logical burst, independent of file count or delivery count. The host
-- writer binds actor and source_key; absent file receipts leave coverage missing.
-- name: ScorecardBursts :many
SELECT e.data, e.recorded_at,
       e.tenant_id, e.principal_id,
       EXISTS(SELECT 1 FROM burst_files f WHERE f.event_id=e.event_id)::boolean AS files_present
FROM product_job_events e
WHERE e.event_type='branch.burst';

-- The optional TODO association cannot hide terminal activity when stack
-- sources are absent. It is required only for TODO-based diagnostics.
-- name: ScorecardBurstTODOs :many
SELECT id::text AS id, repository_id::text AS tenant_id, workspace_id
FROM mythical_items WHERE workspace_id <> '' AND (source='todo' OR checks->>'todo'='true');

-- Accepted learning notes are bound to the repository and TODO created by
-- the existing learning accept writer. Provenance remains quoted JSON data.
-- name: ScorecardLearnings :many
SELECT n.id, n.provenance_json, n.status_at_ms,
       i.id::text AS todo_id, i.repository_id,
       (u.username || '/' || r.name)::text AS repository
FROM memory_notes n
JOIN mythical_items i ON n.accepted_todo = i.number::text
 AND n.namespace_id = 'learning:' || i.repository_id::text
JOIN repositories r ON r.id=i.repository_id
JOIN users u ON u.id=r.user_id
WHERE n.namespace_kind='flow' AND n.status='accepted';

-- The existing answer writer records the confirming person on the event and
-- keeps the settled wait in checks. Pair those receipts; delivery IDs are not
-- action identities and delegated sponsorship is not person participation.
-- name: ScorecardAnswers :many
SELECT i.id::text AS todo_id, i.checks, e.data
FROM mythical_items i JOIN product_job_events e
 ON e.tenant_id=i.repository_id::text AND e.principal_id='todo:' || i.id::text
 AND e.data->>'item'=i.id::text
WHERE e.event_type='todo.answered';

-- Review sessions retain their own confirmation identity. The requester may
-- be delegated; only the successful confirming person is participation.
-- name: ScorecardReviews :many
SELECT a.id::text AS id, COALESCE(i.id::text, '')::text AS todo_id,
       a.member_id, a.state, a.created_at, a.decided_at, a.decided_by,
       COALESCE(a.decision_credential, '')::text AS decision_credential
FROM approvals a LEFT JOIN mythical_items i ON i.repository_id=a.repository_id
 AND a.subject->>'kind'='todo' AND a.subject->>'ref'='T'||i.number::text
 AND (i.source='todo' OR i.checks->>'todo'='true')
WHERE a.member_id IS NOT NULL AND a.kind='review_merge' AND a.command='merge';

-- T-FLW-03's flow-load writes one workflow_definitions row per loaded digest
-- and activates it in the same transaction, so a version that became Active
-- is dated by its load. Only Active rows ever change updated_at: a version
-- Active now, or moved off Active later, was activated; a stale load's row
-- that never became Active keeps is_active false and updated_at = created_at.
-- A revert to a version that already has a row writes no new version.
-- name: ScorecardFlowRevisions :many
SELECT id::text AS id, created_at
FROM workflow_definitions
WHERE digest IS NOT NULL AND status = 'loaded'
  AND (is_active OR updated_at <> created_at);

-- A finished flow-load proves the version writer runs on this install; an
-- empty workflow_definitions table alone does not.
-- name: ScorecardFlowLoadCoverage :one
SELECT (count(*) > 0 AND bool_and(loaded_commit <> ''))::boolean AS covered
FROM flow_loads;
