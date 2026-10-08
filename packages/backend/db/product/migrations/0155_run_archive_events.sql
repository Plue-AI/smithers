-- T-FLW-07: the journal of every observed run, as the dispatcher received it
-- from the run's live host (each observation page, in order). Reads of a
-- sleeping branch page it as the host's run-events projection did.
CREATE TABLE run_archive_events (
    repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    workspace_id text NOT NULL CHECK (workspace_id <> ''),
    run_id text NOT NULL CHECK (run_id <> ''),
    sequence bigint NOT NULL CHECK (sequence >= 0),
    cursor_offset bigint NOT NULL DEFAULT 0 CHECK (cursor_offset >= 0),
    event jsonb NOT NULL,
    PRIMARY KEY (repository_id, workspace_id, run_id, sequence, cursor_offset)
);
