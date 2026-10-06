-- Working-together I6: file versions belong to the canonical activity event.
CREATE TABLE burst_files (
    event_id UUID NOT NULL REFERENCES product_job_events(event_id) ON DELETE CASCADE,
    path TEXT NOT NULL CHECK (path <> ''),
    change TEXT NOT NULL CHECK (change IN ('added', 'modified', 'deleted', 'renamed')),
    before_blob TEXT,
    after_blob TEXT,
    post_digest TEXT,
    renamed_to TEXT,
    PRIMARY KEY (event_id, path)
);

-- Independent of activity retention: pruning a job event must not permit an
-- already acknowledged machine event to run again. The ingest transaction
-- claims this key before writing activity; replay reads the stored outcome.
CREATE TABLE machine_event_receipts (
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    event_id UUID NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome <> ''),
    at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (workspace_id, event_id)
);
