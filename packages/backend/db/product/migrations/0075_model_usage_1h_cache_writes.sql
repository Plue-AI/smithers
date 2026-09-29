-- The part of cache_write_tokens written to Anthropic's 1-hour cache, which
-- is priced above 5-minute writes; with it a row reproduces its cost_nanos.
ALTER TABLE model_usage
    ADD COLUMN cache_write_1h_tokens bigint NOT NULL DEFAULT 0,
    ADD CONSTRAINT model_usage_cache_write_1h_tokens_check
        CHECK (cache_write_1h_tokens >= 0 AND cache_write_1h_tokens <= cache_write_tokens);
