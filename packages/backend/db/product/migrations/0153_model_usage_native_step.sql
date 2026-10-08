-- T-FLW-07: a native coding host names the engine dispatch each model call
-- ran under ("<execution id>:<step key digest>"), so the monitor prices each
-- step from the metered rows. Legacy rows and other sources leave it NULL.
ALTER TABLE model_usage ADD COLUMN native_step text
    CHECK (length(native_step) <= 321 AND native_step ~ '^[A-Za-z0-9._/@#-]+:[0-9a-f]{64}$');
CREATE INDEX idx_model_usage_native_step ON model_usage (workspace_id, native_step)
    WHERE native_step IS NOT NULL;
