-- The daily platform model spend cap sums every owner's calls since 00:00
-- UTC on each platform-key call.
CREATE INDEX idx_model_usage_created_at ON model_usage (created_at);
