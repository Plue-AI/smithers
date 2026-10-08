-- Inspection leases and revision fences belong to the retained native monitor.
ALTER TABLE run_archives ADD COLUMN inspection_until timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z';
ALTER TABLE run_archives ADD COLUMN summary_revision bigint NOT NULL DEFAULT 1 CHECK (summary_revision>0);
ALTER TABLE run_archives ADD COLUMN summary_captured_revision bigint NOT NULL DEFAULT 1 CHECK (summary_captured_revision>0);
