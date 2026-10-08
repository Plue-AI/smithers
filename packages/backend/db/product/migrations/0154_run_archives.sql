-- T-FLW-07: a run stays readable after its branch machine stops. While the
-- coding host is live, the dispatcher retains that host's own answers for the
-- run (its summary and tree rows and its monitor, journal included) at each lifecycle
-- change; reads of a sleeping branch serve them and never wake the machine.
CREATE TABLE run_archives (
    repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    workspace_id text NOT NULL CHECK (workspace_id <> ''),
    run_id text NOT NULL CHECK (run_id <> ''),
    flow_id text NOT NULL CHECK (flow_id <> ''),
    status text NOT NULL CHECK (status <> ''),
    summary jsonb NOT NULL,
    tree jsonb NOT NULL,
    monitor jsonb NOT NULL,
    captured_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (repository_id, workspace_id, run_id)
);
