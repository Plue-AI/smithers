-- The token ceiling a call's credit reservation was priced at (prompt plus
-- output). A call whose usage the provider never reported (pending after a
-- crash, or unknown) is charged at its bound and counts these tokens toward
-- the repository's daily factory budget. Rows from before this column count
-- zero, as they did.
ALTER TABLE model_usage
    ADD COLUMN bound_tokens bigint NOT NULL DEFAULT 0,
    ADD CONSTRAINT model_usage_bound_tokens_check CHECK (bound_tokens >= 0);
