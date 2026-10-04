-- The install owns parallel now. Preserve a legacy single-repository setting
-- only when no install value exists; never reset a saved request to a default.
INSERT INTO install_settings (key, value)
SELECT 'parallel', to_jsonb(max_parallel)
FROM mythical_stacks
WHERE (SELECT COUNT(*) FROM mythical_stacks) = 1
ON CONFLICT (key) DO NOTHING;
