-- Shared model text is scoped to the run attempt and deterministic monitor target.
-- Runtime run ids are opaque text; workflow_runs is a distinct host-job identity.
CREATE TABLE run_summaries (
 run_id text NOT NULL CHECK (length(run_id) > 0),
 attempt bigint NOT NULL CHECK (attempt > 0),
 target text NOT NULL CHECK (target ~ '^(phase|cell):[0-9]+$'),
 text text NOT NULL,
 rev bigint NOT NULL CHECK (rev >= 0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (run_id, attempt, target)
);
