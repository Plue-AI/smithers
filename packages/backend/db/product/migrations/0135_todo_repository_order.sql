-- Order the existing TODO source facts across items. Existing per-item cursors
-- and persisted facts remain unchanged; no transport event/cursor table.
ALTER TABLE product_job_events ADD COLUMN repository_sequence bigint;
ALTER TABLE product_job_events ADD CONSTRAINT todo_repository_sequence_positive CHECK(repository_sequence IS NULL OR repository_sequence>0);
CREATE UNIQUE INDEX product_job_events_repository_order ON product_job_events(tenant_id,repository_sequence) WHERE repository_sequence IS NOT NULL;
