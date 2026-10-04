-- Table presence is necessary but never sufficient for lifecycle coverage.
-- Probe names as data before reading sources: absent relations must not abort
-- the repeatable-read snapshot used by the available measures.
-- name: ScorecardSourceRelations :many
SELECT source.name::text AS name,
       (to_regclass('public.' || source.name) IS NOT NULL)::boolean AS present
FROM unnest(ARRAY['install_settings', 'mythical_items', 'product_job_events',
                 'chat_turns', 'chat_turn_batches', 'burst_files', 'audit_log',
                 'workflow_definitions']) AS source(name);
