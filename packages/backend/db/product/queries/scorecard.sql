-- Table presence is necessary but never sufficient for lifecycle coverage.
-- Probe names as data before reading sources: absent relations must not abort
-- the repeatable-read snapshot used by the available measures.
-- name: ScorecardSourceRelations :many
SELECT source.name::text AS name,
       (to_regclass('public.' || source.name) IS NOT NULL
        AND (source.name <> 'mythical_items' OR
             (SELECT count(*) = 2 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'mythical_items'
                AND column_name IN ('owner_id', 'created_by'))))::boolean AS present
FROM unnest(ARRAY['install_settings', 'mythical_items', 'product_job_events',
                 'chat_turns', 'chat_turn_batches', 'burst_files', 'audit_log',
                 'workflow_definitions']) AS source(name);

-- Creation receipts, not row creation times, establish stack acceptance.
-- Deduplicate repeated deliveries by the TODO identity.
-- name: ScorecardTODOs :many
SELECT i.id::text AS id, COALESCE(i.owner_id, i.created_by, 0)::bigint AS owner,
       i.state::text AS state, i.updated_at AS state_at, i.checks, i.paused_at,
       COALESCE(min(e.recorded_at), 'epoch'::timestamptz)::timestamptz AS accepted,
       (count(e.event_id) > 0)::boolean AS covered
FROM mythical_items i
LEFT JOIN product_job_events e ON e.principal_id = 'todo:' || i.id::text
 AND e.event_type = 'todo.created' AND e.data->>'item' = i.id::text
WHERE i.source = 'todo' OR i.checks->>'todo' = 'true'
GROUP BY i.id;
