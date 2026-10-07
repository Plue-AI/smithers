-- T-APP-07: optional model summaries over the monitor provider's own phases.
-- No run, phase, event, admission or durable cursor projection is duplicated.
CREATE TABLE run_summaries (
    run_id text NOT NULL CHECK (length(run_id)>0),
    attempt bigint NOT NULL CHECK (attempt>0),
    target text NOT NULL CHECK (target ~ '^(phase|cell):[0-9]+$'),
    text text NOT NULL DEFAULT '',
    rev bigint NOT NULL DEFAULT 0 CHECK (rev>=0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    pending_since timestamptz,
    pending_key uuid,
    PRIMARY KEY (run_id, attempt, target)
);
