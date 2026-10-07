-- The sync's reset journal shares its existing per-repository receipt. It is
-- not another attention or status store. The stack owns attention/projections.
ALTER TABLE github_main_pulls ADD COLUMN reset_intent jsonb
    CHECK (reset_intent IS NULL OR (
        jsonb_typeof(reset_intent) = 'object'
        AND reset_intent ?& ARRAY['repository_id', 'id', 'old', 'new']
        AND reset_intent->>'id' <> ''
        AND reset_intent->>'old' ~ '^[0-9a-f]{40}$'
        AND reset_intent->>'new' ~ '^[0-9a-f]{40}$'
        AND reset_intent->>'old' <> reset_intent->>'new'
    ));
