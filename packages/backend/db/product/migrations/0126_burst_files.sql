-- Host change-event indexes. Metadata remains in product_job_events.
CREATE TABLE machine_event_receipts (
 branch_id UUID NOT NULL REFERENCES workspaces(id),
 event_id UUID NOT NULL,
 seq BIGINT NOT NULL CHECK (seq > 0),
 committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (branch_id, event_id)
);
CREATE TABLE burst_files (
 branch_id UUID NOT NULL REFERENCES workspaces(id),
 burst_id UUID NOT NULL,
 path TEXT NOT NULL CHECK (path <> ''),
 change TEXT NOT NULL CHECK (change IN ('added','modified','deleted','renamed')),
 renamed_to TEXT,
 before_blob TEXT CHECK (before_blob ~ '^[0-9a-f]{40}$'),
 after_blob TEXT CHECK (after_blob ~ '^[0-9a-f]{40}$'),
 after_digest TEXT CHECK (after_digest ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY (branch_id, burst_id, path),
 CHECK ((change = 'renamed') = (renamed_to IS NOT NULL)),
 CHECK ((after_blob IS NULL) = (after_digest IS NULL)),
 CHECK (before_blob IS NOT NULL OR after_blob IS NOT NULL)
);
CREATE INDEX burst_files_path ON burst_files(branch_id, path, burst_id);
